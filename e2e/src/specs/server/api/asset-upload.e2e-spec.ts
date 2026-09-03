import { AssetMediaResponseDto, AssetMediaStatus, getAssetInfo, getMyUser, LoginResponseDto } from '@immich/sdk';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createUserDto } from 'src/fixtures';
import { makeRandomImage } from 'src/generators';
import { errorDto } from 'src/responses';
import { app, asBearerAuth, utils } from 'src/utils';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const hex = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex');

const metadata = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(',');

/** Session URLs come back with the `/api` prefix, which supertest's base already includes. */
const path = (location: string) => location.replace('/api', '');

const defaultMetadata = (filename = 'example.png') =>
  metadata({
    filename,
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
  });

const create = (
  accessToken: string,
  bytes: Buffer,
  options: { metadata?: string; checksum?: string; length?: number } = {},
) => {
  const builder = request(app)
    .post('/assets/upload')
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Length', String(options.length ?? bytes.length))
    .set('Upload-Metadata', options.metadata ?? defaultMetadata());

  const checksum = options.checksum ?? hex(bytes);
  return checksum === '' ? builder : builder.set('x-immich-checksum', checksum);
};

const patch = (accessToken: string, location: string, offset: number, body: Buffer) =>
  request(app)
    .patch(path(location))
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Offset', String(offset))
    .set('Content-Type', 'application/offset+octet-stream')
    .send(body);

const head = (accessToken: string, location: string) =>
  request(app).head(path(location)).set('Authorization', `Bearer ${accessToken}`).set('Tus-Resumable', '1.0.0');

