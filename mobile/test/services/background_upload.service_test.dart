import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:drift/drift.dart' hide isNotNull, isNull;
import 'package:drift/native.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/data/db/main/database.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:immich_mobile/services/background_upload.service.dart';
import 'package:immich_mobile/utils/tus.dart';
import 'package:mocktail/mocktail.dart';

import '../fixtures/asset.stub.dart';
import '../infrastructure/repository.mock.dart';
import '../mocks/asset_entity.mock.dart';
import '../repository.mocks.dart';

void main() {
  late BackgroundUploadService sut;
  late MockUploadRepository mockUploadRepository;
  late MockStorageRepository mockStorageRepository;
  late MockLocalAssetRepository mockLocalAssetRepository;
  late MockBackupRepository mockBackupRepository;
  late MockAssetMediaRepository mockAssetMediaRepository;
  late Drift db;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async => 'test',
    );
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: StoreRepository(db));
    await SettingsRepository.ensureInitialized(db);

    await Store.put(StoreKey.serverEndpoint, 'http://test-server.com');
    await Store.put(StoreKey.deviceId, 'test-device-id');
    registerFallbackValue(Uri.parse('http://test-server.com'));
  });

  setUp(() {
    mockUploadRepository = MockUploadRepository();
    mockStorageRepository = MockStorageRepository();
    mockLocalAssetRepository = MockLocalAssetRepository();
    mockBackupRepository = MockBackupRepository();
    mockAssetMediaRepository = MockAssetMediaRepository();

    sut = BackgroundUploadService(
      mockUploadRepository,
      mockStorageRepository,
      mockLocalAssetRepository,
      mockBackupRepository,
      mockAssetMediaRepository,
    );

    mockUploadRepository.onUploadStatus = (_) {};
    mockUploadRepository.onTaskProgress = (_) {};
  });

  tearDown(() {
    sut.dispose();
  });

  group('getUploadTask', () {
    test('should call getOriginalFilename from AssetMediaRepository for regular photo', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/file.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'OriginalPhoto.jpg');

      final task = await sut.getUploadTask(asset);

      expect(task, isNotNull);
      expect(task!.fields['filename'], equals('OriginalPhoto.jpg'));
      verify(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).called(1);
    });

    test('should call getOriginalFilename when original filename is null', () async {
      final asset = LocalAssetStub.image2;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/file.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => null);

      final task = await sut.getUploadTask(asset);

      expect(task, isNotNull);
      expect(task!.fields['filename'], equals(asset.name));
      verify(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).called(1);
    });

    test('should call getOriginalFilename for live photo', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/file.mov');

      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getMotionFileForAsset(asset)).thenAnswer((_) async => mockFile);
      when(
        () => mockAssetMediaRepository.getOriginalFilename(asset.id),
      ).thenAnswer((_) async => 'OriginalLivePhoto.HEIC');

      final task = await sut.getUploadTask(asset);
      expect(task, isNotNull);
      // For live photos, extension should be changed to match the video file
      expect(task!.fields['filename'], equals('OriginalLivePhoto.mov'));
      expect(task.fields['visibility'], equals('hidden'));
      verify(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).called(1);
    });

    test('should not set visibility for a regular photo', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/file.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'Regular.jpg');

      final task = await sut.getUploadTask(asset);
      expect(task, isNotNull);
      expect(task!.fields.containsKey('visibility'), isFalse);
    });

    test('corrects the extension when iOS returns a rendered file for a .dng asset', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/IMG_6499.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'IMG_6499.dng');

      final task = await sut.getUploadTask(asset);
      expect(task, isNotNull);
      expect(task!.fields['filename'], equals('IMG_6499.jpg'));
    });

    test('keeps the .dng extension for a genuine RAW original', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/IMG_5210.dng');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'IMG_5210.dng');

      final task = await sut.getUploadTask(asset);
      expect(task, isNotNull);
      expect(task!.fields['filename'], equals('IMG_5210.dng'));
    });

    test('borrows the extension from the asset name for an extensionless name (DJI/Fusion)', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/DJI_0001');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'DJI_0001');

      final task = await sut.getUploadTask(asset);
      expect(task, isNotNull);
      expect(task!.fields['filename'], equals('DJI_0001.jpg'));
    });
  });

  group('getLivePhotoUploadTask', () {
    test('should call getOriginalFilename for live photo upload task', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/livephoto.heic');

      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => mockFile);
      when(
        () => mockAssetMediaRepository.getOriginalFilename(asset.id),
      ).thenAnswer((_) async => 'OriginalLivePhoto.HEIC');

      final task = await sut.getLivePhotoUploadTask(asset, 'video-id-123');

      expect(task, isNotNull);
      expect(task!.fields['filename'], equals('OriginalLivePhoto.HEIC'));
      expect(task.fields['livePhotoVideoId'], equals('video-id-123'));
      expect(task.fields.containsKey('visibility'), isFalse);
      verify(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).called(1);
    });

    test('should call getOriginalFilename when original filename is null', () async {
      final asset = LocalAssetStub.image2;
      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/fallback.heic');

      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => null);

      final task = await sut.getLivePhotoUploadTask(asset, 'video-id-456');
      expect(task, isNotNull);
      // Should fall back to asset.name when original filename is null
      expect(task!.fields['filename'], equals(asset.name));
      verify(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).called(1);
    });
  });

  group('Server Info - cloudId and eTag metadata', () {
    test('should include cloudId and eTag metadata on iOS when server version is 2.4+', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);

      final sutWithV24 = BackgroundUploadService(
        mockUploadRepository,
        mockStorageRepository,
        mockLocalAssetRepository,
        mockBackupRepository,
        mockAssetMediaRepository,
      );
      addTearDown(() => sutWithV24.dispose());

      final assetWithCloudId = LocalAsset(
        id: 'test-asset-id',
        name: 'test.jpg',
        type: AssetType.image,
        createdAt: DateTime(2025, 1, 1),
        updatedAt: DateTime(2025, 1, 2),
        cloudId: 'cloud-id-123',
        latitude: 37.7749,
        longitude: -122.4194,
        adjustmentTime: DateTime(2026, 1, 2),
        playbackStyle: AssetPlaybackStyle.image,
        isEdited: false,
      );

      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/test.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(assetWithCloudId)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(assetWithCloudId.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(assetWithCloudId.id)).thenAnswer((_) async => 'test.jpg');

      final task = await sutWithV24.getUploadTask(assetWithCloudId);

      expect(task, isNotNull);
      expect(task!.fields.containsKey('metadata'), isTrue);

      final metadata = jsonDecode(task.fields['metadata']!) as List;
      expect(metadata, hasLength(1));
      expect(metadata[0]['key'], equals('mobile-app'));
      expect(metadata[0]['value']['iCloudId'], equals('cloud-id-123'));
      expect(metadata[0]['value']['createdAt'], isNotNull);
      expect(metadata[0]['value']['adjustmentTime'], isNotNull);
      expect(metadata[0]['value']['latitude'], isNotNull);
      expect(metadata[0]['value']['longitude'], isNotNull);
    });

    test('should NOT include metadata on Android regardless of server version', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);

      final sutAndroid = BackgroundUploadService(
        mockUploadRepository,
        mockStorageRepository,
        mockLocalAssetRepository,
        mockBackupRepository,
        mockAssetMediaRepository,
      );
      addTearDown(() => sutAndroid.dispose());

      final assetWithCloudId = LocalAsset(
        id: 'test-asset-id',
        name: 'test.jpg',
        type: AssetType.image,
        createdAt: DateTime(2025, 1, 1),
        updatedAt: DateTime(2025, 1, 2),
        cloudId: 'cloud-id-123',
        latitude: 37.7749,
        longitude: -122.4194,
        playbackStyle: AssetPlaybackStyle.image,
        isEdited: false,
      );

      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/test.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(assetWithCloudId)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(assetWithCloudId.id)).thenAnswer((_) async => mockFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(assetWithCloudId.id)).thenAnswer((_) async => 'test.jpg');

      final task = await sutAndroid.getUploadTask(assetWithCloudId);

      expect(task, isNotNull);
      expect(task!.fields.containsKey('metadata'), isFalse);
    });

    test('should NOT include metadata when cloudId is null even on iOS with server 2.4+', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);

      final sutWithV24 = BackgroundUploadService(
        mockUploadRepository,
        mockStorageRepository,
        mockLocalAssetRepository,
        mockBackupRepository,
        mockAssetMediaRepository,
      );
      addTearDown(() => sutWithV24.dispose());

      final assetWithoutCloudId = LocalAsset(
        id: 'test-asset-id',
        name: 'test.jpg',
        type: AssetType.image,
        createdAt: DateTime(2025, 1, 1),
        updatedAt: DateTime(2025, 1, 2),
        cloudId: null, // No cloudId
        playbackStyle: AssetPlaybackStyle.image,
        isEdited: false,
      );

      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/test.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(assetWithoutCloudId)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(assetWithoutCloudId.id)).thenAnswer((_) async => mockFile);
      when(
        () => mockAssetMediaRepository.getOriginalFilename(assetWithoutCloudId.id),
      ).thenAnswer((_) async => 'test.jpg');

      final task = await sutWithV24.getUploadTask(assetWithoutCloudId);

      expect(task, isNotNull);
      expect(task!.fields.containsKey('metadata'), isFalse);
    });

    test('should include metadata for live photos with cloudId on iOS 2.4+', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);

      final sutWithV24 = BackgroundUploadService(
        mockUploadRepository,
        mockStorageRepository,
        mockLocalAssetRepository,
        mockBackupRepository,
        mockAssetMediaRepository,
      );
      addTearDown(() => sutWithV24.dispose());

      final assetWithCloudId = LocalAsset(
        id: 'test-livephoto-id',
        name: 'livephoto.heic',
        type: AssetType.image,
        createdAt: DateTime(2025, 1, 1),
        updatedAt: DateTime(2025, 1, 2),
        cloudId: 'cloud-id-livephoto',
        latitude: 37.7749,
        longitude: -122.4194,
        playbackStyle: AssetPlaybackStyle.image,
        isEdited: false,
      );

      final mockEntity = MockAssetEntity();
      final mockFile = File('/path/to/livephoto.heic');

      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(assetWithCloudId)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(assetWithCloudId.id)).thenAnswer((_) async => mockFile);
      when(
        () => mockAssetMediaRepository.getOriginalFilename(assetWithCloudId.id),
      ).thenAnswer((_) async => 'livephoto.heic');

      final task = await sutWithV24.getLivePhotoUploadTask(assetWithCloudId, 'video-123');

      expect(task, isNotNull);
      expect(task!.fields.containsKey('metadata'), isTrue);
      expect(task.fields['livePhotoVideoId'], equals('video-123'));
      expect(task.fields.containsKey('visibility'), isFalse);

      final metadata = jsonDecode(task.fields['metadata']!) as List;
      expect(metadata, hasLength(1));
      expect(metadata[0]['key'], equals('mobile-app'));
      expect(metadata[0]['value']['iCloudId'], equals('cloud-id-livephoto'));
    });
  });

  group('resumable uploads', () {
    /// A sparse file, so a >16MiB fixture costs no real disk or memory.
    File sparseFile(String name, int size) {
      final file = File('${Directory.systemTemp.createTempSync().path}/$name');
      final handle = file.openSync(mode: FileMode.write);
      handle.setPositionSync(size - 1);
      handle.writeByteSync(0);
      handle.closeSync();
      return file;
    }

    const large = kUploadChunkSize * 2 + 100;

    Future<UploadTask?> taskFor(LocalAsset asset, File file, {bool isLivePhoto = false}) async {
      final mockEntity = MockAssetEntity();
      when(() => mockEntity.isLivePhoto).thenReturn(isLivePhoto);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => file);
      when(() => mockStorageRepository.getMotionFileForAsset(asset)).thenAnswer((_) async => file);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'video.mp4');
      return sut.getUploadTask(asset);
    }

    final hashed = LocalAssetStub.image1.copyWith(checksum: 'Ki3hxnotKPzthJ7hu3bnORuT6xI=');

    test('sends a large hashed asset as a tus PATCH chunk', () async {
      when(
        () => mockUploadRepository.createResumableSession(
          size: any(named: 'size'),
          originalFileName: any(named: 'originalFileName'),
          checksum: any(named: 'checksum'),
          fields: any(named: 'fields'),
        ),
      ).thenAnswer((_) async => ResumableSession(url: Uri.parse('http://test-server.com/assets/upload/abc')));

      final task = await taskFor(hashed, sparseFile('video.mp4', large));

      expect(task, isNotNull);
      expect(task!.httpRequestMethod, 'PATCH');
      expect(task.post, 'binary');
      expect(task.url, 'http://test-server.com/assets/upload/abc');
      expect(task.headers['Upload-Offset'], '0');
      // must be the task's mimeType, not a header: both platforms overwrite Content-Type with
      // mimeType for binary uploads, so a header would be discarded and the chunk rejected
      expect(task.mimeType, 'application/offset+octet-stream');
      expect(task.headers.containsKey('Content-Type'), isFalse);
      // the plugin consumes Range to slice the file; it is never forwarded
      expect(task.headers['Range'], 'bytes=0-${kUploadChunkSize - 1}');

      final metadata = UploadTaskMetadata.fromJson(task.metaData);
      expect(metadata.isChunk, isTrue);
      expect(metadata.isFinalChunk, isFalse);
      expect(metadata.uploadTotal, large);
    });

    test('falls back to a single request when the server has no resumable api', () async {
      when(
        () => mockUploadRepository.createResumableSession(
          size: any(named: 'size'),
          originalFileName: any(named: 'originalFileName'),
          checksum: any(named: 'checksum'),
          fields: any(named: 'fields'),
        ),
      ).thenAnswer((_) async => null);

      final task = await taskFor(hashed, sparseFile('video.mp4', large));

      expect(task!.httpRequestMethod, 'POST');
      expect(task.fields['filename'], 'video.mp4');
    });

    test('falls back to a single request when the session cannot be created', () async {
      when(
        () => mockUploadRepository.createResumableSession(
          size: any(named: 'size'),
          originalFileName: any(named: 'originalFileName'),
          checksum: any(named: 'checksum'),
          fields: any(named: 'fields'),
        ),
      ).thenThrow(StateError('boom'));

      final task = await taskFor(hashed, sparseFile('video.mp4', large));

      expect(task!.httpRequestMethod, 'POST');
    });

    test('skips the upload entirely when the server already has the file', () async {
      when(
        () => mockUploadRepository.createResumableSession(
          size: any(named: 'size'),
          originalFileName: any(named: 'originalFileName'),
          checksum: any(named: 'checksum'),
          fields: any(named: 'fields'),
        ),
      ).thenAnswer((_) async => ResumableSession(duplicate: UploadResult.success(remoteAssetId: 'existing')));

      expect(await taskFor(hashed, sparseFile('video.mp4', large)), isNull);
    });

    test('leaves small files on the single-request path', () async {
      final task = await taskFor(hashed, sparseFile('photo.jpg', 1024));

      expect(task!.httpRequestMethod, 'POST');
      verifyNever(
        () => mockUploadRepository.createResumableSession(
          size: any(named: 'size'),
          originalFileName: any(named: 'originalFileName'),
          checksum: any(named: 'checksum'),
          fields: any(named: 'fields'),
        ),
      );
    });

    test('leaves an unhashed asset on the single-request path', () async {
      final task = await taskFor(LocalAssetStub.image1, sparseFile('video.mp4', large));

      expect(task!.httpRequestMethod, 'POST');
    });

    test('leaves live photos on the single-request path', () async {
      final task = await taskFor(hashed, sparseFile('video.mov', large), isLivePhoto: true);

      expect(task!.httpRequestMethod, 'POST');
    });

    group('chunk chaining', () {
      late File file;
      late UploadTask task;

      setUp(() async {
        file = sparseFile('video.mp4', large);
        when(() => mockUploadRepository.enqueueBackgroundAll(any())).thenAnswer((_) async => [true]);
        when(() => mockUploadRepository.terminateResumableSession(any())).thenAnswer((_) async {});

        task = await sut.buildChunkTask(
          file,
          uploadUrl: Uri.parse('http://test-server.com/assets/upload/abc'),
          offset: 0,
          total: large,
          group: 'backup',
          metadata: const UploadTaskMetadata(
            localAssetId: 'asset-1',
            isLivePhotos: false,
            livePhotoVideoId: '',
            uploadUrl: 'http://test-server.com/assets/upload/abc',
            uploadOffset: 0,
            uploadTotal: large,
          ).toJson(),
          deviceAssetId: 'asset-1',
        );
      });

      List<UploadTask> enqueued() {
        final captured = verify(() => mockUploadRepository.enqueueBackgroundAll(captureAny())).captured;
        return captured.expand((tasks) => tasks as List<UploadTask>).toList();
      }

      test('queues the next chunk at the offset the server reports', () async {
        await sut.handleTaskStatusUpdate(
          TaskStatusUpdate(task, TaskStatus.complete, null, null, {'upload-offset': '$kUploadChunkSize'}),
        );

        final next = enqueued().single;
        expect(next.headers['Upload-Offset'], '$kUploadChunkSize');
        expect(UploadTaskMetadata.fromJson(next.metaData).uploadOffset, kUploadChunkSize);
      });

      test('falls back to its own arithmetic when the server sends no offset', () async {
        await sut.handleTaskStatusUpdate(TaskStatusUpdate(task, TaskStatus.complete));

        expect(enqueued().single.headers['Upload-Offset'], '$kUploadChunkSize');
      });

      test('does not queue anything after the final chunk', () async {
        final finalTask = await sut.buildChunkTask(
          file,
          uploadUrl: Uri.parse('http://test-server.com/assets/upload/abc'),
          offset: kUploadChunkSize * 2,
          total: large,
          group: 'backup',
          metadata: const UploadTaskMetadata(
            localAssetId: 'asset-1',
            isLivePhotos: false,
            livePhotoVideoId: '',
            uploadUrl: 'http://test-server.com/assets/upload/abc',
            uploadOffset: kUploadChunkSize * 2,
            uploadTotal: large,
          ).toJson(),
          deviceAssetId: 'asset-1',
        );

        await sut.handleTaskStatusUpdate(TaskStatusUpdate(finalTask, TaskStatus.complete));

        verifyNever(() => mockUploadRepository.enqueueBackgroundAll(any()));
      });

      test('resumes from the server offset when a chunk fails with a conflict', () async {
        await sut.handleTaskStatusUpdate(
          TaskStatusUpdate(task, TaskStatus.failed, null, null, {'upload-offset': '4096'}),
        );

        expect(enqueued().single.headers['Upload-Offset'], '4096');
      });

      test('abandons the upload when a failure repeats the same offset', () async {
        await sut.handleTaskStatusUpdate(TaskStatusUpdate(task, TaskStatus.failed, null, null, {'upload-offset': '0'}));

        verifyNever(() => mockUploadRepository.enqueueBackgroundAll(any()));
        // the session must be dropped, not left occupying disk for a week
        verify(() => mockUploadRepository.terminateResumableSession(any())).called(1);
      });

      test('abandons the upload on a terminal failure with no offset to resume from', () async {
        // a 413/460/400, an expired session or a dead network carries no Upload-Offset. Leaving
        // the chain silently stopped meant the next backup run re-uploaded the asset from byte 0.
        await sut.handleTaskStatusUpdate(TaskStatusUpdate(task, TaskStatus.failed));

        verifyNever(() => mockUploadRepository.enqueueBackgroundAll(any()));
        verify(() => mockUploadRepository.terminateResumableSession(any())).called(1);
      });

      test('abandons the upload when the next chunk cannot be queued', () async {
        when(() => mockUploadRepository.enqueueBackgroundAll(any())).thenAnswer((_) async => [false]);

        await sut.handleTaskStatusUpdate(
          TaskStatusUpdate(task, TaskStatus.complete, null, null, {'upload-offset': '$kUploadChunkSize'}),
        );

        verify(() => mockUploadRepository.terminateResumableSession(any())).called(1);
      });

      test('abandons the upload when a 204 does not advance the offset', () async {
        await sut.handleTaskStatusUpdate(
          TaskStatusUpdate(task, TaskStatus.complete, null, null, {'upload-offset': '0'}),
        );

        verifyNever(() => mockUploadRepository.enqueueBackgroundAll(any()));
        verify(() => mockUploadRepository.terminateResumableSession(any())).called(1);
      });

      test('gives each queued chunk a distinct task id', () async {
        // background_downloader dedupes by taskId, so a 409 sending the chain back to an offset it
        // has already used would have its retry silently dropped
        await sut.handleTaskStatusUpdate(
          TaskStatusUpdate(task, TaskStatus.failed, null, null, {'upload-offset': '4096'}),
        );

        expect(enqueued().single.taskId, isNot(task.taskId));
      });
    });
  });
}
