import { getBaseUrl, type AssetMediaResponseDto } from '@immich/sdk';

/**
 * Client for Immich's tus 1.0.0 resumable upload API (see the server's AssetUploadController).
 *
 * Chunking is what lets uploads through a reverse proxy with a request-body cap - Cloudflare's is
 * 100MB - and resumption is what stops a dropped connection from costing the whole transfer.
 *
 * Deliberately hand-rolled rather than pulling in tus-js-client: the loop below is short, and the
 * server API is documented in docs/docs/developer/resumable-upload.md.
 */

const TUS_VERSION = '1.0.0';
const OFFSET_CONTENT_TYPE = 'application/offset+octet-stream';

/** Comfortably below Cloudflare's 100MB request cap, small enough that a failed chunk is cheap. */
export const CHUNK_SIZE = 16 * 1024 * 1024;
const MIN_CHUNK_SIZE = 1024 * 1024;

/** Resumable uploads only pay off once a file is bigger than a single chunk. */
export const shouldUseResumableUpload = (size: number) => size > CHUNK_SIZE;

const storageKey = (checksum: string) => `immich:upload:${checksum}`;

type XhrResult = { status: number; body: unknown; header: (name: string) => string | null };

/**
 * Minimal XHR wrapper. The shared `uploadRequest` in $lib/utils cannot be reused: it sends no
 * request headers, types the body as FormData and exposes no response headers - tus needs all three.
 */
const request = (options: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Blob;
  signal?: AbortSignal;
  onProgress?: (loaded: number) => void;
}): Promise<XhrResult> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.addEventListener('load', () =>
      resolve({
        status: xhr.status,
        body: xhr.response,
        header: (name) => xhr.getResponseHeader(name),
      }),
    );
    xhr.addEventListener('error', () => reject(new Error(`Upload request failed: ${options.method} ${options.url}`)));
    xhr.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError')));

    if (options.onProgress) {
      xhr.upload.addEventListener('progress', (event) => options.onProgress?.(event.loaded));
    }

    xhr.open(options.method, options.url);
    xhr.responseType = 'json';
    for (const [key, value] of Object.entries(options.headers)) {
      xhr.setRequestHeader(key, value);
    }

    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(options.body);
  });

