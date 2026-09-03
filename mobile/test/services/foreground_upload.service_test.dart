import 'dart:io';

import 'package:drift/drift.dart' hide isNull, isNotNull;
import 'package:drift/native.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/settings.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/repositories/upload.repository.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:immich_mobile/utils/tus.dart';
import 'package:mocktail/mocktail.dart';

import '../api.mocks.dart';
import '../fixtures/asset.stub.dart';
import '../infrastructure/repository.mock.dart';
import '../mocks/asset_entity.mock.dart';
import '../repository.mocks.dart';

void main() {
  late ForegroundUploadService sut;
  late MockUploadRepository mockUploadRepository;
  late MockStorageRepository mockStorageRepository;
  late MockDriftBackupRepository mockBackupRepository;
  late MockConnectivityApi mockConnectivityApi;
  late MockAssetMediaRepository mockAssetMediaRepository;
  late Drift db;

  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel('plugins.flutter.io/path_provider'),
      (MethodCall methodCall) async => 'test',
    );
    db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    await StoreService.init(storeRepository: DriftStoreRepository(db));
    await SettingsRepository.ensureInitialized(db);

    await Store.put(StoreKey.serverEndpoint, 'http://demo.immich.app');
    await Store.put(StoreKey.deviceId, 'device-id');

    registerFallbackValue(File('file'));
    registerFallbackValue(<String, String>{});
  });

  setUp(() {
    mockUploadRepository = MockUploadRepository();
    mockStorageRepository = MockStorageRepository();
    mockBackupRepository = MockDriftBackupRepository();
    mockConnectivityApi = MockConnectivityApi();
    mockAssetMediaRepository = MockAssetMediaRepository();

    sut = ForegroundUploadService(
      mockUploadRepository,
      mockStorageRepository,
      mockBackupRepository,
      mockConnectivityApi,
      mockAssetMediaRepository,
    );
  });

  List<Map<String, String>> captureFields() {
    final captured = <Map<String, String>>[];
    when(
      () => mockUploadRepository.uploadFile(
        file: any(named: 'file'),
        originalFileName: any(named: 'originalFileName'),
        fields: any(named: 'fields'),
        cancelToken: any(named: 'cancelToken'),
        onProgress: any(named: 'onProgress'),
        logContext: any(named: 'logContext'),
      ),
    ).thenAnswer((invocation) async {
      final fields = invocation.namedArguments[#fields] as Map<String, String>;
      captured.add(Map.of(fields));
      return UploadResult.success(remoteAssetId: 'remote-${captured.length}');
    });
    return captured;
  }

  List<String> captureOriginalFileNames() {
    final captured = <String>[];
    when(
      () => mockUploadRepository.uploadFile(
        file: any(named: 'file'),
        originalFileName: any(named: 'originalFileName'),
        fields: any(named: 'fields'),
        cancelToken: any(named: 'cancelToken'),
        onProgress: any(named: 'onProgress'),
        logContext: any(named: 'logContext'),
      ),
    ).thenAnswer((invocation) async {
      captured.add(invocation.namedArguments[#originalFileName] as String);
      return UploadResult.success(remoteAssetId: 'remote-${captured.length}');
    });
    return captured;
  }

  group('uploadSingleAsset', () {
    test('should upload the motion part hidden and keep the still image visible', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/still.heic');
      final videoFile = File('/path/to/motion.mov');

      when(() => mockEntity.isLivePhoto).thenReturn(true);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockStorageRepository.getMotionFileForAsset(asset)).thenAnswer((_) async => videoFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'live.heic');

      final captured = captureFields();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(captured, hasLength(2));
      expect(captured[0]['visibility'], equals('hidden'));
      expect(captured[0].containsKey('livePhotoVideoId'), isFalse);
      expect(captured[1].containsKey('visibility'), isFalse);
      expect(captured[1]['livePhotoVideoId'], equals('remote-1'));
    });

    test('should not set visibility for a regular photo', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/photo.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'photo.jpg');

      final captured = captureFields();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(captured, hasLength(1));
      expect(captured[0].containsKey('visibility'), isFalse);
    });

    test('corrects the extension when iOS returns a rendered file for a .dng asset', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/IMG_6499.jpg');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'IMG_6499.dng');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['IMG_6499.jpg']));
    });

    test('keeps the .dng extension for a genuine RAW original', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/IMG_5210.dng');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'IMG_5210.dng');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['IMG_5210.dng']));
    });

    test('borrows the extension from the asset name for an extensionless name (DJI/Fusion)', () async {
      final asset = LocalAssetStub.image1;
      final mockEntity = MockAssetEntity();
      final stillFile = File('/path/to/DJI_0001');

      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => stillFile);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'DJI_0001');

      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['DJI_0001.jpg']));
    });
  });

  group('resumable selection', () {
    /// A real file big enough to cross the one-chunk threshold, written sparsely.
    File sparse(int size, {String name = 'video.mp4'}) {
      final file = File('${Directory.systemTemp.createTempSync().path}/$name');
      final handle = file.openSync(mode: FileMode.write);
      handle.setPositionSync(size - 1);
      handle.writeByteSync(0);
      handle.closeSync();
      addTearDown(() => file.parent.deleteSync(recursive: true));
      return file;
    }

    void stubEntity(LocalAsset asset, File file) {
      final mockEntity = MockAssetEntity();
      when(() => mockEntity.isLivePhoto).thenReturn(false);
      when(() => mockStorageRepository.getAssetEntityForAsset(asset)).thenAnswer((_) async => mockEntity);
      when(() => mockStorageRepository.isAssetAvailableLocally(asset.id)).thenAnswer((_) async => true);
      when(() => mockStorageRepository.getFileForAsset(asset.id)).thenAnswer((_) async => file);
      when(() => mockAssetMediaRepository.getOriginalFilename(asset.id)).thenAnswer((_) async => 'video.mp4');
    }

    void stubResumable(UploadResult? result) {
      when(
        () => mockUploadRepository.uploadFileResumable(
          file: any(named: 'file'),
          originalFileName: any(named: 'originalFileName'),
          checksum: any(named: 'checksum'),
          fields: any(named: 'fields'),
          cancelToken: any(named: 'cancelToken'),
          onProgress: any(named: 'onProgress'),
          logContext: any(named: 'logContext'),
        ),
      ).thenAnswer((_) async => result);
    }

    test('uses the resumable path for a large hashed asset', () async {
      final asset = LocalAssetStub.image1.copyWith(checksum: 'Ki3hxnotKPzthJ7hu3bnORuT6xI=');
      stubEntity(asset, sparse(kUploadChunkSize * 2));
      stubResumable(UploadResult.success(remoteAssetId: 'asset-id'));

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      verify(
        () => mockUploadRepository.uploadFileResumable(
          file: any(named: 'file'),
          originalFileName: any(named: 'originalFileName'),
          checksum: 'Ki3hxnotKPzthJ7hu3bnORuT6xI=',
          fields: any(named: 'fields'),
          cancelToken: any(named: 'cancelToken'),
          onProgress: any(named: 'onProgress'),
          logContext: any(named: 'logContext'),
        ),
      ).called(1);
    });

    test('falls back to a single request when the server has no resumable api', () async {
      // this fallback is what keeps old servers working, and had no coverage at all
      final asset = LocalAssetStub.image1.copyWith(checksum: 'Ki3hxnotKPzthJ7hu3bnORuT6xI=');
      stubEntity(asset, sparse(kUploadChunkSize * 2));
      stubResumable(null);
      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['video.mp4']));
    });

    test('leaves a small asset on the single-request path', () async {
      final asset = LocalAssetStub.image1.copyWith(checksum: 'Ki3hxnotKPzthJ7hu3bnORuT6xI=');
      stubEntity(asset, sparse(1024));
      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(asset, null, callbacks: const UploadCallbacks());

      expect(names, equals(['video.mp4']));
      verifyNever(
        () => mockUploadRepository.uploadFileResumable(
          file: any(named: 'file'),
          originalFileName: any(named: 'originalFileName'),
          checksum: any(named: 'checksum'),
          fields: any(named: 'fields'),
          cancelToken: any(named: 'cancelToken'),
          onProgress: any(named: 'onProgress'),
          logContext: any(named: 'logContext'),
        ),
      );
    });

    test('leaves an unhashed asset on the single-request path', () async {
      stubEntity(LocalAssetStub.image1, sparse(kUploadChunkSize * 2));
      final names = captureOriginalFileNames();

      await sut.uploadSingleAsset(LocalAssetStub.image1, null, callbacks: const UploadCallbacks());

      expect(names, equals(['video.mp4']));
    });
  });
}
