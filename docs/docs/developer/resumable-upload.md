# Resumable Uploads

Immich accepts asset uploads over the [tus 1.0.0](https://tus.io/protocols/resumable-upload)
resumable upload protocol, in addition to the single-request `POST /api/assets` endpoint. Chunked
uploads get large files past reverse proxies that cap request bodies (Cloudflare's limit is 100 MB)
and let an interrupted transfer resume instead of restarting.

The single-request endpoint is unchanged and is not deprecated. Clients should use it for small
files and fall back to it whenever the resumable endpoints are unavailable.

## Endpoints

All endpoints require the `asset.upload` permission and accept shared-link authentication via the
usual `key`/`slug` query parameters.

| Method    | Path                              | Purpose                                |
| --------- | --------------------------------- | -------------------------------------- |
| `OPTIONS` | `/api/assets/upload`              | Protocol discovery                     |
| `POST`    | `/api/assets/upload`              | Create an upload session               |
| `HEAD`    | `/api/assets/upload/{id}`         | Current offset, for resuming           |
| `PATCH`   | `/api/assets/upload/{id}`         | Append bytes at an offset              |
| `PUT`     | `/api/assets/upload/{id}/sidecar` | Attach an XMP sidecar                  |
| `DELETE`  | `/api/assets/upload/{id}`         | Abandon a session and delete its bytes |

Supported extensions: `creation`, `expiration`, `termination`. Sessions expire after 7 days.

These endpoints are intentionally absent from the OpenAPI specification, and therefore from the
generated TypeScript and Dart SDKs. A generated wrapper cannot express "send a raw body at a byte
offset with custom request headers and read custom response headers", so clients implement the
protocol directly against this document.

## Flow

### 1. Create a session

```http
POST /api/assets/upload
Tus-Resumable: 1.0.0
Upload-Length: 4294967296
Upload-Metadata: filename SU1HXzEyMzQubW92,fileCreatedAt MjAyNi0wMS0wMVQwMDowMDowMC4wMDBa
x-immich-checksum: 2fd4e1c67a2d28fced849ee1bb76e7391b93eb12
```

`x-immich-checksum` is **required** and must be the SHA-1 of the complete file, hex or base64
encoded. It is verified against the assembled file before the asset is created, and it lets the
server recognise a file it already has. It is also validated at creation, so a value that does not
decode to a 20-byte digest is rejected before any bytes are sent.

`Upload-Metadata` is validated at creation too, rather than when the upload completes — a bad
`fileCreatedAt` would otherwise cost a full upload to discover.

- `201 Created` — the response carries `Location` (the session URL to use for every later request)
  and `Upload-Expires`.
- `200 OK` with an `AssetMediaResponseDto` body — the server already has an asset with this
  checksum. **No bytes need to be uploaded at all.** Treat it exactly like a duplicate response
  from `POST /api/assets`.
- `400` — missing or malformed `Upload-Length`, `x-immich-checksum` or `Upload-Metadata`, an
  unsupported file type, or an upload that would exceed the user's storage quota.
- `412` — the `Tus-Resumable` header names a version the server does not implement.

`Upload-Metadata` is a comma-separated list of `key <base64(value)>` pairs. Keys map one-to-one onto
the fields of `AssetMediaCreateDto`, and every value is a string, exactly as it would be in a
multipart form body:

| Key                | Required | Notes                                                    |
| ------------------ | -------- | -------------------------------------------------------- |
| `filename`         | yes      | Drives the stored extension and the file-type check      |
| `fileCreatedAt`    | yes      | ISO 8601                                                 |
| `fileModifiedAt`   | yes      | ISO 8601                                                 |
| `isFavorite`       | no       | `"true"` / `"false"`                                     |
| `visibility`       | no       | `AssetVisibility` value                                  |
| `duration`         | no       | Milliseconds                                             |
| `livePhotoVideoId` | no       | Upload the video part first, then pass its asset id here |
| `metadata`         | no       | JSON string, as in the multipart endpoint                |

Metadata is validated when the upload completes, not when the session is created, so a bad value
surfaces as a `400` on the final `PATCH`.

### 2. Send the bytes

```http
PATCH /api/assets/upload/{id}
Tus-Resumable: 1.0.0
Upload-Offset: 16777216
Content-Type: application/offset+octet-stream

<chunk>
```

- `204 No Content` — the chunk was stored. The response's `Upload-Offset` is the new offset and is
  authoritative; use it rather than assuming your chunk arrived whole. **Treat an offset that has
  not advanced as fatal** — see the client notes below.
- `409 Conflict` — `Upload-Offset` did not match the server's offset. The response's `Upload-Offset`
  carries the real value; resume from there. Do not retry the same offset.
- `413 Payload Too Large` — the request would have pushed the file past `Upload-Length`.
- `200 OK` / `201 Created` with an `AssetMediaResponseDto` body — see below.

Chunk size is the client's choice. 16 MiB is a good default: comfortably under Cloudflare's limit,
and small enough that a failed chunk is cheap to redo. Halving the chunk size after a failure is a
reasonable strategy on unreliable connections — and specifically after a `413`, which means the
proxy's body cap is below your chunk size.

An interrupted `PATCH` is safe. Whatever bytes reached the server are kept, so a `HEAD` afterwards
reports the true offset and the client resumes from it.

### 3. Completion

There is one deviation from the tus specification: the `PATCH` that delivers the final byte responds
`201 Created` (or `200 OK` for a duplicate) with an `AssetMediaResponseDto` JSON body, rather than
the `204` the spec prescribes. This is so clients learn the new asset id without another round trip.
Intermediate chunks still respond `204`.

```json
{ "id": "f1e2d3c4-...", "status": "created" }
```

Two failure modes are specific to completion:

- `460` — the assembled file's SHA-1 does not match `x-immich-checksum`. The session is destroyed
  and no asset is created; the client must start over.
- `400` — `Upload-Metadata` failed validation. The session is destroyed.

Once the upload completes, the asset enters the same pipeline as a single-request upload: metadata
extraction, storage template migration, thumbnail generation, and so on.

### Sidecars

```http
PUT /api/assets/upload/{id}/sidecar
Tus-Resumable: 1.0.0
Content-Type: application/xml

<x:xmpmeta>...</x:xmpmeta>
```

XMP sidecars are a few kilobytes, so they are sent in a single request rather than getting a
resumable session of their own - they never approach the request-size limits this API exists to work
around. Send it any time before the upload completes; the server attaches it to the asset at
completion. The body must be between 1 byte and 1 MB, otherwise the request is rejected.

`Upload-Metadata` is not an option for this: nginx's default header buffer is 8 KB, well below a
typical sidecar.

### Resuming

```http
HEAD /api/assets/upload/{id}
Tus-Resumable: 1.0.0
```

`200 OK` carries `Upload-Offset`, `Upload-Length` and `Upload-Expires`. A `404` means the session is
gone — expired, terminated, or never existed — and the client should create a new one. `Upload-Expires`
is enforced: a session past its expiry is discarded on the next request that touches it.

Session URLs are the natural thing to persist for resuming across restarts. Key them by the file's
SHA-1 **and the metadata** the session was created with: a session is finalized with its own stored
metadata, so resuming one created with different metadata (a different filename, or a different
visibility) would apply the wrong values to the asset.

## Notes for client authors

- **Detect support by attempting the creation request.** A `404` or `405` means the server predates
  this API; fall back to `POST /api/assets`. Probing with `OPTIONS` is less reliable for two
  reasons: development builds answer `OPTIONS` from the CORS middleware before it reaches the
  route, and unlike the spec's recommendation this endpoint requires authentication, like every
  other Immich route.
- **Sessions are scoped to the authenticated user.** An upload id belonging to someone else returns
  `404`, not `403`.
- **Quota is checked at creation** against `Upload-Length`, and again when the asset is created.
- **Stop if the offset does not advance.** The server answers `204` with the _unchanged_ offset when
  a chunk stored nothing — a body cut short, or a proxy that swallowed it. Re-sending the same chunk
  is then an infinite loop, which is the "upload appears to loop, re-sending the first chunk"
  symptom in the reverse-proxy guide. Treat a missing, non-numeric, equal or lower `Upload-Offset`
  as a hard failure rather than something to retry.
- **Report progress from the server's offsets, clamped to never decrease.** Bytes-sent counters run
  ahead of what the server has committed, so a `204` or `409` reporting a lower offset will
  otherwise make a progress bar jump backwards.
- **`DELETE` the session when a user cancels**, otherwise the partial file occupies disk until it
  expires.
- **Send a sidecar before the final chunk.** Right after creating the session is simplest.

## Server implementation

Session state lives entirely on the filesystem, next to where single-request uploads are staged:

```
<media>/upload/<userId>/ab/cd/<uuid>.<ext>.part   the bytes; the offset is this file's size
<media>/upload/<userId>/ab/cd/<uuid>.json         session metadata
<media>/upload/<userId>/ab/cd/<uuid>.xmp          sidecar, if one was attached
```

Abandoned sessions are swept from the user's tree when that user next creates one. Clients should
still `DELETE` sessions they give up on rather than relying on it.

Using the file's size as the offset is what makes an interrupted `PATCH` safe: there is no separate
record that can disagree with the file after a crash. The owning user is part of the path, so
authorization needs no lookup. See `server/src/services/asset-upload.service.ts` and
`server/src/controllers/asset-upload.controller.ts`.
