import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, resumableUpload, shouldUseResumableUpload } from '$lib/utils/resumable-upload';

vi.mock('@immich/sdk', () => ({ getBaseUrl: () => '/api' }));

type Exchange = {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyLength: number;
};

type Reply = { status: number; headers?: Record<string, string>; body?: unknown } | { fail: true };

/**
 * A fake XMLHttpRequest that records every exchange and replies from a scripted queue, so the
 * tests can assert the offset sequence the client actually puts on the wire.
 */
const installXhr = (replies: Reply[]) => {
  const exchanges: Exchange[] = [];
  let index = 0;

  class FakeXhr {
    upload = {
      addEventListener: (_: string, listener: (event: { loaded: number }) => void) => (this.onProgress = listener),
    };
    onProgress?: (event: { loaded: number }) => void;
    response: unknown;
    status = 0;

    private listeners: Record<string, () => void> = {};
    private headers: Record<string, string> = {};
    private replyHeaders: Record<string, string> = {};
    private method = '';
    private url = '';

    responseType = '';

    addEventListener(event: string, listener: () => void) {
      this.listeners[event] = listener;
    }

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }

    getResponseHeader(name: string) {
      return this.replyHeaders[name] ?? null;
    }

    abort() {
      this.status = 0;
      this.listeners.abort?.();
    }

    send(body?: Blob) {
      const reply = replies[index++] ?? { status: 500 };
      exchanges.push({
        method: this.method,
        url: this.url,
        headers: { ...this.headers },
        bodyLength: body?.size ?? 0,
      });

      // a transport failure fires 'error', not 'load' - the distinction the retry logic turns on
      if ('fail' in reply) {
        this.listeners.error?.();
        return;
      }

      this.status = reply.status;
      this.response = reply.body;
      this.replyHeaders = reply.headers ?? {};
      this.onProgress?.({ loaded: body?.size ?? 0 });
      this.listeners.load?.();
    }
  }

  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return exchanges;
};

const fileOf = (size: number, name = 'video.mp4') =>
  new File([new Uint8Array(size)], name, { lastModified: 0, type: 'video/mp4' });

const metadata = { fileCreatedAt: '2026-01-01T00:00:00.000Z', fileModifiedAt: '2026-01-01T00:00:00.000Z' };

/** Mirrors the module's key, which covers the metadata so a resume cannot apply the wrong one. */
const keyFor = (checksum: string, filename = 'video.mp4') =>
  `immich:upload:${checksum}:${JSON.stringify({ ...metadata, filename })}`;
const created = { id: 'asset-id', status: 'created' };

describe('shouldUseResumableUpload', () => {
  it('should only kick in above one chunk', () => {
    expect(shouldUseResumableUpload(CHUNK_SIZE)).toBe(false);
    expect(shouldUseResumableUpload(CHUNK_SIZE + 1)).toBe(true);
  });
});

