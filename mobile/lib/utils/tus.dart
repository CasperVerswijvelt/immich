/// Helpers for Immich's tus 1.0.0 resumable upload API.
/// See docs/docs/developer/resumable-upload.md for the protocol.
///
/// Everything here is pure so it can be unit tested without a server; the HTTP calls live in
/// [UploadRepository] (foreground) and [BackgroundUploadService] (background).
library;

import 'dart:convert';

const String kTusVersion = '1.0.0';
const String kTusOffsetContentType = 'application/offset+octet-stream';

/// Comfortably below Cloudflare's 100MB request cap, small enough that a failed chunk is cheap.
const int kUploadChunkSize = 16 * 1024 * 1024;

/// Resumable uploads only pay off once a file is bigger than a single chunk.
bool shouldUseResumableUpload(int size) => size > kUploadChunkSize;

/// tus `Upload-Metadata`: comma separated `key <base64(value)>` pairs.
/// Null values are dropped rather than sent as bare keys.
String encodeUploadMetadata(Map<String, String?> metadata) => metadata.entries
    .where((entry) => entry.value != null)
    .map((entry) => '${entry.key} ${base64.encode(utf8.encode(entry.value!))}')
    .join(',');

/// The byte range for the chunk starting at [offset], clamped to [size].
({int start, int end}) chunkRange(int offset, int size, {int chunkSize = kUploadChunkSize}) {
  final end = offset + chunkSize;
  return (start: offset, end: end < size ? end : size);
}

/// A `Range` header for a partial binary upload. `background_downloader` consumes this itself and
/// does not forward it to the server. Inclusive of both ends, as HTTP requires.
String rangeHeader(int start, int end) => 'bytes=$start-${end - 1}';

/// Read `Upload-Offset` from a response. Header names are lowercase in both
/// `package:http` and `background_downloader`. Returns null if absent or not a non-negative integer.
int? parseUploadOffset(Map<String, String>? headers) {
  final raw = headers?['upload-offset'];
  if (raw == null) {
    return null;
  }

  final offset = int.tryParse(raw);
  return offset != null && offset >= 0 ? offset : null;
}
