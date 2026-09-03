import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

// `Request` collides with http's; only http's is used here.
import 'package:background_downloader/background_downloader.dart' hide Request;
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:immich_mobile/utils/debug_print.dart';
import 'package:immich_mobile/utils/tus.dart';
import 'package:logging/logging.dart';

final uploadRepositoryProvider = Provider((ref) => UploadRepository());

class UploadRepository {
  final Logger logger = Logger('UploadRepository');
  void Function(TaskStatusUpdate)? onUploadStatus;
  void Function(TaskProgressUpdate)? onTaskProgress;

  UploadRepository() {
    FileDownloader().registerCallbacks(
      group: kBackupGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kBackupLivePhotoGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kManualUploadGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
  }

  Future<void> enqueueBackground(UploadTask task) {
    return FileDownloader().enqueue(task);
  }

  Future<List<bool>> enqueueBackgroundAll(List<UploadTask> tasks) {
    return FileDownloader().enqueueAll(tasks);
  }

  Future<void> deleteDatabaseRecords(String group) {
    return FileDownloader().database.deleteAllRecords(group: group);
  }

  Future<bool> cancelAll(String group) {
    return FileDownloader().cancelAll(group: group);
  }

  Future<int> reset(String group) {
    return FileDownloader().reset(group: group);
  }

  /// Get a list of tasks that are ENQUEUED or RUNNING
  Future<List<Task>> getActiveTasks(String group) {
    return FileDownloader().allTasks(group: group);
  }

  Future<void> start() {
    return FileDownloader().start();
  }

  Future<void> getUploadInfo() async {
    final [enqueuedTasks, runningTasks, canceledTasks, waitingTasks, pausedTasks] = await Future.wait([
      FileDownloader().database.allRecordsWithStatus(TaskStatus.enqueued, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.running, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.canceled, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.waitingToRetry, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.paused, group: kBackupGroup),
    ]);

    dPrint(
      () =>
          """
      Upload Info:
      Enqueued: ${enqueuedTasks.length}
      Running: ${runningTasks.length}
      Canceled: ${canceledTasks.length}
      Waiting: ${waitingTasks.length}
      Paused: ${pausedTasks.length}
    """,
    );
  }

  Future<UploadResult> uploadFile({
    required File file,
    required String originalFileName,
    required Map<String, String> fields,
    required Completer<void>? cancelToken,
    void Function(int bytes, int totalBytes)? onProgress,
    required String logContext,
    Client? httpClient,
  }) async {
    final String savedEndpoint = Store.get(StoreKey.serverEndpoint);

    ProgressMultipartRequest buildRequest() {
      final request = ProgressMultipartRequest(
        'POST',
        Uri.parse('$savedEndpoint/assets'),
        abortTrigger: cancelToken?.future,
        onProgress: onProgress,
      );
      request.fields.addAll(fields);
      request.files.add(MultipartFile("assetData", file.openRead(), file.lengthSync(), filename: originalFileName));
      return request;
    }

    try {
      final client = httpClient ?? NetworkRepository.client;
      StreamedResponse response;
      try {
        response = await client.send(buildRequest());
      } on RequestAbortedException {
        rethrow;
      } on ClientException catch (error) {
        logger.warning("Upload $logContext failed before a response, resending once: $error");
        response = await client.send(buildRequest());
      }

      final res = await Response.fromStream(response);
      return [HttpStatus.ok, HttpStatus.created].contains(res.statusCode)
          ? _resultFrom(res, logContext)
          : _errorFrom(res, logContext);
    } on RequestAbortedException {
      logger.warning("Upload $logContext was cancelled");
      return UploadResult.cancelled();
    } catch (error, stackTrace) {
      logger.warning("Error uploading $logContext: $error: $stackTrace");
      return UploadResult.error(errorMessage: error.toString());
    }
  }

  /// Abandon a tus session so its bytes are not left on the server until they expire.
  Future<void> terminateResumableSession(Uri url, {Client? httpClient}) async {
    try {
      await _send(
        httpClient ?? NetworkRepository.client,
        'DELETE',
        url,
        cancelToken: null,
        headers: const {'Tus-Resumable': kTusVersion},
      );
    } catch (error) {
      // best effort: the server's expiry sweep is the backstop
      logger.warning('Failed to terminate resumable session $url: $error');
    }
  }

  /// Create a tus upload session.
  ///
  /// Returns null when the server has no resumable upload API, so callers can fall back to the
  /// single-request endpoint. Attempting the creation request is the capability probe: a dedicated
  /// OPTIONS probe is answered by CORS middleware on dev servers before it reaches the route.
  Future<ResumableSession?> createResumableSession({
    required int size,
    required String originalFileName,
    required String checksum,
    required Map<String, String> fields,
    Completer<void>? cancelToken,
    Client? httpClient,
  }) async {
    final endpoint = Store.get(StoreKey.serverEndpoint);
    final client = httpClient ?? NetworkRepository.client;

    final response = await _send(
      client,
      'POST',
      Uri.parse('$endpoint/assets/upload'),
      cancelToken: cancelToken,
      headers: {
        'Tus-Resumable': kTusVersion,
        'Upload-Length': '$size',
        'Upload-Metadata': encodeUploadMetadata({...fields, 'filename': originalFileName}),
        'x-immich-checksum': checksum,
      },
    );

    if (response.statusCode == HttpStatus.notFound || response.statusCode == HttpStatus.methodNotAllowed) {
      return null;
    }

    if (response.statusCode == HttpStatus.ok) {
      return ResumableSession(duplicate: _resultFrom(response, originalFileName));
    }

    final location = response.headers['location'];
    if (response.statusCode != HttpStatus.created || location == null) {
      throw StateError('Unable to start a resumable upload: ${response.statusCode}');
    }

    return ResumableSession(url: Uri.parse(endpoint).resolve(location));
  }

  /// Upload a file in chunks over the tus API, resuming from the server's offset if a session for
  /// this file already exists.
  ///
  /// Returns null when the server has no resumable upload API, so the caller can fall back to
  /// [uploadFile]. Attempting the creation request is the capability probe: a dedicated OPTIONS
  /// probe is answered by CORS middleware on dev servers before it reaches the route.
  Future<UploadResult?> uploadFileResumable({
    required File file,
    required String originalFileName,
    required String checksum,
    required Map<String, String> fields,
    required Completer<void>? cancelToken,
    void Function(int bytes, int totalBytes)? onProgress,
    required String logContext,
    Client? httpClient,
    int chunkSize = kUploadChunkSize,
  }) async {
    final client = httpClient ?? NetworkRepository.client;
    final total = file.lengthSync();
    RandomAccessFile? handle;

    try {
      final session = await createResumableSession(
        size: total,
        originalFileName: originalFileName,
        checksum: checksum,
        fields: fields,
        cancelToken: cancelToken,
        httpClient: client,
      );

      // an older server has no such route
      if (session == null) {
        return null;
      }

      // the server recognised the checksum, so there is nothing to upload
      if (session.duplicate != null) {
        return session.duplicate;
      }

      final url = session.url!;
      handle = await file.open();
      var offset = 0;
      var reported = 0;

      while (offset < total) {
        if (cancelToken?.isCompleted ?? false) {
          return UploadResult.cancelled();
        }

        final range = chunkRange(offset, total, chunkSize: chunkSize);
        final response = await _send(
          client,
          'PATCH',
          url,
          cancelToken: cancelToken,
          headers: {'Tus-Resumable': kTusVersion, 'Upload-Offset': '$offset', 'Content-Type': kTusOffsetContentType},
          body: await _readRange(handle, range.start, range.end - range.start),
        );

        // the server is the authority on the offset; a 409 carries the real one so we can resume
        if (response.statusCode == HttpStatus.conflict) {
          final authoritative = parseUploadOffset(response.headers);
          if (authoritative == null || authoritative == offset) {
            return UploadResult.error(errorMessage: 'Resumable upload stalled: server offset did not advance');
          }
          offset = authoritative;
          continue;
        }

        if (response.statusCode == HttpStatus.ok || response.statusCode == HttpStatus.created) {
          onProgress?.call(total, total);
          return _resultFrom(response, logContext);
        }

        if (response.statusCode != HttpStatus.noContent) {
          return _errorFrom(response, logContext);
        }

        // a 204 whose offset did not move means the chunk stored nothing; re-sending it forever
        // is the loop the reverse-proxy docs warn about
        final next = parseUploadOffset(response.headers) ?? range.end;
        if (next <= offset) {
          return UploadResult.error(errorMessage: 'Resumable upload stalled: server offset did not advance');
        }

        offset = next;
        // clamped like the web client: the bar must not go back if the server commits less
        reported = next > reported ? next : reported;
        onProgress?.call(reported, total);
      }

      return UploadResult.error(errorMessage: 'Resumable upload finished without a response from the server');
    } on RequestAbortedException {
      logger.warning("Resumable upload $logContext was cancelled");
      return UploadResult.cancelled();
    } catch (error, stackTrace) {
      logger.warning("Error uploading $logContext: $error: $stackTrace");
      return UploadResult.error(errorMessage: error.toString());
    } finally {
      await handle?.close();
    }
  }

  /// Reads exactly [length] bytes from [start] as a Uint8List, which `bodyBytes` stores without
  /// copying. Streaming the range through `expand` would materialise one Dart int per byte.
  Future<Uint8List> _readRange(RandomAccessFile handle, int start, int length) async {
    await handle.setPosition(start);
    return handle.read(length);
  }

  Future<Response> _send(
    Client client,
    String method,
    Uri url, {
    required Map<String, String> headers,
    required Completer<void>? cancelToken,
    List<int>? body,
  }) async {
    final request = AbortableRequest(method, url, abortTrigger: cancelToken?.future);
    request.headers.addAll(headers);
    if (body != null) {
      request.bodyBytes = body;
    }

    return Response.fromStream(await client.send(request));
  }

  UploadResult _resultFrom(Response response, String logContext) {
    try {
      final body = jsonDecode(response.body);
      return UploadResult.success(remoteAssetId: body['id'] as String);
    } catch (_) {
      logger.warning("Unparseable response for $logContext: ${response.body}");
      return UploadResult.error(errorMessage: 'Failed to parse server response');
    }
  }

  UploadResult _errorFrom(Response response, String logContext) {
    if (response.statusCode == HttpStatus.requestEntityTooLarge) {
      return UploadResult.error(
        statusCode: response.statusCode,
        errorMessage: 'Error(413) File is too large to upload',
      );
    }

    String? message;
    try {
      final error = jsonDecode(response.body);
      message = error['message'] ?? error['error'];
    } catch (_) {
      message = response.body.isNotEmpty ? response.body : 'Upload failed with status ${response.statusCode}';
    }

    logger.warning("Resumable upload $logContext failed: ${response.statusCode} $message");
    return UploadResult.error(statusCode: response.statusCode, errorMessage: message);
  }
}

/// Either a live session to upload into, or an asset the server already had.
class ResumableSession {
  final Uri? url;
  final UploadResult? duplicate;

