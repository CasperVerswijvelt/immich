import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_SIZE, encodeMetadata, resumableUpload, shouldUseResumableUpload } from 'src/resumable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import createFetchMock from 'vitest-fetch-mock';

const fetchMocker = createFetchMock(vi);
const baseUrl = 'https://immich.test/api';
const created = { id: 'asset-id', status: 'created' };

describe('shouldUseResumableUpload', () => {
  it('should only kick in above one chunk', () => {
    expect(shouldUseResumableUpload(0)).toBe(false);
    expect(shouldUseResumableUpload(CHUNK_SIZE)).toBe(false);
    expect(shouldUseResumableUpload(CHUNK_SIZE + 1)).toBe(true);
  });
});

describe('encodeMetadata', () => {
  it('should base64 encode values as `key <value>` pairs', () => {
    expect(encodeMetadata({ filename: 'a.jpg', isFavorite: 'false' })).toBe(
      `filename ${Buffer.from('a.jpg').toString('base64')},isFavorite ${Buffer.from('false').toString('base64')}`,
    );
  });

  it('should drop undefined values rather than sending empty keys', () => {
    expect(encodeMetadata({ filename: 'a.jpg', visibility: undefined })).toBe(
      `filename ${Buffer.from('a.jpg').toString('base64')}`,
    );
  });

  it('should handle non-ascii filenames', () => {
    const [, value] = encodeMetadata({ filename: 'æøå 日本語.jpg' }).split(' ', 2);
    expect(Buffer.from(value, 'base64').toString('utf8')).toBe('æøå 日本語.jpg');
  });
});

const calls = () => fetchMocker.requests().map((request) => `${request.method} ${request.url}`);

describe('resumableUpload', () => {
  let directory: string;
  let filepath: string;

  const contents = Buffer.from('0123456789'.repeat(100)); // 1000 bytes

  const upload = (overrides: Partial<Parameters<typeof resumableUpload>[0]> = {}) =>
    resumableUpload({
      baseUrl,
      headers: { 'x-api-key': 'secret' },
      filepath,
      size: contents.length,
      filename: 'video.mp4',
      checksum: 'abc123',
      metadata: { fileCreatedAt: '2026-01-01T00:00:00.000Z' },
      chunkSize: 400,
      ...overrides,
    });

  beforeEach(async () => {
    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
    directory = await mkdtemp(join(tmpdir(), 'immich-cli-tus-'));
    filepath = join(directory, 'video.mp4');
    await writeFile(filepath, contents);
  });

  afterEach(() => rm(directory, { recursive: true, force: true }));

  it('should create a session then send chunks at sequential offsets', async () => {
    fetchMocker
      .mockResponseOnce('', { status: 201, headers: { location: '/api/assets/upload/abc' } })
      .mockResponseOnce(undefined, { status: 204, headers: { 'upload-offset': '400' } })
      .mockResponseOnce(undefined, { status: 204, headers: { 'upload-offset': '800' } })
      .mockResponseOnce(JSON.stringify(created), { status: 201 });

    await expect(upload()).resolves.toEqual(created);

    expect(calls()).toEqual([
      `POST ${baseUrl}/assets/upload`,
      `PATCH ${baseUrl}/assets/upload/abc`,
      `PATCH ${baseUrl}/assets/upload/abc`,
      `PATCH ${baseUrl}/assets/upload/abc`,
    ]);

    const offsets = fetchMocker
      .requests()
      .slice(1)
      .map((request) => request.headers.get('upload-offset'));
    expect(offsets).toEqual(['0', '400', '800']);
  });

  it('should declare the length, checksum and metadata when creating', async () => {
    fetchMocker
      .mockResponseOnce('', { status: 201, headers: { location: '/api/assets/upload/abc' } })
      .mockResponseOnce(JSON.stringify(created), { status: 201 });

    await upload({ chunkSize: CHUNK_SIZE });

    const create = fetchMocker.requests()[0];
    expect(create.headers.get('upload-length')).toBe('1000');
    expect(create.headers.get('x-immich-checksum')).toBe('abc123');
    expect(create.headers.get('upload-metadata')).toContain(`filename ${Buffer.from('video.mp4').toString('base64')}`);
    expect(create.headers.get('x-api-key')).toBe('secret');
  });

  it('should skip the upload when the server already has the checksum', async () => {
    const duplicate = { id: 'existing', status: 'duplicate' };
    fetchMocker.mockResponseOnce(JSON.stringify(duplicate), { status: 200 });

    await expect(upload()).resolves.toEqual(duplicate);
    expect(calls()).toHaveLength(1);
  });

  it.each([404, 405])('should return undefined so the caller falls back on %i', async (status) => {
    fetchMocker.mockResponseOnce('', { status });

    await expect(upload()).resolves.toBeUndefined();
  });

  it('should adopt the offset a 409 reports', async () => {
    fetchMocker
      .mockResponseOnce('', { status: 201, headers: { location: '/api/assets/upload/abc' } })
      .mockResponseOnce(undefined, { status: 409, headers: { 'upload-offset': '600' } })
      .mockResponseOnce(JSON.stringify(created), { status: 201 });

    await expect(upload()).resolves.toEqual(created);
    expect(fetchMocker.requests()[2].headers.get('upload-offset')).toBe('600');
  });

  it('should give up rather than loop when a 409 repeats the same offset', async () => {
    fetchMocker
      .mockResponseOnce('', { status: 201, headers: { location: '/api/assets/upload/abc' } })
      .mockResponse(undefined, { status: 409, headers: { 'upload-offset': '0' } });

    await expect(upload()).rejects.toThrow(/did not advance/);
  });

  it('should send a sidecar before the bytes when one is given', async () => {
    const sidecarPath = join(directory, 'video.mp4.xmp');
    await writeFile(sidecarPath, '<x:xmpmeta/>');

    fetchMocker
      .mockResponseOnce('', { status: 201, headers: { location: '/api/assets/upload/abc' } })
      .mockResponseOnce(undefined, { status: 204 })
      .mockResponseOnce(JSON.stringify(created), { status: 201 });

    await expect(upload({ chunkSize: CHUNK_SIZE, sidecarPath })).resolves.toEqual(created);
    expect(calls()[1]).toBe(`PUT ${baseUrl}/assets/upload/abc/sidecar`);
  });

  it('should surface a failed chunk rather than reporting success', async () => {
    fetchMocker
      .mockResponseOnce('', { status: 201, headers: { location: '/api/assets/upload/abc' } })
      .mockResponseOnce('nope', { status: 500 });

    await expect(upload()).rejects.toThrow(/500/);
  });
});
