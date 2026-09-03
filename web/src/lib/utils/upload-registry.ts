/**
 * Tracks in-flight uploads so they can all be aborted at once, e.g. when the user logs out.
 *
 * Its own module rather than living in `$lib/utils` so the resumable uploader can share the
 * registry without importing that barrel, which pulls in the SDK and the asset caches.
 */
let nextId = 0;
const uploads: Record<number, () => void> = {};

/** Registers an abort callback. Returns a function that unregisters it. */
export const trackUpload = (abort: () => void) => {
  const id = nextId++;
  uploads[id] = abort;
  return () => {
    delete uploads[id];
  };
};

export const cancelUploadRequests = () => {
  for (const abort of Object.values(uploads)) {
    abort();
  }
};
