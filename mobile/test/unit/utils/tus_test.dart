import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/tus.dart';

void main() {
  group('shouldUseResumableUpload', () {
    test('only kicks in above one chunk', () {
      expect(shouldUseResumableUpload(0), isFalse);
      expect(shouldUseResumableUpload(kUploadChunkSize), isFalse);
      expect(shouldUseResumableUpload(kUploadChunkSize + 1), isTrue);
    });
  });

  group('encodeUploadMetadata', () {
    test('base64 encodes values as `key <value>` pairs', () {
      expect(
        encodeUploadMetadata({'filename': 'a.jpg', 'isFavorite': 'false'}),
        'filename ${base64.encode(utf8.encode('a.jpg'))},isFavorite ${base64.encode(utf8.encode('false'))}',
      );
    });

    test('drops null values rather than sending empty keys', () {
      expect(
        encodeUploadMetadata({'filename': 'a.jpg', 'visibility': null}),
        'filename ${base64.encode(utf8.encode('a.jpg'))}',
      );
    });

    test('round-trips non-ascii filenames', () {
      final encoded = encodeUploadMetadata({'filename': 'æøå 日本語 🙂.jpg'});
      final value = encoded.split(' ')[1];
      expect(utf8.decode(base64.decode(value)), 'æøå 日本語 🙂.jpg');
    });

    test('is empty for empty metadata', () {
      expect(encodeUploadMetadata({}), '');
    });
  });

  group('chunkRange', () {
    test('clamps the final chunk to the file size', () {
      expect(chunkRange(0, 250, chunkSize: 100), (start: 0, end: 100));
      expect(chunkRange(100, 250, chunkSize: 100), (start: 100, end: 200));
      expect(chunkRange(200, 250, chunkSize: 100), (start: 200, end: 250));
    });

    test('covers a file contiguously and without overrun', () {
      const size = 1000;
      var offset = 0;
      final ranges = <({int start, int end})>[];
      while (offset < size) {
        final range = chunkRange(offset, size, chunkSize: 300);
        ranges.add(range);
        offset = range.end;
      }

      expect(ranges.first.start, 0);
      expect(ranges.last.end, size);
      for (var i = 1; i < ranges.length; i++) {
        expect(ranges[i].start, ranges[i - 1].end);
      }
    });

    test('does not exceed the size when the offset is already at the end', () {
      expect(chunkRange(250, 250, chunkSize: 100), (start: 250, end: 250));
    });
  });

  group('rangeHeader', () {
    test('is inclusive of both ends', () {
      // 50 bytes starting at 100
      expect(rangeHeader(100, 150), 'bytes=100-149');
    });

    test('handles a single byte', () {
      expect(rangeHeader(0, 1), 'bytes=0-0');
    });
  });

  group('parseUploadOffset', () {
    test('reads a lowercase header', () {
      expect(parseUploadOffset({'upload-offset': '4096'}), 4096);
    });

    test('accepts zero', () {
      expect(parseUploadOffset({'upload-offset': '0'}), 0);
    });

    test('returns null for missing, empty or invalid values', () {
      expect(parseUploadOffset(null), isNull);
      expect(parseUploadOffset({}), isNull);
      expect(parseUploadOffset({'upload-offset': ''}), isNull);
      expect(parseUploadOffset({'upload-offset': 'abc'}), isNull);
      expect(parseUploadOffset({'upload-offset': '-1'}), isNull);
      expect(parseUploadOffset({'upload-offset': '1.5'}), isNull);
    });
  });
}
