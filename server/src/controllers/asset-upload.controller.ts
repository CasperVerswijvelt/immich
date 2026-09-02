import {
  BadRequestException,
  Controller,
  Delete,
  Head,
  HttpCode,
  HttpStatus,
  Options,
  Param,
  Patch,
  Post,
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
import { AssetUploadService, UploadOffsetConflict } from 'src/services/asset-upload.service';
import { getHeader, parseNonNegativeInt, parseUploadMetadata, TUS_EXTENSIONS, TUS_VERSION } from 'src/utils/tus';

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
    const uploadLength = parseNonNegativeInt(req.headers['upload-length']);
    if (uploadLength === undefined || uploadLength === 0) {
      throw new BadRequestException('Upload-Length must be a positive integer');
    }

    const checksum = getHeader(req.headers, ImmichHeader.Checksum);
    if (!checksum) {
      throw new BadRequestException(`${ImmichHeader.Checksum} is required for resumable uploads`);
    }

    const metadata = parseUploadMetadata(getHeader(req.headers, 'upload-metadata'));
    if (!metadata) {
      throw new BadRequestException('Upload-Metadata is malformed');
    }

    const { id, expiresAt } = await this.service.create(auth, uploadLength, checksum, metadata);

    res.set({
      'Tus-Resumable': TUS_VERSION,
      Location: `${req.baseUrl}/${id}`,
      'Upload-Expires': expiresAt,
    });
  }

  @Head(':id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  async status(@Auth() auth: AuthDto, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { offset, session } = await this.service.getState(auth, id);

    res.set({
      'Tus-Resumable': TUS_VERSION,
      'Upload-Offset': String(offset),
      'Upload-Length': String(session.uploadLength),
      'Upload-Expires': session.expiresAt,
      'Cache-Control': 'no-store',
    });
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  async append(
    @Auth() auth: AuthDto,
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.headers['content-type'] !== 'application/offset+octet-stream') {
      throw new BadRequestException('Content-Type must be application/offset+octet-stream');
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

  @Delete(':id')
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async terminate(@Auth() auth: AuthDto, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    await this.service.delete(auth, id);
    res.set({ 'Tus-Resumable': TUS_VERSION });
  }
}
