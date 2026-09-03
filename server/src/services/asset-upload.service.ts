import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import AsyncLock from 'async-lock';
import { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { dirname, join, parse } from 'node:path';
import { finished } from 'node:stream/promises';
import { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto';
import { AssetMediaCreateDto, UploadFieldName } from 'src/dtos/asset-media.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { ImmichHeader } from 'src/enum';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { AssetMediaService } from 'src/services/asset-media.service';
import { UploadRequest } from 'src/types';
import { requireUploadAccess } from 'src/utils/access';
import { fromChecksum } from 'src/utils/request';
import { PART_SUFFIX, TusMetadata, UPLOAD_EXPIRY_MS, validateOffset } from 'src/utils/tus';

/** Status code from the tus checksum extension, reused here for the whole-file digest. */
const CHECKSUM_MISMATCH = 460;

/** XMP sidecars are metadata, not media. Anything near this size is not a sidecar. */
export const SIDECAR_MAX_SIZE = 1024 * 1024;

/** A sha1 digest, so a checksum that decodes to anything else can never match. */
const SHA1_BYTES = 20;

interface UploadSession {
  uploadLength: number;
  /** Client-declared sha1 of the complete file, hex or base64. Verified at finalize. */
  checksum: string;
  expiresAt: string;
  metadata: TusMetadata;
}

interface UploadState {
  session: UploadSession;
  partPath: string;
  jsonPath: string;
  offset: number;
}

/** 409 carrying the authoritative offset, so the client can resume without re-probing. */
export class UploadOffsetConflict extends ConflictException {
  constructor(public offset: number) {
    super('Upload-Offset does not match the current offset');
  }
}

@Injectable()
export class AssetUploadService {
  // ponytail: async-lock is per-process; the finalize sha1 is what guarantees integrity across
  // replicas. Ceiling: corruption in a multi-GB upload surfaces only at the end.
  // Upgrade path: an O_EXCL <uuid>.lock file (createFile already uses flag 'wx') with
  // mtime-based stale-lock stealing.
  private lock = new AsyncLock();

  constructor(
    private assetMediaService: AssetMediaService,
    private storageRepository: StorageRepository,
    private cryptoRepository: CryptoRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(AssetUploadService.name);
  }

  /**
   * Create a session. `filename` in the metadata drives both the stored extension and the mime
   * allow-list check, so an unsupported type is rejected before a single byte is written.
   */
  async create(auth: AuthDto, uploadLength: number, checksum: string, metadata: TusMetadata) {
    const filename = metadata.filename;
    if (!filename) {
      throw new BadRequestException('Upload-Metadata must include a filename');
    }

    // Both of these are knowable now, and both cause the finished upload to be discarded, so
    // failing here saves the client a full re-upload and the server a full write plus a sha1 pass.
    if (fromChecksum(checksum).length !== SHA1_BYTES) {
      throw new BadRequestException(`${ImmichHeader.Checksum} must be a hex or base64 encoded sha1 digest`);
    }

    const metadataResult = AssetMediaCreateDto.schema.safeParse(metadata);
    if (!metadataResult.success) {
      throw new BadRequestException(formatZodIssues(metadataResult.error.issues));
    }

    const uuid = randomUUID();
    const request = this.asUploadRequest(auth, uuid, filename);

    this.assetMediaService.canUploadFile(request); // throws for unsupported types
    this.requireQuota(auth, uploadLength);

    const folder = this.assetMediaService.getUploadFolder(request);
    // `<upload>/<userId>/ab/cd` -> `<upload>/<userId>`, derived rather than recomputed so this
    // stays independent of the configured media location
    await this.sweepExpired(dirname(dirname(folder)));

    const session: UploadSession = {
      uploadLength,
      checksum,
      expiresAt: new Date(Date.now() + UPLOAD_EXPIRY_MS).toISOString(),
      metadata,
    };

    // 'wx' is an atomic exclusive create, so this doubles as the "id already taken" guard
    const partPath = join(folder, this.assetMediaService.getUploadFilename(request) + PART_SUFFIX);
    await this.storageRepository.createFile(partPath, Buffer.alloc(0));
    await this.storageRepository.createFile(join(folder, `${uuid}.json`), Buffer.from(JSON.stringify(session)));

    return { id: uuid, expiresAt: session.expiresAt };
  }

  /**
   * Load a session. The folder is derived from `auth`, never from the request, so another user's
   * upload id resolves under the caller's own folder and simply is not found.
   */
  async getState(auth: AuthDto, id: string): Promise<UploadState> {
    // getUploadFolder mkdirs as a side effect, so probing an unknown id leaves an empty directory
    // behind. Bounded (two nesting levels per user) and the same directories real uploads use, and
    // keeping this seam mockable is worth more than avoiding them.
    const folder = this.assetMediaService.getUploadFolder(this.asUploadRequest(auth, id, ''));
    const jsonPath = join(folder, `${id}.json`);

    try {
      const entries = await this.storageRepository.readdir(folder);
      const part = entries.find((entry) => entry.startsWith(id) && entry.endsWith(PART_SUFFIX));
      if (!part) {
        throw new NotFoundException();
      }

      const partPath = join(folder, part);
      const session = await this.storageRepository.readJsonFile<UploadSession>(jsonPath);
      const { size } = await this.storageRepository.stat(partPath);

      return { session, partPath, jsonPath, offset: size };
    } catch (error) {
      // A missing session is a 404, but EACCES, EIO or a truncated session file are faults worth
      // seeing in the logs rather than silently telling the client to start over.
      if (error instanceof NotFoundException || (error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException();
      }

      this.logger.warn(`Failed to load resumable upload ${id}: ${error}`);
      throw new NotFoundException();
    }
  }

  /**
   * Append one chunk. `claimedOffset` is never trusted, only compared against the real file size,
   * which is the source of truth and stays correct when a client dies mid-request.
   */
  async patch(
    auth: AuthDto,
    id: string,
    claimedOffset: number,
    req: Request,
  ): Promise<{ offset: number; asset?: AssetMediaResponseDto }> {
    return this.lock.acquire(id, async () => {
      const { session, partPath, jsonPath, offset } = await this.getState(auth, id);

      switch (validateOffset(claimedOffset, offset, session.uploadLength)) {
        // All the bytes are already on disk but the session was never finalized - e.g. a client
        // that overshot and got a 413 after the last byte landed. Finalize instead of 409ing
        // forever, otherwise the upload is stuck with nothing the client can do about it.
        case 'complete': {
          return { offset, asset: await this.finalize(auth, session, partPath, jsonPath) };
        }

        case 'conflict': {
          throw new UploadOffsetConflict(offset);
        }

        case 'ok': {
          break;
        }
      }

      await this.append(req, partPath, offset, session.uploadLength - offset, id);

      const { size } = await this.storageRepository.stat(partPath);
      if (size < session.uploadLength) {
        return { offset: size };
      }

      return { offset: size, asset: await this.finalize(auth, session, partPath, jsonPath) };
    });
  }

  async delete(auth: AuthDto, id: string) {
    // same lock as patch(): unlinking underneath an in-flight append would fail its writes
    await this.lock.acquire(id, async () => {
      const { partPath, jsonPath } = await this.getState(auth, id);
      await this.discard(partPath, jsonPath);
    });
  }

  /**
   * Attach an XMP sidecar to a session. Sidecars are a few KB, so they are written in one request
   * rather than getting a resumable session of their own; finalize picks the file up if present.
   */
  async putSidecar(auth: AuthDto, id: string, sidecar: Buffer) {
    if (sidecar.length === 0 || sidecar.length > SIDECAR_MAX_SIZE) {
      throw new BadRequestException(`Sidecar must be between 1 and ${SIDECAR_MAX_SIZE} bytes`);
    }

    // under the lock so it cannot land after finalize has already checked for it, which would
    // leave an orphaned .xmp attached to nothing
    await this.lock.acquire(id, async () => {
      const { partPath } = await this.getState(auth, id);
      await this.storageRepository.createOrOverwriteFile(sidecarPathFor(partPath), sidecar);
    });
  }

  /**
   * Pump the request body onto the end of the part file.
   *
   * Deliberately not `stream.pipeline`: when the source errors, pipeline *destroys* the
   * destination, so buffered bytes never reach disk and a dropped connection loses the whole
   * chunk. Ending the write stream gracefully instead is what makes "offset = fstat().size"
   * actually true after an interrupted PATCH.
   */
  private async append(req: Request, partPath: string, offset: number, remaining: number, id: string) {
    const destination = this.storageRepository.createAppendStream(partPath, offset);
    let written = 0;
    let tooLarge = false;

    // A bare fs stream with no 'error' listener turns any write failure - ENOSPC, EIO, or an
    // ENOENT open if the session is deleted concurrently - into an uncaughtException, which kills
    // the whole API worker rather than this one request. The error is re-thrown by finished() below.
    destination.on('error', () => {});

    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        // Content-Length is not trusted; chunked transfer-encoding bypasses it, so count real bytes
        if (written + chunk.length > remaining) {
          tooLarge = true;
          break;
        }

        written += chunk.length;
        if (!destination.write(chunk)) {
          // a destroyed stream never emits 'drain', so awaiting it here would hang holding the lock
          if (destination.errored || destination.destroyed) {
            break;
          }

          await once(destination, 'drain');
        }
      }
    } catch (error) {
      // A dropped connection is not an error: whatever we wrote is valid and the next HEAD
      // reports the true offset, so the client resumes from there.
      this.logger.debug(`Resumable upload ${id} interrupted after ${written} bytes: ${error}`);
    } finally {
      // rejects with the real write error if there was one, so a failed write is never reported
      // back as a successful offset
      await finished(destination.end());
    }

    if (tooLarge) {
      // the response is sent without reading the rest of the body, so drop the connection rather
      // than leaving Node to reset it mid-response
      req.destroy();
      throw new PayloadTooLargeException('Upload exceeds the declared Upload-Length');
    }
  }

  private async finalize(auth: AuthDto, session: UploadSession, partPath: string, jsonPath: string) {
    const checksum = await this.cryptoRepository.hashFile(partPath);
    if (!checksum.equals(fromChecksum(session.checksum))) {
      await this.discard(partPath, jsonPath);
      throw new HttpException('Checksum mismatch', CHECKSUM_MISMATCH);
    }

    // tus metadata values are plain strings, exactly like multipart form fields, so the existing
    // zod coercions (isoDatetimeToDate, stringToBool, JsonParsed) all apply unchanged
    const parsed = AssetMediaCreateDto.schema.safeParse(session.metadata);
    if (!parsed.success) {
      await this.discard(partPath, jsonPath);
      throw new BadRequestException(formatZodIssues(parsed.error.issues));
    }

    // must precede uploadAsset, which stores originalPath verbatim and derives the type from it
    const originalPath = partPath.slice(0, -PART_SUFFIX.length);
    await this.storageRepository.rename(partPath, originalPath);

    const sidecarPath = sidecarPathFor(partPath);
    const sidecar = (await this.storageRepository.checkFileExists(sidecarPath))
      ? { uuid: uuidOf(originalPath), checksum, originalPath: sidecarPath, originalName: '', size: 0 }
      : undefined;

    try {
      return await this.assetMediaService.uploadAsset(
        auth,
        parsed.data,
        {
          uuid: uuidOf(originalPath),
          checksum,
          originalPath,
          originalName: parsed.data.filename ?? session.metadata.filename,
          size: session.uploadLength,
        },
        sidecar,
      );
    } finally {
      await this.storageRepository.unlink(jsonPath);
    }
  }

  private async discard(partPath: string, jsonPath: string) {
    const sidecarPath = sidecarPathFor(partPath);
    await Promise.all([
      this.storageRepository.unlink(partPath),
      this.storageRepository.unlink(jsonPath),
      this.storageRepository.unlink(sidecarPath),
    ]);
  }

  /**
   * ponytail: cleanup is opportunistic at session creation, scoped to the creating user's tree.
   * Ceiling: a user who stops uploading forever leaves their partials behind (invisible to the
   * integrity crawler, since `.part` is not a supported extension).
   * Upgrade path when upstreaming: JobName.AssetUploadCleanup in QueueService.handleNightlyJobs,
   * guarded by a new DatabaseLock, exactly like HlsSessionCleanup.
   */
  private async sweepExpired(userFolder: string) {
    try {
      const cutoff = Date.now() - UPLOAD_EXPIRY_MS;

      // Sessions are nested two levels deep by uuid prefix, so the user's whole tree has to be
      // walked. Sweeping only the new session's own bucket would inspect 1 of 65536 directories,
      // which is what an earlier version of this did - the cleanup never actually ran.
      for (const bucket of await this.storageRepository.readdirWithTypes(userFolder)) {
        if (!bucket.isDirectory()) {
          continue;
        }

        const bucketPath = join(userFolder, bucket.name);
        for (const nested of await this.storageRepository.readdirWithTypes(bucketPath)) {
          if (!nested.isDirectory()) {
            continue;
          }

          await this.sweepFolder(join(bucketPath, nested.name), cutoff);
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to sweep expired uploads in ${userFolder}: ${error}`);
    }
  }

  private async sweepFolder(folder: string, cutoff: number) {
    for (const entry of await this.storageRepository.readdir(folder)) {
      if (!entry.endsWith(PART_SUFFIX)) {
        continue;
      }

      const partPath = join(folder, entry);
      const { mtimeMs } = await this.storageRepository.stat(partPath);
      if (mtimeMs < cutoff) {
        this.logger.debug(`Sweeping expired resumable upload ${partPath}`);
        await this.discard(partPath, join(folder, `${uuidOf(partPath.slice(0, -PART_SUFFIX.length))}.json`));
      }
    }
  }

  // ponytail: duplicates AssetMediaService.requireQuota (private) to avoid editing a hot file.
  // The authoritative check is uploadAsset's at finalize.
  private requireQuota(auth: AuthDto, size: number) {
    if (auth.user.quotaSizeInBytes !== null && auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + size) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }

  private asUploadRequest(auth: AuthDto, uuid: string, filename: string): UploadRequest {
    return {
      auth: requireUploadAccess(auth),
      fieldName: UploadFieldName.ASSET_DATA,
      file: { uuid, checksum: Buffer.alloc(0), originalPath: '', originalName: filename, size: 0 },
      body: { filename },
    };
  }
}

const uuidOf = (filepath: string) => parse(filepath).name;

const formatZodIssues = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.map(({ path, message }) => `${path.join('.')}: ${message}`);

/**
 * `<uuid>.xmp` beside the media file, matching what getUploadFilename produces for the multipart
 * endpoint - and what the storage template migration expects to move alongside the asset.
 */
const sidecarPathFor = (partPath: string) => {
  const originalPath = partPath.slice(0, -PART_SUFFIX.length);
  return join(dirname(originalPath), `${uuidOf(originalPath)}.xmp`);
};