describe('resumableUpload', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('should create a session then PATCH sequential offsets', async () => {
    const file = fileOf(2500);
    const exchanges = installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 204, headers: { 'Upload-Offset': '1000' } },
      { status: 204, headers: { 'Upload-Offset': '2000' } },
      { status: 201, body: created },
    ]);

    const result = await resumableUpload({ file, checksum: 'abc123', metadata, chunkSize: 1000 });

    expect(result).toEqual(created);
    expect(exchanges[0]).toMatchObject({ method: 'POST', url: '/api/assets/upload' });
    expect(exchanges[0].headers).toMatchObject({
      'Upload-Length': '2500',
      'x-immich-checksum': 'abc123',
      'Tus-Resumable': '1.0.0',
    });
    // filename is always present in the metadata, base64 encoded per the tus spec
    expect(exchanges[0].headers['Upload-Metadata']).toContain(`filename ${btoa('video.mp4')}`);
    expect(exchanges[1]).toMatchObject({ method: 'PATCH', url: '/api/assets/upload/abc', bodyLength: 1000 });
    expect(exchanges[1].headers).toMatchObject({
      'Upload-Offset': '0',
      'Content-Type': 'application/offset+octet-stream',
    });
    expect(exchanges[2].headers).toMatchObject({ 'Upload-Offset': '1000' });
    expect(exchanges[3].headers).toMatchObject({ 'Upload-Offset': '2000' });
  });

  it('should report whole-file progress monotonically across chunk boundaries', async () => {
    const file = fileOf(3000);
    installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 204, headers: { 'Upload-Offset': '1000' } },
      { status: 204, headers: { 'Upload-Offset': '2000' } },
      { status: 201, body: created },
    ]);

    const seen: number[] = [];
    await resumableUpload({
      file,
      checksum: 'abc123',
      metadata,
      chunkSize: 1000,
      onProgress: (loaded, total) => {
        expect(total).toBe(3000);
        seen.push(loaded);
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(3000);
  });

  it('should skip the upload entirely when the server already has the checksum', async () => {
    const duplicate = { id: 'existing', status: 'duplicate' };
    const exchanges = installXhr([{ status: 200, body: duplicate }]);

    const result = await resumableUpload({ file: fileOf(5000), checksum: 'abc123', metadata });

    expect(result).toEqual(duplicate);
    expect(exchanges).toHaveLength(1);
  });

  it('should fall back to multipart when the server has no resumable api', async () => {
    installXhr([{ status: 404 }]);

    await expect(resumableUpload({ file: fileOf(5000), checksum: 'abc123', metadata })).resolves.toBeUndefined();
  });

  it('should adopt the offset a 409 reports instead of stalling', async () => {
    const exchanges = installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 409, headers: { 'Upload-Offset': '400' } },
      { status: 201, body: created },
    ]);

    await expect(resumableUpload({ file: fileOf(1000), checksum: 'abc123', metadata })).resolves.toEqual(created);
    expect(exchanges[2].headers).toMatchObject({ 'Upload-Offset': '400' });
    expect(exchanges[2].bodyLength).toBe(600);
  });

  it('should give up rather than loop when a 409 repeats the same offset', async () => {
    installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 409, headers: { 'Upload-Offset': '0' } },
    ]);

    await expect(resumableUpload({ file: fileOf(1000), checksum: 'abc123', metadata })).rejects.toThrow(
      /did not advance/,
    );
  });

  it('should resume a remembered session with a HEAD instead of creating a new one', async () => {
    localStorage.setItem(keyFor('abc123'), '/api/assets/upload/abc');
    const exchanges = installXhr([
      { status: 200, headers: { 'Upload-Offset': '600' } },
      { status: 201, body: created },
    ]);

    await expect(resumableUpload({ file: fileOf(1000), checksum: 'abc123', metadata })).resolves.toEqual(created);
    expect(exchanges[0]).toMatchObject({ method: 'HEAD', url: '/api/assets/upload/abc' });
    expect(exchanges[1]).toMatchObject({ method: 'PATCH', bodyLength: 400 });
    expect(exchanges[1].headers).toMatchObject({ 'Upload-Offset': '600' });
  });

  it('should discard a remembered session the server no longer knows about', async () => {
    localStorage.setItem(keyFor('abc123'), '/api/assets/upload/gone');
    const exchanges = installXhr([
      { status: 404 },
      { status: 201, headers: { Location: '/api/assets/upload/new' } },
      { status: 201, body: created },
    ]);

    await expect(resumableUpload({ file: fileOf(1000), checksum: 'abc123', metadata })).resolves.toEqual(created);
    expect(exchanges[1]).toMatchObject({ method: 'POST' });
    expect(localStorage.getItem(keyFor('abc123'))).toBeNull();
  });

  it('should forget the session once the upload completes', async () => {
    installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 201, body: created },
    ]);

    await resumableUpload({ file: fileOf(1000), checksum: 'abc123', metadata });

    expect(localStorage.getItem(keyFor('abc123'))).toBeNull();
  });

  it('should not resume a session created with different metadata', async () => {
    // the session is finalized with the metadata it was created with, so reusing it for a
    // different visibility or filename would apply the wrong one
    localStorage.setItem(keyFor('abc123'), '/api/assets/upload/abc');
    const exchanges = installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/new' } },
      { status: 201, body: created },
    ]);

    await resumableUpload({
      file: fileOf(1000),
      checksum: 'abc123',
      metadata: { ...metadata, visibility: 'locked' },
    });

    // a fresh session, not a HEAD of the remembered one
    expect(exchanges[0].method).toBe('POST');
  });

  it('should give up rather than re-sending a chunk the server never advanced past', async () => {
    const exchanges = installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 204, headers: { 'Upload-Offset': '0' } },
    ]);

    await expect(
      resumableUpload({ file: fileOf(3000), checksum: 'abc123', metadata, chunkSize: 1000 }),
    ).rejects.toThrow(/did not advance/);
    expect(exchanges).toHaveLength(2);
  });

  it('should give up when a 204 reports a non-numeric offset', async () => {
    installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 204, headers: { 'Upload-Offset': 'banana' } },
    ]);

    await expect(
      resumableUpload({ file: fileOf(3000), checksum: 'abc123', metadata, chunkSize: 1000 }),
    ).rejects.toThrow(/did not advance/);
  });

  it('should halve the chunk size after a transport failure', async () => {
    const exchanges = installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { fail: true },
      { status: 201, body: created },
    ]);

    await expect(
      resumableUpload({ file: fileOf(3 * 1024 * 1024), checksum: 'abc123', metadata, chunkSize: 4 * 1024 * 1024 }),
    ).resolves.toEqual(created);

    // retried at the same offset with half the bytes
    expect(exchanges[2].headers['Upload-Offset']).toBe('0');
    expect(exchanges[1].bodyLength).toBe(3 * 1024 * 1024);
    expect(exchanges[2].bodyLength).toBe(2 * 1024 * 1024);
  });

  it('should halve the chunk size when a proxy rejects the chunk as too large', async () => {
    const exchanges = installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 413 },
      { status: 201, body: created },
    ]);

    await expect(
      resumableUpload({ file: fileOf(3 * 1024 * 1024), checksum: 'abc123', metadata, chunkSize: 4 * 1024 * 1024 }),
    ).resolves.toEqual(created);
    expect(exchanges[2].bodyLength).toBe(2 * 1024 * 1024);
  });

  it('should stop halving at the floor rather than looping forever', async () => {
    const exchanges = installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { fail: true },
      { fail: true },
    ]);

    await expect(
      resumableUpload({ file: fileOf(3 * 1024 * 1024), checksum: 'abc123', metadata, chunkSize: 1024 * 1024 }),
    ).rejects.toThrow();
    // create + one attempt at the floor, then it gives up
    expect(exchanges).toHaveLength(2);
  });

  it('should abort when the signal is already aborted', async () => {
    const exchanges = installXhr([{ status: 201, headers: { Location: '/api/assets/upload/abc' } }]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      resumableUpload({ file: fileOf(1000), checksum: 'abc123', metadata, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(exchanges).toHaveLength(0);
  });

  it('should not let progress regress when the server commits less than was sent', async () => {
    installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 204, headers: { 'Upload-Offset': '600' } },
      { status: 201, body: created },
    ]);

    const seen: number[] = [];
    await resumableUpload({
      file: fileOf(2000),
      checksum: 'abc123',
      metadata,
      chunkSize: 1000,
      onProgress: (loaded) => void seen.push(loaded),
    });

    // optimistically reported 1000, the server only committed 600; the bar must not go back
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(2000);
  });

  it('should append shared-link query params to every request', async () => {
    const exchanges = installXhr([
      { status: 201, headers: { Location: '/api/assets/upload/abc' } },
      { status: 201, body: created },
    ]);

    await resumableUpload({ file: fileOf(1000), checksum: 'abc123', metadata, queryParams: 'key=secret' });

    expect(exchanges[0].url).toBe('/api/assets/upload?key=secret');
    expect(exchanges[1].url).toBe('/api/assets/upload/abc?key=secret');
  });
});