  const ResumableSession({this.url, this.duplicate});
}

class AbortableRequest extends Request with Abortable {
  AbortableRequest(super.method, super.url, {this.abortTrigger});

  @override
  final Future<void>? abortTrigger;
}

class ProgressMultipartRequest extends MultipartRequest with Abortable {
  ProgressMultipartRequest(super.method, super.url, {this.abortTrigger, this.onProgress});

  @override
  final Future<void>? abortTrigger;

  final void Function(int bytes, int totalBytes)? onProgress;

  @override
  ByteStream finalize() {
    final byteStream = super.finalize();
    if (onProgress == null) {
      return byteStream;
    }

    final total = contentLength;
    var bytes = 0;
    final stream = byteStream.transform(
      StreamTransformer.fromHandlers(
        handleData: (List<int> data, EventSink<List<int>> sink) {
          bytes += data.length;
          onProgress!(bytes, total);
          sink.add(data);
        },
      ),
    );
    return ByteStream(stream);
  }
}

class UploadResult {
  final bool isSuccess;
  final bool isCancelled;
  final String? remoteAssetId;
  final String? errorMessage;
  final int? statusCode;

  const UploadResult({
    required this.isSuccess,
    required this.isCancelled,
    this.remoteAssetId,
    this.errorMessage,
    this.statusCode,
  });

  factory UploadResult.success({required String remoteAssetId}) {
    return UploadResult(isSuccess: true, isCancelled: false, remoteAssetId: remoteAssetId);
  }

  factory UploadResult.error({String? errorMessage, int? statusCode}) {
    return UploadResult(isSuccess: false, isCancelled: false, errorMessage: errorMessage, statusCode: statusCode);
  }

  factory UploadResult.cancelled() {
    return const UploadResult(isSuccess: false, isCancelled: true);
  }
}
