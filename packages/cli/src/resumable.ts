import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

/**
 * Client for Immich's tus 1.0.0 resumable upload API.
 * See docs/docs/developer/resumable-upload.md for the protocol.
 *
 * Chunking is what gets a large file past a reverse proxy that caps request bodies (Cloudflare's
 * limit is 100MB), and resuming is what stops a dropped connection from costing the whole transfer.
 */

const TUS_VERSION = '1.0.0';
const OFFSET_CONTENT_TYPE = 'application/offset+octet-stream';

/** Comfortably below Cloudflare's 100MB request cap. */
export const CHUNK_SIZE = 16 * 1024 * 1024;

/** Resumable uploads only pay off once a file is bigger than a single chunk. */
export const shouldUseResumableUpload = (size: number) => size > CHUNK_SIZE;

/** tus `Upload-Metadata`: comma separated `key <base64(value)>` pairs. */
export const encodeMetadata = (metadata: Record<string, string | undefined>) =>
  Object.entries(metadata)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(',');

export type ResumableUploadOptions = {
  baseUrl: string;
  headers: Record<string, string>;
  filepath: string;
  size: number;
  filename: string;
  /** Hex sha1 of the whole file: verified server-side, and enables the duplicate short-circuit. */
  checksum: string;
  metadata: Record<string, string | undefined>;
  /** Optional XMP sidecar, sent in one request and attached when the upload completes. */
  sidecarPath?: string;
  chunkSize?: number;
};

/**
 * Upload a file in chunks.
 *
 * Returns undefined when the server has no resumable upload API, so the caller can fall back to
 * the single-request endpoint. Attempting the creation request is the capability probe: a
 * dedicated OPTIONS probe is answered by CORS middleware on dev servers before it reaches the route.
 */
export const resumableUpload = async (options: ResumableUploadOptions): Promise<unknown | undefined> => {
  const { baseUrl, headers, filepath, size, filename, checksum, metadata } = options;

  const created = await fetch(`${baseUrl}/assets/upload`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      ...headers,
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(size),
      'Upload-Metadata': encodeMetadata({ ...metadata, filename }),
      'x-immich-checksum': checksum,
    },
  });

  if (created.status === 404 || created.status === 405) {
    return undefined;
  }

  // the server recognised the checksum, so nothing needs uploading at all
  if (created.status === 200) {
    return created.json();
  }

  const location = created.headers.get('location');
  if (created.status !== 201 || !location) {
    throw new Error(`Unable to start a resumable upload: ${created.status} ${await created.text()}`);
  }

  const url = new URL(location, baseUrl).href;

  if (options.sidecarPath) {
    // small enough for one request; the server attaches it at completion
    const sidecar = await readFile(options.sidecarPath);
    const response = await fetch(`${url}/sidecar`, {
      method: 'PUT',
      redirect: 'error',
      headers: { ...headers, 'Tus-Resumable': TUS_VERSION, 'Content-Type': 'application/xml' },
      body: new Uint8Array(sidecar),
    });

    if (!response.ok) {
      throw new Error(`Unable to attach sidecar: ${response.status} ${await response.text()}`);
    }
  }

  let offset = 0;

  while (offset < size) {
    const end = Math.min(offset + (options.chunkSize ?? CHUNK_SIZE), size);
    const response = await fetch(url, {
      method: 'PATCH',
      redirect: 'error',
      headers: {
        ...headers,
        'Tus-Resumable': TUS_VERSION,
        'Upload-Offset': String(offset),
        'Content-Type': OFFSET_CONTENT_TYPE,
        'Content-Length': String(end - offset),
      },
      // a ranged read, so the whole file is never held in memory
      body: Readable.toWeb(createReadStream(filepath, { start: offset, end: end - 1 })) as ReadableStream,
      duplex: 'half',
    } as RequestInit);

    // the server is the authority on the offset; a 409 carries the real one so we can resume
    if (response.status === 409) {
      const authoritative = Number(response.headers.get('upload-offset'));
      if (!Number.isSafeInteger(authoritative) || authoritative === offset) {
        throw new Error('Resumable upload stalled: server offset did not advance');
      }
      offset = authoritative;
      continue;
    }

    if (response.status === 200 || response.status === 201) {
      return response.json();
    }

    if (response.status !== 204) {
      throw new Error(`Resumable upload failed: ${response.status} ${await response.text()}`);
    }

    offset = Number(response.headers.get('upload-offset') ?? end);
  }

  throw new Error('Resumable upload finished without a response from the server');
};
