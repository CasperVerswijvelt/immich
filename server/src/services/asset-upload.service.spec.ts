import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { AssetMediaService } from 'src/services/asset-media.service';
import { AssetUploadService, UploadOffsetConflict } from 'src/services/asset-upload.service';
import { TusMetadata, UPLOAD_EXPIRY_MS } from 'src/utils/tus';
import { AuthFactory } from 'test/factories/auth.factory';
import { afterEach, beforeEach, describe, expect, it, Mocked, vitest } from 'vitest';

/**
 * These exercise the real filesystem, because the whole design rests on "offset = fstat().size"
 * surviving a truncated write. Mocking storage would test nothing that matters.
 */
const metadata = (overrides: TusMetadata = {}): TusMetadata => ({
  filename: 'example.jpg',
  fileCreatedAt: '2026-01-01T00:00:00.000Z',
  fileModifiedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

/** A request-shaped readable, optionally cut short to simulate a dropped connection. */
const body = (chunk: Buffer, { truncateAfter }: { truncateAfter?: number } = {}) => {
  if (!truncateAfter) {
    return Readable.from([chunk]) as unknown as Request;
  }

  // push inside read() so the bytes are actually consumed before the socket dies
  const stream: Readable = new Readable({
    read: () => {
      stream.push(chunk.subarray(0, truncateAfter));
      stream.destroy(new Error('socket hang up'));
    },
  });
  return stream as unknown as Request;
};

/** A request that arrives as several discrete chunks. */
const chunkedBody = (...chunks: Buffer[]) => Readable.from(chunks) as unknown as Request;

describe(AssetUploadService.name, () => {
  let sut: AssetUploadService;
  let folder: string;
  let assetMediaService: Mocked<
    Pick<AssetMediaService, 'canUploadFile' | 'getUploadFolder' | 'getUploadFilename' | 'uploadAsset'>
  >;

  const auth = AuthFactory.create({ quotaSizeInBytes: null, quotaUsageInBytes: 0 });
  const payload = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');
  const checksum = createHash('sha1').update(payload).digest('hex');

  const create = (uploadLength = payload.length, digest = checksum, meta = metadata()) =>
    sut.create(auth, uploadLength, digest, meta);

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'immich-tus-'));

    const logger = new LoggingRepository(undefined, undefined);
    vitest.spyOn(logger, 'debug').mockImplementation(() => {});
    vitest.spyOn(logger, 'warn').mockImplementation(() => {});

    assetMediaService = {
      canUploadFile: vitest.fn().mockReturnValue(true),
      getUploadFolder: vitest.fn().mockReturnValue(folder),
      getUploadFilename: vitest.fn().mockImplementation(({ file }) => `${file.uuid}.jpg`),
      uploadAsset: vitest.fn().mockResolvedValue({ id: 'asset-id', status: AssetMediaStatus.CREATED }),
    };

    sut = new AssetUploadService(
      assetMediaService as unknown as AssetMediaService,
      new StorageRepository(logger),
      logger,
    );
  });

  afterEach(() => rm(folder, { recursive: true, force: true }));

  describe('create', () => {
    it('should create an empty part file and a session sidecar', async () => {
      const { id, expiresAt } = await create();

      const entries = await readdir(folder);
      expect(entries.sort()).toEqual([`${id}.jpg.part`, `${id}.json`]);
      expect(await readFile(join(folder, `${id}.jpg.part`))).toHaveLength(0);
      expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    });

    it('should reject metadata without a filename', async () => {
      await expect(create(payload.length, checksum, { fileCreatedAt: '2026-01-01T00:00:00.000Z' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject an upload that would exceed the quota before writing anything', async () => {
      const limited = AuthFactory.create({ quotaSizeInBytes: 10, quotaUsageInBytes: 8 });

      await expect(sut.create(limited, 100, checksum, metadata())).rejects.toThrow('Quota has been exceeded!');
      await expect(readdir(folder)).resolves.toEqual([]);
    });

    it('should sweep an expired session belonging to the same user', async () => {
      const { id: stale } = await create();
      const expired = new Date(Date.now() - UPLOAD_EXPIRY_MS - 1000);
      await utimes(join(folder, `${stale}.jpg.part`), expired, expired);

      const { id: fresh } = await create();

      const remaining = await readdir(folder);
      expect(remaining.sort()).toEqual([`${fresh}.jpg.part`, `${fresh}.json`]);
    });
  });

  describe('getState', () => {
    it('should report the offset from the file size', async () => {
      const { id } = await create();
      await sut.patch(auth, id, 0, body(payload.subarray(0, 10)));

      await expect(sut.getState(auth, id)).resolves.toMatchObject({ offset: 10 });
    });

    it('should not find an unknown upload', async () => {
      await expect(sut.getState(auth, 'nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('patch', () => {
    it('should append chunks in order and finalize on the last one', async () => {
      const { id } = await create();

      const first = await sut.patch(auth, id, 0, body(payload.subarray(0, 20)));
      expect(first).toEqual({ offset: 20 });

      const second = await sut.patch(auth, id, 20, body(payload.subarray(20)));
      expect(second.offset).toBe(payload.length);
      expect(second.asset).toEqual({ id: 'asset-id', status: AssetMediaStatus.CREATED });

      // the .part suffix is dropped before uploadAsset sees the path
      expect(assetMediaService.uploadAsset).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({ filename: 'example.jpg' }),
        expect.objectContaining({
          originalPath: join(folder, `${id}.jpg`),
          originalName: 'example.jpg',
          size: payload.length,
          checksum: Buffer.from(checksum, 'hex'),
        }),
      );
      await expect(readdir(folder)).resolves.toEqual([`${id}.jpg`]);
    });

    it('should conflict on a stale offset and report the authoritative one', async () => {
      const { id } = await create();
      await sut.patch(auth, id, 0, body(payload.subarray(0, 20)));

      await expect(sut.patch(auth, id, 0, body(payload.subarray(20)))).rejects.toThrow(UploadOffsetConflict);
      await expect(sut.patch(auth, id, 0, body(payload.subarray(20)))).rejects.toMatchObject({ offset: 20 });
    });

    it('should reject a chunk that would exceed the declared length', async () => {
      const { id } = await create(10);

      await expect(sut.patch(auth, id, 0, body(payload))).rejects.toMatchObject({ status: 413 });
      expect(assetMediaService.uploadAsset).not.toHaveBeenCalled();
    });

    it('should finalize rather than conflict when every byte is already on disk', async () => {
      // an overshooting client can get a 413 after the final byte landed; the upload must not
      // be left stuck at a permanent 409
      const prefix = payload.subarray(0, 20);
      const { id } = await create(20, createHash('sha1').update(prefix).digest('hex'));
      // first chunk fills the declared length exactly, the second overshoots
      await expect(
        sut.patch(auth, id, 0, chunkedBody(payload.subarray(0, 20), payload.subarray(20))),
      ).rejects.toMatchObject({ status: 413 });
      await expect(sut.getState(auth, id)).resolves.toMatchObject({ offset: 20 });
      assetMediaService.uploadAsset.mockResolvedValue({ id: 'recovered', status: AssetMediaStatus.CREATED });

      const result = await sut.patch(auth, id, 20, body(Buffer.alloc(0)));

      expect(result.asset).toEqual({ id: 'recovered', status: AssetMediaStatus.CREATED });
    });

    it('should keep flushed bytes when the connection drops mid-chunk, and resume from there', async () => {
      const { id } = await create();

      // a truncated PATCH is not an error: whatever reached disk is valid
      const interrupted = await sut.patch(auth, id, 0, body(payload, { truncateAfter: 12 }));
      expect(interrupted).toEqual({ offset: 12 });

      const resumed = await sut.patch(auth, id, 12, body(payload.subarray(12)));
      expect(resumed.asset).toEqual({ id: 'asset-id', status: AssetMediaStatus.CREATED });
      await expect(readFile(join(folder, `${id}.jpg`))).resolves.toEqual(payload);
    });

    it('should reject a completed upload whose bytes do not match the declared checksum', async () => {
      const { id } = await create(payload.length, createHash('sha1').update('something else').digest('hex'));

      await expect(sut.patch(auth, id, 0, body(payload))).rejects.toMatchObject({ status: 460 });
      expect(assetMediaService.uploadAsset).not.toHaveBeenCalled();
      await expect(readdir(folder)).resolves.toEqual([]);
    });

    it('should reject metadata that fails dto validation, after the bytes arrive', async () => {
      const { id } = await create(payload.length, checksum, { filename: 'example.jpg' });

      await expect(sut.patch(auth, id, 0, body(payload))).rejects.toThrow(BadRequestException);
      await expect(readdir(folder)).resolves.toEqual([]);
    });

    it('should accept a base64 checksum as well as hex', async () => {
      const base64 = createHash('sha1').update(payload).digest('base64');
      const { id } = await create(payload.length, base64);

      const result = await sut.patch(auth, id, 0, body(payload));
      expect(result.asset).toEqual({ id: 'asset-id', status: AssetMediaStatus.CREATED });
    });

    it('should surface a duplicate from uploadAsset unchanged', async () => {
      assetMediaService.uploadAsset.mockResolvedValue({ id: 'existing', status: AssetMediaStatus.DUPLICATE });
      const { id } = await create();

      const result = await sut.patch(auth, id, 0, body(payload));
      expect(result.asset).toEqual({ id: 'existing', status: AssetMediaStatus.DUPLICATE });
    });
  });

  describe('delete', () => {
    it('should remove both session files', async () => {
      const { id } = await create();

      await sut.delete(auth, id);

      await expect(readdir(folder)).resolves.toEqual([]);
      await expect(sut.getState(auth, id)).rejects.toThrow(NotFoundException);
    });

    it('should not find an unknown upload', async () => {
      await expect(sut.delete(auth, 'nope')).rejects.toThrow(HttpException);
    });
  });
});