/** Endpoints for the tus 1.0.0 resumable upload API. See docs/docs/developer/resumable-upload.md. */
describe('/assets/upload', () => {
  let admin: LoginResponseDto;
  let user1: LoginResponseDto;
  let user2: LoginResponseDto;
  let quotaUser: LoginResponseDto;
  let parityUsers: Record<string, LoginResponseDto>;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    [user1, user2, quotaUser] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.create('upload1')),
      utils.userSetup(admin.accessToken, createUserDto.create('upload2')),
      utils.userSetup(admin.accessToken, createUserDto.userQuota),
    ]);

    parityUsers = {
      multipart: await utils.userSetup(admin.accessToken, createUserDto.create('parity-multipart')),
      resumable: await utils.userSetup(admin.accessToken, createUserDto.create('parity-resumable')),
    };
  });

  describe('OPTIONS /assets/upload', () => {
    it('should advertise the protocol version and extensions', async () => {
      const { status, headers } = await request(app)
        .options('/assets/upload')
        .set('Authorization', `Bearer ${user1.accessToken}`);

      expect(status).toBe(204);
      expect(headers['tus-resumable']).toBe('1.0.0');
      expect(headers['tus-version']).toBe('1.0.0');
      expect(headers['tus-extension']).toBe('creation,expiration,termination');
    });
  });

  describe('POST /assets/upload', () => {
    it('should require authentication', async () => {
      const { status } = await request(app)
        .post('/assets/upload')
        .set('Upload-Length', '10')
        .set('x-immich-checksum', hex(Buffer.alloc(10)));

      expect(status).toBe(401);
    });

    it('should create a session', async () => {
      const { status, headers } = await create(user1.accessToken, makeRandomImage());

      expect(status).toBe(201);
      expect(headers.location).toMatch(/\/api\/assets\/upload\/[\da-f-]{36}$/);
      expect(Date.parse(headers['upload-expires'])).toBeGreaterThan(Date.now());
    });

    it.each([
      ['a missing Upload-Length', { header: 'Upload-Length', value: undefined }],
      ['a non-numeric Upload-Length', { header: 'Upload-Length', value: 'abc' }],
      ['a zero Upload-Length', { header: 'Upload-Length', value: '0' }],
    ])('should reject %s', async (_, { value }) => {
      const builder = request(app)
        .post('/assets/upload')
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .set('x-immich-checksum', hex(Buffer.alloc(10)))
        .set('Upload-Metadata', defaultMetadata());

      const { status } = await (value === undefined ? builder : builder.set('Upload-Length', value));

      expect(status).toBe(400);
    });

    it('should require a checksum', async () => {
      const { status } = await create(user1.accessToken, makeRandomImage(), { checksum: '' });

      expect(status).toBe(400);
    });

    it('should reject malformed metadata', async () => {
      const { status } = await create(user1.accessToken, makeRandomImage(), { metadata: 'filename a b c' });

      expect(status).toBe(400);
    });

    it('should require a filename in the metadata', async () => {
      const { status } = await create(user1.accessToken, makeRandomImage(), {
        metadata: metadata({ fileCreatedAt: new Date().toISOString() }),
      });

      expect(status).toBe(400);
    });

    it('should reject metadata that fails validation before any bytes are sent', async () => {
      const { status } = await create(user1.accessToken, makeRandomImage(), {
        metadata: metadata({ filename: 'example.png', fileCreatedAt: 'not-a-date' }),
      });

      expect(status).toBe(400);
    });

    it('should reject an unsupported file type before any bytes are sent', async () => {
      const { status } = await create(user1.accessToken, randomBytes(10), {
        metadata: defaultMetadata('notes.txt'),
      });

      expect(status).toBe(400);
    });

    it('should short-circuit a known checksum without uploading anything', async () => {
      const bytes = makeRandomImage();
      const asset = await utils.createAsset(user1.accessToken, { assetData: { bytes, filename: 'dupe.png' } });

      const { status, body } = await create(user1.accessToken, bytes);

      expect(status).toBe(200);
      expect(body).toEqual({ id: asset.id, status: AssetMediaStatus.Duplicate });
    });

    it('should reject an upload that would exceed the quota', async () => {
      const { status, body } = await create(quotaUser.accessToken, randomBytes(10), { length: 2048 });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Quota has been exceeded!'));
    });
  });

  describe('HEAD /assets/upload/:id', () => {
    it('should report a zero offset for a fresh session', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);

      const response = await head(user1.accessToken, headers.location);

      expect(response.status).toBe(200);
      expect(response.headers['upload-offset']).toBe('0');
      expect(response.headers['upload-length']).toBe(String(bytes.length));
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('should not find an unknown session', async () => {
      const { status } = await head(user1.accessToken, `/api/assets/upload/${randomUUID()}`);

      expect(status).toBe(404);
    });

    it("should not find another user's session, rather than revealing it exists", async () => {
      const { headers } = await create(user1.accessToken, makeRandomImage());

      const response = await head(user2.accessToken, headers.location);

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /assets/upload/:id', () => {
    it('should upload in chunks and return the asset on the last one', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);
      const split = Math.floor(bytes.length / 2);

      const first = await patch(user1.accessToken, headers.location, 0, bytes.subarray(0, split));
      expect(first.status).toBe(204);
      expect(first.headers['upload-offset']).toBe(String(split));

      const second = await patch(user1.accessToken, headers.location, split, bytes.subarray(split));
      expect(second.status).toBe(201);
      expect(second.body).toEqual({ id: expect.any(String), status: AssetMediaStatus.Created });

      const asset = await getAssetInfo(
        { id: (second.body as AssetMediaResponseDto).id },
        { headers: asBearerAuth(user1.accessToken) },
      );
      expect(asset.originalFileName).toBe('example.png');
      expect(asset.exifInfo?.fileSizeInByte).toBe(bytes.length);
    });

    it('should require the offset content type', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);

      const { status } = await request(app)
        .patch(path(headers.location))
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .set('Upload-Offset', '0')
        .set('Content-Type', 'application/octet-stream')
        .send(bytes);

      expect(status).toBe(400);
    });

    it('should report the authoritative offset on a conflict', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);
      const split = Math.floor(bytes.length / 2);
      await patch(user1.accessToken, headers.location, 0, bytes.subarray(0, split));

      const conflict = await patch(user1.accessToken, headers.location, 0, bytes.subarray(split));

      expect(conflict.status).toBe(409);
      expect(conflict.headers['upload-offset']).toBe(String(split));
    });

    it('should reject a chunk that would exceed the declared length', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes, { length: 10 });

      const { status } = await patch(user1.accessToken, headers.location, 0, bytes);

      expect(status).toBe(413);
    });

    it('should reject a completed upload whose bytes do not match the checksum', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes, { checksum: hex(Buffer.from('something else')) });

      const { status } = await patch(user1.accessToken, headers.location, 0, bytes);

      expect(status).toBe(460);
      const gone = await head(user1.accessToken, headers.location);
      expect(gone.status).toBe(404);
    });

    it('should report a duplicate when the bytes match an existing asset', async () => {
      const bytes = makeRandomImage();
      const existing = await utils.createAsset(user1.accessToken, { assetData: { bytes, filename: 'first.png' } });
      // a fresh session for the same bytes, created before the server knew the checksum
      const { headers } = await create(user2.accessToken, bytes);
      await utils.createAsset(user2.accessToken, { assetData: { bytes, filename: 'first.png' } });

      const { status, body } = await patch(user2.accessToken, headers.location, 0, bytes);

      expect(status).toBe(200);
      expect(body.status).toBe(AssetMediaStatus.Duplicate);
      expect(body.id).not.toBe(existing.id);
    });

    it("should not accept bytes for another user's session", async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);

      const { status } = await patch(user2.accessToken, headers.location, 0, bytes);

      expect(status).toBe(404);
    });

    it('should count the upload against the quota', async () => {
      const before = await getMyUser({ headers: asBearerAuth(quotaUser.accessToken) });
      const bytes = makeRandomImage();
      const { headers } = await create(quotaUser.accessToken, bytes);

      await patch(quotaUser.accessToken, headers.location, 0, bytes);

      const after = await getMyUser({ headers: asBearerAuth(quotaUser.accessToken) });
      expect(after.quotaUsageInBytes).toBe((before.quotaUsageInBytes ?? 0) + bytes.length);
    });
  });

  describe('PUT /assets/upload/:id/sidecar', () => {
    it('should attach a sidecar to the finished asset', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);

      const sidecar = await request(app)
        .put(`${path(headers.location)}/sidecar`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Content-Type', 'application/xml')
        .send('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
      expect(sidecar.status).toBe(204);

      const { status } = await patch(user1.accessToken, headers.location, 0, bytes);
      expect(status).toBe(201);
    });

    it('should reject a sidecar over the size cap without harming the session', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);

      const oversized = await request(app)
        .put(`${path(headers.location)}/sidecar`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .set('Content-Type', 'application/xml')
        .send(Buffer.alloc(2 * 1024 * 1024));
      expect(oversized.status).toBe(413);

      // the session survives and the upload still completes
      const state = await head(user1.accessToken, headers.location);
      expect(state.status).toBe(200);
      expect(state.headers['upload-offset']).toBe('0');
      const { status } = await patch(user1.accessToken, headers.location, 0, bytes);
      expect(status).toBe(201);
    });

    it("should not attach a sidecar to another user's session", async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);

      const { status } = await request(app)
        .put(`${path(headers.location)}/sidecar`)
        .set('Authorization', `Bearer ${user2.accessToken}`)
        .set('Content-Type', 'application/xml')
        .send('<x:xmpmeta/>');

      expect(status).toBe(404);
    });

    it('should reject an empty sidecar', async () => {
      const { headers } = await create(user1.accessToken, makeRandomImage());

      const { status } = await request(app)
        .put(`${path(headers.location)}/sidecar`)
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .set('Content-Type', 'application/xml')
        .send('');

      expect(status).toBe(400);
    });
  });

  describe('malformed ids', () => {
    it.each(['....', '%2e%2e%2f%2e%2e', 'not-a-uuid', 'aa%00bb'])(
      'should reject %s without touching the filesystem',
      async (id) => {
        // the id reaches path construction, so it is validated before any fs call
        const responses = await Promise.all([
          head(user1.accessToken, `/api/assets/upload/${id}`),
          patch(user1.accessToken, `/api/assets/upload/${id}`, 0, Buffer.from('x')),
          request(app).delete(`/assets/upload/${id}`).set('Authorization', `Bearer ${user1.accessToken}`),
        ]);

        for (const response of responses) {
          expect(response.status).toBe(400);
        }
      },
    );

    it('should not accept a prefix of a real session id', async () => {
      const { headers } = await create(user1.accessToken, makeRandomImage());
      const id = headers.location.split('/').pop() as string;

      const { status } = await head(user1.accessToken, `/api/assets/upload/${id.slice(0, 8)}`);

      expect(status).toBe(400);
      // and the real session is untouched
      const survives = await head(user1.accessToken, headers.location);
      expect(survives.status).toBe(200);
    });
  });

  describe('DELETE /assets/upload/:id', () => {
    it('should discard a session and its bytes', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);
      await patch(user1.accessToken, headers.location, 0, bytes.subarray(0, 10));

      const { status } = await request(app)
        .delete(path(headers.location))
        .set('Authorization', `Bearer ${user1.accessToken}`)
        .set('Tus-Resumable', '1.0.0');

      expect(status).toBe(204);
      const gone = await head(user1.accessToken, headers.location);
      expect(gone.status).toBe(404);
    });

    it("should not discard another user's session", async () => {
      const { headers } = await create(user1.accessToken, makeRandomImage());

      const { status } = await request(app)
        .delete(path(headers.location))
        .set('Authorization', `Bearer ${user2.accessToken}`);

      expect(status).toBe(404);
      const survives = await head(user1.accessToken, headers.location);
      expect(survives.status).toBe(200);
    });
  });

  describe('resume', () => {
    it('should resume from the offset the server reports', async () => {
      const bytes = makeRandomImage();
      const { headers } = await create(user1.accessToken, bytes);

      // a client that stopped part-way: only some of the bytes made it
      const partial = await patch(user1.accessToken, headers.location, 0, bytes.subarray(0, 20));
      expect(partial.status).toBe(204);

      // the offset is read back from the server rather than assumed, exactly as a resuming client would
      const state = await head(user1.accessToken, headers.location);
      const offset = Number(state.headers['upload-offset']);
      expect(offset).toBe(20);

      const { status, body } = await patch(user1.accessToken, headers.location, offset, bytes.subarray(offset));

      expect(status).toBe(201);
      const asset = await getAssetInfo(
        { id: (body as AssetMediaResponseDto).id },
        { headers: asBearerAuth(user1.accessToken) },
      );
      expect(asset.exifInfo?.fileSizeInByte).toBe(bytes.length);
    });
  });

  describe('parity with the multipart endpoint', () => {
    it.each([
      [
        'multipart',
        (token: string, bytes: Buffer) => utils.createAsset(token, { assetData: { bytes, filename: 'p.png' } }),
      ],
      [
        'resumable',
        (token: string, bytes: Buffer) =>
          utils.createAssetResumable(token, { assetData: { bytes, filename: 'p.png' } }, { chunkSize: 32 }),
      ],
    ])('should store byte-identical assets via %s', async (_, upload) => {
      const bytes = makeRandomImage();
      // the user is created in beforeAll: createUserDto emails are deterministic and CI retries
      // the test body, so creating it here fails with "email already in use" on every retry
      const user = parityUsers[_];

      const asset = await upload(user.accessToken, bytes);
      const info = await getAssetInfo({ id: asset.id }, { headers: asBearerAuth(user.accessToken) });

      expect(asset.status).toBe(AssetMediaStatus.Created);
      expect(info.originalFileName).toBe('p.png');
      expect(info.exifInfo?.fileSizeInByte).toBe(bytes.length);
    });
  });
});
