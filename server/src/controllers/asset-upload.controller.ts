import {
  BadRequestException,
  Controller,
  Delete,
  Head,
  HttpCode,
  HttpException,
  HttpStatus,
  Options,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { ImmichHeader, Permission } from 'src/enum';
import { AssetUploadInterceptor } from 'src/middleware/asset-upload.interceptor';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { AssetUploadService, SIDECAR_MAX_SIZE, UploadOffsetConflict } from 'src/services/asset-upload.service';
import { fromMaybeArray } from 'src/utils/request';
import {
  parseNonNegativeInt,
  parseUploadMetadata,
  TUS_EXTENSIONS,
  TUS_OFFSET_CONTENT_TYPE,
  TUS_VERSION,
} from 'src/utils/tus';
import { UUIDParamDto } from 'src/validation';

/**
 * Resumable uploads, tus 1.0.0 (https://tus.io/protocols/resumable-upload) with the `creation`,
 * `expiration` and `termination` extensions.
 *
 * Excluded from OpenAPI on purpose: a generated client cannot express "raw body at a byte offset
 * with custom request headers, read custom response headers", every client hand-rolls tus anyway,
 * and keeping the spec unchanged keeps the generated SDKs out of this branch's diff.
 * Documented in docs/docs/developer/resumable-upload.md instead.
 *
 * One deviation from the spec: the finishing PATCH returns 200/201 with an AssetMediaResponseDto
 * body rather than 204, so clients learn the new asset id without another round trip.
 */
@ApiExcludeController()
@Controller('assets/upload')
export class AssetUploadController {
  constructor(private service: AssetUploadService) {}

  /**
   * tus requires 412 when the client advertises a version the server does not implement. A missing
   * header is tolerated: Immich's own clients send it, but the protocol only mandates the check on
   * mismatch and being strict would break nothing useful.
   */
  private requireTusVersion(req: Request) {
    const version = fromMaybeArray(req.headers['tus-resumable']);
    if (version !== undefined && version !== TUS_VERSION) {
      throw new HttpException(`Unsupported tus version: ${version}`, HttpStatus.PRECONDITION_FAILED);
    }
  }

  @Options()
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  discover(@Res({ passthrough: true }) res: Response) {
    res.set({
      'Tus-Resumable': TUS_VERSION,
      'Tus-Version': TUS_VERSION,
      'Tus-Extension': TUS_EXTENSIONS.join(','),
    });
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @UseInterceptors(AssetUploadInterceptor)
  @HttpCode(HttpStatus.CREATED)
  async create(@Auth() auth: AuthDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.requireTusVersion(req);

    const uploadLength = parseNonNegativeInt(req.headers['upload-length']);
    if (uploadLength === undefined || uploadLength === 0) {
      throw new BadRequestException('Upload-Length must be a positive integer');
    }

    const checksum = fromMaybeArray(req.headers[ImmichHeader.Checksum]);
    if (!checksum) {
      throw new BadRequestException(`${ImmichHeader.Checksum} is required for resumable uploads`);
    }

    const metadata = parseUploadMetadata(fromMaybeArray(req.headers['upload-metadata']));
    if (!metadata) {
      throw new BadRequestException('Upload-Metadata is malformed');
    }

    const { id, expiresAt } = await this.service.create(auth, uploadLength, checksum, metadata);

    res.set({
      'Tus-Resumable': TUS_VERSION,
      // req.path, not req.baseUrl: Nest registers routes straight onto express, so there is no
      // mounted router and baseUrl is empty.
      Location: `${req.path.replace(/\/$/, '')}/${id}`,
      'Upload-Expires': new Date(expiresAt).toUTCString(),
    });
  }

  @Head(':id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  async status(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res({ passthrough: true }) res: Response) {
    const { offset, session } = await this.service.getState(auth, id);

    res.set({
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': String(offset),
      'Upload-Length': String(session.uploadLength),
      'Upload-Expires': new Date(session.expiresAt).toUTCString(),
      'Cache-Control': 'no-store',
    });
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  async append(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.requireTusVersion(req);

    if (req.headers['content-type'] !== TUS_OFFSET_CONTENT_TYPE) {
      throw new BadRequestException(`Content-Type must be ${TUS_OFFSET_CONTENT_TYPE}`);
    }

    const claimedOffset = parseNonNegativeInt(req.headers['upload-offset']);
    if (claimedOffset === undefined) {
      throw new BadRequestException('Upload-Offset must be a non-negative integer');
    }

    try {
      const { offset, asset } = await this.service.patch(auth, id, claimedOffset, req);

      res.set({ 'Tus-Resumable': TUS_VERSION, 'Upload-Offset': String(offset) });
      if (!asset) {
        res.status(HttpStatus.NO_CONTENT);
        return;
      }

      res.status(asset.status === AssetMediaStatus.DUPLICATE ? HttpStatus.OK : HttpStatus.CREATED);
      return asset;
    } catch (error) {
      if (error instanceof UploadOffsetConflict) {
        res.set({ 'Tus-Resumable': TUS_VERSION, 'Upload-Offset': String(error.offset) });
      }
      throw error;
    }
  }

  /**
   * Attach an XMP sidecar. A raw body rather than a second tus session: sidecars are a few KB, so
   * they never hit the request-size limits that resumable uploads exist to work around, and
   * Upload-Metadata is not an option (nginx's default header buffer is 8KB).
   */
  @Put(':id/sidecar')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async sidecar(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Req() req: Request) {
    this.requireTusVersion(req);

    // body-parser only skips bodies whose content type it does not handle, so a client sending
    // application/json would have its sidecar consumed before it reaches here
    const contentType = fromMaybeArray(req.headers['content-type']);
    if (contentType && /^application\/(json|x-www-form-urlencoded)/.test(contentType)) {
      throw new BadRequestException('Sidecar must not be sent as JSON or form data');
    }

    // resolve the session before buffering, so an unknown id cannot cost us a megabyte
    await this.service.getState(auth, id);
    await this.service.putSidecar(auth, id, await readBody(req, SIDECAR_MAX_SIZE));
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async terminate(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res({ passthrough: true }) res: Response) {
    await this.service.delete(auth, id);
    res.set({ 'Tus-Resumable': TUS_VERSION });
  }
}

/** Read a small raw request body, refusing anything over the limit rather than buffering it. */
const readBody = async (req: Request, limit: number) => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpException(`Body exceeds ${limit} bytes`, HttpStatus.PAYLOAD_TOO_LARGE);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};
