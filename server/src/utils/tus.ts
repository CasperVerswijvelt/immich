/**
 * Helpers for the tus 1.0.0 resumable upload protocol (https://tus.io/protocols/resumable-upload).
 *
 * Everything here is pure so it can be unit tested without an HTTP or storage harness.
 * The stateful parts live in `AssetUploadService`.
 */
import { IncomingHttpHeaders } from 'node:http';

export const TUS_VERSION = '1.0.0';
export const TUS_EXTENSIONS = ['creation', 'expiration', 'termination'] as const;

/** How long an unfinished upload survives before it can be swept. */
export const UPLOAD_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Suffix for the in-progress file. Deliberately not a supported media extension so the
 * integrity crawler (which globs `mimeTypes.getSupportedFileExtensions()`) ignores it. */
export const PART_SUFFIX = '.part';

export type TusMetadata = Record<string, string>;

/**
 * Parse a tus `Upload-Metadata` header: comma separated `key <base64value>` pairs.
 * A bare key with no value is legal per spec and maps to an empty string.
 * Returns undefined if any pair is malformed, so the caller can reject with 400.
 */
export const parseUploadMetadata = (header?: string): TusMetadata | undefined => {
  const result: TusMetadata = {};
  if (!header || header.trim() === '') {
    return result;
  }

  for (const pair of header.split(',')) {
    const parts = pair.trim().split(' ');
    if (parts.length > 2) {
      return undefined;
    }

    const [key, value] = parts;
    if (!key) {
      return undefined;
    }

    result[key] = value === undefined ? '' : Buffer.from(value, 'base64').toString('utf8');
  }

  return result;
};

/** Serialize metadata back into an `Upload-Metadata` header value. */
export const serializeUploadMetadata = (metadata: TusMetadata): string =>
  Object.entries(metadata)
    .map(([key, value]) => (value === '' ? key : `${key} ${Buffer.from(value, 'utf8').toString('base64')}`))
    .join(',');

/**
 * Parse a header that must be a non-negative integer (`Upload-Length`, `Upload-Offset`).
 * Returns undefined for anything else — including floats, negatives and `1e3`.
 */
export const parseNonNegativeInt = (value?: string | string[]): number | undefined => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export type OffsetVerdict = 'ok' | 'conflict' | 'complete';

/**
 * Decide what a PATCH may do, given the client's claimed offset and the real file size.
 * `size` is always the source of truth; `claimed` is only ever compared against it.
 */
export const validateOffset = (claimed: number, size: number, uploadLength: number): OffsetVerdict => {
  if (size >= uploadLength) {
    return 'complete';
  }
  return claimed === size ? 'ok' : 'conflict';
};

export const getHeader = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};
