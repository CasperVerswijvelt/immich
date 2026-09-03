import 'dart:async';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart' hide Request;
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/utils/tus.dart';
import 'package:integration_test/integration_test.dart';

/// Spike for the one assumption the background chunked-upload path rests on:
/// `background_downloader` must honour a `Range` header on a binary [UploadTask] by uploading
/// only that slice of the file, and must NOT forward the header to the server.
///
/// If that holds, one tus PATCH is one native upload task and chunked uploads keep all the
/// OS-managed background behaviour. If it does not, the background path needs rethinking.
///
/// This exercises the real native plugin (Swift on iOS, Kotlin on Android) against a loopback
/// server in the test process, following the same pattern as background_sync_teardown_test.
/// The mobile integration-test CI job is disabled, so this is a local/on-device guard.
///
/// Run on a booted simulator or emulator:
///   flutter test integration_test/resumable_upload_range_test.dart
///
/// NOTE: a simulator/emulator faithfully runs the plugin's native code, so it proves the Range
/// slicing and header contract. It does NOT prove OS-managed continuation while the app is
/// suspended or killed - that still needs a physical device.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late HttpServer server;
  late String endpoint;
  final received = <_Received>[];

  setUp(() async {
    received.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    endpoint = 'http://${server.address.host}:${server.port}';

    unawaited(
      server
          .listen((request) async {
            final body = await _drain(request);
            received.add(
              _Received(
                method: request.method,
                path: request.uri.path,
                headers: {
                  for (final name in const [
                    'range',
                    'upload-offset',
                    'tus-resumable',
                    'content-type',
                    'content-length',
                    'content-disposition',
                  ])
                    name: request.headers.value(name),
                },
                body: body,
              ),
            );

            request.response.statusCode = HttpStatus.noContent;
            // deliberately capitalised: parseUploadOffset looks up a lowercase key, so this is
            // what proves the plugin lowercases response headers as assumed
            request.response.headers.set('Upload-Offset', '${body.length}');
            await request.response.close();
          })
          .asFuture<void>()
          .catchError((_) {}),
    );
  });

  tearDown(() async {
    await server.close(force: true);
  });

  /// A file whose byte at position i is (i % 251), so any slice identifies its own offset.
  Future<File> fixture(int size) async {
    final file = File('${Directory.systemTemp.path}/range-fixture-$size.bin');
    await file.writeAsBytes(List.generate(size, (i) => i % 251), flush: true);
    addTearDown(() {
      if (file.existsSync()) {
        file.deleteSync();
      }
    });
    return file;
  }

  Future<TaskStatusUpdate> enqueueAndSettle(UploadTask task) async {
    final result = await FileDownloader().upload(task);
    expect(result.status, TaskStatus.complete, reason: 'upload task did not complete: ${result.exception}');
    return result;
  }

  testWidgets('uploads only the requested byte range, and does not forward Range', (_) async {
    const total = 3000;
    const start = 1000;
    const end = 1500; // exclusive, as chunkRange reports it
    final file = await fixture(total);
    final (baseDirectory, directory, filename) = await Task.split(filePath: file.path);

    final update = await enqueueAndSettle(
      UploadTask(
        url: '$endpoint/api/assets/upload/abc',
        httpRequestMethod: 'PATCH',
        post: 'binary',
        headers: {
          'Range': rangeHeader(start, end),
          'Tus-Resumable': kTusVersion,
          'Upload-Offset': '$start',
          'Content-Disposition': '',
        },
        // both platforms overwrite the Content-Type header for binary uploads with the task's
        // mimeType (UploadTaskRunner.kt:231, BDPlugin.swift:390), so it must be set here
        mimeType: kTusOffsetContentType,
        filename: filename,
        baseDirectory: baseDirectory,
        directory: directory,
        updates: Updates.status,
      ),
    );

    expect(received, hasLength(1));
    final request = received.single;

    // the verb and the tus headers reach the server
    expect(request.method, 'PATCH');
    expect(request.path, '/api/assets/upload/abc');
    expect(request.headers['upload-offset'], '$start');
    expect(request.headers['tus-resumable'], '1.0.0');
    expect(request.headers['content-type'], 'application/offset+octet-stream');

    // THE load-bearing assertions
    expect(request.headers['range'], isNull, reason: 'Range must be consumed by the plugin, not forwarded');
    expect(request.body, hasLength(end - start), reason: 'exactly the requested slice should be uploaded');
    expect(
      request.body,
      List.generate(end - start, (i) => (start + i) % 251),
      reason: 'the uploaded bytes should be the slice at the requested offset',
    );

    // the background chain reads the next offset out of these headers, so the lowercase lookup
    // parseUploadOffset performs has to match what the plugin actually surfaces
    expect(
      parseUploadOffset(update.responseHeaders),
      end - start,
      reason: 'response headers must reach Dart lowercased',
    );
  });

  testWidgets('an open-ended range uploads to the end of the file', (_) async {
    const total = 2000;
    const start = 1600;
    final file = await fixture(total);
    final (baseDirectory, directory, filename) = await Task.split(filePath: file.path);

    await enqueueAndSettle(
      UploadTask(
        url: '$endpoint/api/assets/upload/tail',
        httpRequestMethod: 'PATCH',
        post: 'binary',
        headers: {'Range': 'bytes=$start-', 'Upload-Offset': '$start', 'Content-Disposition': ''},
        filename: filename,
        baseDirectory: baseDirectory,
        directory: directory,
        updates: Updates.status,
      ),
    );

    expect(received.single.body, hasLength(total - start));
    expect(received.single.headers['range'], isNull);
  });

  testWidgets('a chunk plan covers a file contiguously across successive tasks', (_) async {
    // walks a file the way BackgroundUploadService chains chunks, with a chunk size small
    // enough to need several passes
    const total = 5000;
    const chunkSize = 2048;
    final file = await fixture(total);
    final (baseDirectory, directory, filename) = await Task.split(filePath: file.path);

    var offset = 0;
    var index = 0;
    while (offset < total) {
      final range = chunkRange(offset, total, chunkSize: chunkSize);
      final update = await enqueueAndSettle(
        UploadTask(
          taskId: 'chunk-$index',
          url: '$endpoint/api/assets/upload/chained',
          httpRequestMethod: 'PATCH',
          post: 'binary',
          headers: {
            'Range': rangeHeader(range.start, range.end),
            'Upload-Offset': '${range.start}',
            'Content-Disposition': '',
          },
          filename: filename,
          baseDirectory: baseDirectory,
          directory: directory,
          updates: Updates.status,
        ),
      );

      // the server is the authority on the next offset, read from the real response
      offset = parseUploadOffset(update.responseHeaders) ?? range.end;
      index++;
    }

    expect(received, hasLength(3)); // 2048 + 2048 + 904
    expect(received.map((r) => r.headers['upload-offset']), ['0', '2048', '4096']);
    expect(received.map((r) => r.body.length), [2048, 2048, 904]);

    // reassembled, the chunks are the original file byte for byte
    final reassembled = received.expand((r) => r.body).toList();
    expect(reassembled, await file.readAsBytes());
  });
}

class _Received {
  _Received({required this.method, required this.path, required this.headers, required this.body});

  final String method;
  final String path;
  final Map<String, String?> headers;
  final List<int> body;
}

Future<List<int>> _drain(HttpRequest request) async {
  final bytes = <int>[];
  await for (final chunk in request) {
    bytes.addAll(chunk);
  }
  return bytes;
}
