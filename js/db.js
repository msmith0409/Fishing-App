// Tiny IndexedDB wrapper. Everything is stored on this device only.
const DB_NAME = 'fishing-intel';
const DB_VERSION = 1;
const STORES = ['trips', 'catches', 'photos', 'kv'];

let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          const os = db.createObjectStore(s, { keyPath: 'id' });
          if (s === 'catches') os.createIndex('tripId', 'tripId');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    const r = fn(os);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  get: (store, id) => tx(store, 'readonly', (os) => os.get(id)),
  all: (store) => tx(store, 'readonly', (os) => os.getAll()),
  put: (store, obj) => tx(store, 'readwrite', (os) => os.put(obj)),
  del: (store, id) => tx(store, 'readwrite', (os) => os.delete(id)),
  byTrip: (tripId) => tx('catches', 'readonly', (os) => os.index('tripId').getAll(tripId)),
  async kvGet(key, fallback = null) {
    const r = await db.get('kv', key);
    return r ? r.value : fallback;
  },
  kvSet: (key, value) => db.put('kv', { id: key, value }),
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}