/** tus `Upload-Metadata`: comma separated `key <base64(value)>` pairs. */
const encodeMetadata = (metadata: Record<string, string | undefined>) =>
  Object.entries(metadata)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key} ${btoa(String.fromCodePoint(...new TextEncoder().encode(value)))}`)
    .join(',');

export type ResumableUploadOptions = {
  file: File;
  /** Hex sha1 of the whole file. Doubles as the resume key and is verified server-side. */
  checksum: string;
  metadata: Record<string, string | undefined>;
  queryParams?: string;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
  /** Starting chunk size. Halved on failure; mainly here so tests can drive the multi-chunk path. */
  chunkSize?: number;
};

/**
 * Upload a file in chunks, resuming a previous attempt when one is still live.
 *
 * Returns undefined when the server has no resumable upload API, so the caller can fall back to
 * the multipart endpoint. Attempting the creation request is a better capability probe than
 * OPTIONS, which the dev server's CORS middleware answers before it reaches the route.
 */
export const resumableUpload = async (options: ResumableUploadOptions): Promise<AssetMediaResponseDto | undefined> => {
  const { file, checksum, metadata, queryParams, signal, onProgress } = options;
  const search = queryParams ? `?${queryParams}` : '';

  // In-chunk progress is optimistic bytes-sent, which can run ahead of what the server commits.
  // Clamp to never regress, otherwise the progress bar jumps backwards when a 204 or 409 reports a
  // lower offset than we had already sent.
  let reported = 0;
  const report = (loaded: number) => {
    if (loaded <= reported) {
      return;
    }

    reported = loaded;
    onProgress?.(loaded, file.size);
  };

  let location = resume(checksum);
  let offset = 0;

  if (location) {
    const current = await head(location + search, signal);
    if (current === undefined) {
      forget(checksum);
      location = undefined;
    } else {
      offset = current;
    }
  }

  if (!location) {
    const created = await create({ file, checksum, metadata, search, signal });
    if (created === undefined) {
      return undefined; // server has no resumable upload API
    }
    // the server already has these bytes - no need to send any
    if ('duplicate' in created) {
      return created.duplicate;
    }

    location = created.location;
    remember(checksum, location);
  }

  let chunkSize = options.chunkSize ?? CHUNK_SIZE;
  report(offset);

  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size);

    let response: XhrResult;
    try {
      response = await request({
        method: 'PATCH',
        url: location + search,
        headers: {
          'Tus-Resumable': TUS_VERSION,
          'Upload-Offset': String(offset),
          'Content-Type': OFFSET_CONTENT_TYPE,
        },
        body: file.slice(offset, end),
        signal,
        // progress is per-chunk, so add the bytes already committed to get a whole-file figure
        onProgress: (loaded) => report(offset + loaded),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      // ponytail: halve on failure, no growth back. Ceiling: reacts to failures, not throughput.
      // Upgrade path: bandwidth-delay estimate if users report slow uploads on good links.
      if (chunkSize <= MIN_CHUNK_SIZE) {
        throw error;
      }
      chunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
      continue;
    }

    // the server is the authority on the offset; a 409 carries the real one so we can resume
    if (response.status === 409) {
      const authoritative = Number(response.header('Upload-Offset'));
      if (!Number.isSafeInteger(authoritative) || authoritative === offset) {
        throw new Error('Resumable upload stalled: server offset did not advance');
      }
      offset = authoritative;
      continue;
    }

    if (response.status === 200 || response.status === 201) {
      forget(checksum);
      report(file.size);
      return response.body as AssetMediaResponseDto;
    }

    if (response.status !== 204) {
      throw new Error(`Resumable upload failed with status ${response.status}`);
    }

    offset = Number(response.header('Upload-Offset') ?? end);
    report(offset);
  }

  throw new Error('Resumable upload finished without a response from the server');
};

/** Abandon a session server-side so its bytes are not left on disk until they expire. */
export const cancelResumableUpload = async (checksum: string, queryParams?: string) => {
  const location = resume(checksum);
  if (!location) {
    return;
  }

  forget(checksum);
  await request({
    method: 'DELETE',
    url: location + (queryParams ? `?${queryParams}` : ''),
    headers: { 'Tus-Resumable': TUS_VERSION },
  }).catch(() => undefined);
};

const create = async ({
  file,
  checksum,
  metadata,
  search,
  signal,
}: {
  file: File;
  checksum: string;
  metadata: Record<string, string | undefined>;
  search: string;
  signal?: AbortSignal;
}) => {
  const response = await request({
    method: 'POST',
    url: `${getBaseUrl()}/assets/upload${search}`,
    headers: {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(file.size),
      'Upload-Metadata': encodeMetadata({ ...metadata, filename: file.name }),
      'x-immich-checksum': checksum,
    },
    signal,
  });

  // an older server has no such route
  if (response.status === 404 || response.status === 405) {
    return undefined;
  }

  // AssetUploadInterceptor recognised the checksum, so the asset already exists
  if (response.status === 200) {
    return { duplicate: response.body as AssetMediaResponseDto };
  }

  const location = response.header('Location');
  if (response.status !== 201 || !location) {
    throw new Error(`Unable to start a resumable upload (status ${response.status})`);
  }

  return { location };
};

/** Current server-side offset, or undefined if the session is gone or expired. */
const head = async (url: string, signal?: AbortSignal) => {
  const response = await request({ method: 'HEAD', url, headers: { 'Tus-Resumable': TUS_VERSION }, signal });
  if (response.status !== 200) {
    return undefined;
  }

  const offset = Number(response.header('Upload-Offset'));
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
};

const resume = (checksum: string) => {
  try {
    return localStorage.getItem(storageKey(checksum)) ?? undefined;
  } catch {
    return undefined;
  }
};

const remember = (checksum: string, location: string) => {
  try {
    localStorage.setItem(storageKey(checksum), location);
  } catch {
    // private browsing or blocked site data: resume across reloads is a convenience, not a requirement
  }
};

const forget = (checksum: string) => {
  try {
    localStorage.removeItem(storageKey(checksum));
  } catch {
    // as above
  }
};
