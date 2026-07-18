const DB_NAME = "piano-practice-tracker";
const DB_VERSION = 2;
// Split into two stores so saving progress (frequent, tiny) never has to
// re-serialize and rewrite a file's full MusicXML text (large, immutable
// after upload) — IndexedDB has no partial-update API, put() always writes
// the whole record.
const CONTENT_STORE = "files";
const PROGRESS_STORE = "progress";

let dbPromise = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONTENT_STORE)) {
        db.createObjectStore(CONTENT_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
        db.createObjectStore(PROGRESS_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getDB() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function put(storeName, entry) {
  return getDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function getOne(storeName, id) {
  return getDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

function getAll(storeName) {
  return getDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

function del(storeName, id) {
  return getDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

// --- File content: { id, fileName, musicXmlText, createdAt } — written
// once on upload, never rewritten afterward. ---

export const putFileContent = (entry) => put(CONTENT_STORE, entry);
export const getFileContent = (id) => getOne(CONTENT_STORE, id);
export const getAllFileContents = () => getAll(CONTENT_STORE);
export const deleteFileContent = (id) => del(CONTENT_STORE, id);

// --- Progress: { id, settings, progress, updatedAt } — small, written on
// every note advance and settings change. ---

export const putProgress = (record) => put(PROGRESS_STORE, record);
export const getProgress = (id) => getOne(PROGRESS_STORE, id);
export const getAllProgress = () => getAll(PROGRESS_STORE);
export const deleteProgress = (id) => del(PROGRESS_STORE, id);
