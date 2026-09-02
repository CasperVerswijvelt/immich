import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:drift/drift.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:mocktail/mocktail.dart';

class _MockHttpClient extends Mock implements http.Client {}

class _FakeBaseRequest extends Fake implements http.BaseRequest {}

// keeps the FileDownloader singleton off the disk and off the platform channels
class _NoStorage extends Fake implements PersistentStorage {
  @override
  Future<void> initialize() async {}
}

void main() {
  late _MockHttpClient client;
  late UploadRepository sut;
  late File file;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    FileDownloader(persistentStorage: _NoStorage());
    final db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
    await Store.put(StoreKey.serverEndpoint, 'http://demo.immich.app/api');
    registerFallbackValue(_FakeBaseRequest());
    file = File('${Directory.systemTemp.createTempSync().path}/photo.jpg')..writeAsStringSync('bytes');
  });

  setUp(() {
    client = _MockHttpClient();
    sut = UploadRepository();
  });

  // consumes the body like a real client would, so a reused request would blow up on the second send
  void stubSend(FutureOr<http.StreamedResponse> Function(int attempt) answer) {
    var attempt = 0;
    when(() => client.send(any())).thenAnswer((invocation) async {
      final request = invocation.positionalArguments.single as http.BaseRequest;
      await request.finalize().drain<void>();
      return answer(++attempt);
    });
  }

  http.StreamedResponse response(int status, String body) =>
      http.StreamedResponse(Stream.value(utf8.encode(body)), status);

  Future<UploadResult> upload() => sut.uploadFile(
    file: file,
    originalFileName: 'photo.jpg',
    fields: const {'deviceAssetId': 'a1'},
    cancelToken: null,
    logContext: 'a1',
    httpClient: client,
  );

  test('resends once when the first send dies before a response', () async {
    stubSend((attempt) {
      if (attempt == 1) {
        throw http.ClientException('Broken pipe');
      }
      return response(201, '{"id":"remote-1"}');
    });

    final result = await upload();

    expect(result.isSuccess, isTrue);
    expect(result.remoteAssetId, 'remote-1');
    verify(() => client.send(any())).called(2);
  });

  test('a second transport failure is an error, no third send', () async {
    stubSend((_) => throw http.ClientException('Connection reset'));

    final result = await upload();

    expect(result.isSuccess, isFalse);
    expect(result.isCancelled, isFalse);
    verify(() => client.send(any())).called(2);
  });

  test('a cancelled upload is not resent', () async {
    stubSend((_) => throw http.RequestAbortedException());

    final result = await upload();

    expect(result.isCancelled, isTrue);
    verify(() => client.send(any())).called(1);
  });

  test('a cancel during the resend still counts as cancelled', () async {
    stubSend((attempt) {
      if (attempt == 1) {
        throw http.ClientException('Broken pipe');
      }
      throw http.RequestAbortedException();
    });

    final result = await upload();

    expect(result.isCancelled, isTrue);
    verify(() => client.send(any())).called(2);
  });

  test('a server error response is not resent', () async {
    stubSend((_) => response(500, '{"message":"boom"}'));

    final result = await upload();

    expect(result.statusCode, 500);
    expect(result.errorMessage, 'boom');
    verify(() => client.send(any())).called(1);
  });

  group('uploadFileResumable', () {
    late File large;

    setUpAll(() {
      large = File('${Directory.systemTemp.createTempSync().path}/video.mp4')
        ..writeAsBytesSync(List.filled(1000, 0x41));
    });

    /// Records each request so the offsets actually put on the wire can be asserted.
    List<http.BaseRequest> stubExchanges(List<http.StreamedResponse> Function() replies) {
      final sent = <http.BaseRequest>[];
      final queue = replies();
      var index = 0;
      when(() => client.send(any())).thenAnswer((invocation) async {
        final request = invocation.positionalArguments.single as http.BaseRequest;
        await request.finalize().drain<void>();
        sent.add(request);
        return queue[index++];
      });
      return sent;
    }

    http.StreamedResponse headerResponse(int status, Map<String, String> headers) =>
        http.StreamedResponse(const Stream<List<int>>.empty(), status, headers: headers);

    Future<UploadResult?> resumable({int chunkSize = 400}) => sut.uploadFileResumable(
      file: large,
      originalFileName: 'video.mp4',
      checksum: 'Ki3hxnotKPzthJ7hu3bnORuT6xI=',
      fields: const {'fileCreatedAt': '2026-01-01T00:00:00.000Z'},
      cancelToken: null,
      logContext: 'a1',
      httpClient: client,
      chunkSize: chunkSize,
    );

    test('creates a session then PATCHes sequential offsets', () async {
      final sent = stubExchanges(
        () => [
          headerResponse(201, {'location': '/api/assets/upload/abc'}),
          headerResponse(204, {'upload-offset': '400'}),
          headerResponse(204, {'upload-offset': '800'}),
          response(201, '{"id":"asset-id","status":"created"}'),
        ],
      );

      final result = await resumable();

      expect(result?.isSuccess, isTrue);
      expect(result?.remoteAssetId, 'asset-id');
      expect(sent.map((request) => request.method), ['POST', 'PATCH', 'PATCH', 'PATCH']);
      expect(sent.first.headers['Upload-Length'], '1000');
      expect(sent.first.headers['x-immich-checksum'], 'Ki3hxnotKPzthJ7hu3bnORuT6xI=');
      expect(sent.first.headers['Upload-Metadata'], contains('filename ${base64.encode(utf8.encode('video.mp4'))}'));
      expect(sent.skip(1).map((request) => request.headers['Upload-Offset']), ['0', '400', '800']);
      expect(sent[1].headers['Content-Type'], 'application/offset+octet-stream');
      expect(sent.last.url.toString(), 'http://demo.immich.app/api/assets/upload/abc');
    });

    test('returns null so the caller can fall back when the route is missing', () async {
      stubExchanges(() => [headerResponse(404, {})]);

      expect(await resumable(), null);
    });

    test('skips the upload when the server already has the checksum', () async {
      final sent = stubExchanges(() => [response(200, '{"id":"existing","status":"duplicate"}')]);

      final result = await resumable();

      expect(result?.remoteAssetId, 'existing');
      expect(sent, hasLength(1));
    });

    test('adopts the offset a 409 reports', () async {
      final sent = stubExchanges(
        () => [
          headerResponse(201, {'location': '/api/assets/upload/abc'}),
          headerResponse(409, {'upload-offset': '600'}),
          response(201, '{"id":"asset-id","status":"created"}'),
        ],
      );

      final result = await resumable();

      expect(result?.isSuccess, isTrue);
      expect(sent.last.headers['Upload-Offset'], '600');
      expect(sent.last.contentLength, 400);
    });

    test('gives up rather than looping when a 409 repeats the same offset', () async {
      stubExchanges(
        () => [
          headerResponse(201, {'location': '/api/assets/upload/abc'}),
          headerResponse(409, {'upload-offset': '0'}),
        ],
      );

      final result = await resumable();

      expect(result?.isSuccess, isFalse);
      expect(result?.errorMessage, contains('did not advance'));
    });

    test('reports whole-file progress that never regresses', () async {
      stubExchanges(
        () => [
          headerResponse(201, {'location': '/api/assets/upload/abc'}),
          headerResponse(204, {'upload-offset': '400'}),
          headerResponse(204, {'upload-offset': '800'}),
          response(201, '{"id":"asset-id","status":"created"}'),
        ],
      );

      final seen = <int>[];
      await sut.uploadFileResumable(
        file: large,
        originalFileName: 'video.mp4',
        checksum: 'Ki3hxnotKPzthJ7hu3bnORuT6xI=',
        fields: const {},
        cancelToken: null,
        logContext: 'a1',
        httpClient: client,
        chunkSize: 400,
        onProgress: (bytes, total) {
          expect(total, 1000);
          seen.add(bytes);
        },
      );

      expect(seen, [400, 800, 1000]);
      expect(seen, orderedEquals(List.of(seen)..sort()));
    });

    test('surfaces a 413 with a readable message', () async {
      stubExchanges(
        () => [
          headerResponse(201, {'location': '/api/assets/upload/abc'}),
          response(413, ''),
        ],
      );

      final result = await resumable();

      expect(result?.statusCode, 413);
      expect(result?.errorMessage, contains('too large'));
    });

    test('a cancel before the session is created counts as cancelled', () async {
      when(() => client.send(any())).thenThrow(http.RequestAbortedException());

      final result = await resumable();

      expect(result?.isCancelled, isTrue);
    });
  });
}
