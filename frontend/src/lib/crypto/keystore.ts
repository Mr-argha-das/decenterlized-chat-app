export interface StoredIdentityKey {
  globalId: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
  createdAt: string;
}

const DB_NAME = "relaychat-keystore-v1";
const DB_VERSION = 1;
const IDENTITY_STORE = "identities";

// In-memory fallback only if browser blocks IndexedDB in a strict privacy iframe
const memoryKeystore = new Map<string, StoredIdentityKey>();

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("IndexedDB is only available in the browser."));
      return;
    }
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
          db.createObjectStore(IDENTITY_STORE, { keyPath: "globalId" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB keystore."));
    } catch (err) {
      reject(err);
    }
  });
}

export async function saveIdentityKeyToIndexedDB(record: StoredIdentityKey): Promise<void> {
  memoryKeystore.set(record.globalId, record);
  try {
    const db = await openKeyDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, "readwrite");
      tx.objectStore(IDENTITY_STORE).put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("Failed to store identity key in IndexedDB."));
      };
    });
  } catch {
    // Kept safely in memoryKeystore for restricted iframe sessions
  }
}

export async function loadIdentityKeyFromIndexedDB(
  globalId: string
): Promise<StoredIdentityKey | null> {
  try {
    const db = await openKeyDatabase();
    const found = await new Promise<StoredIdentityKey | null>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, "readonly");
      const req = tx.objectStore(IDENTITY_STORE).get(globalId);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as StoredIdentityKey | undefined) ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("Failed to read identity key from IndexedDB."));
      };
    });
    if (found) {
      memoryKeystore.set(globalId, found);
      return found;
    }
  } catch {
    // Fall back to in-memory keystore if IndexedDB is restricted
  }
  return memoryKeystore.get(globalId) ?? null;
}

export async function deleteIdentityKeyFromIndexedDB(globalId: string): Promise<void> {
  memoryKeystore.delete(globalId);
  try {
    const db = await openKeyDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, "readwrite");
      tx.objectStore(IDENTITY_STORE).delete(globalId);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error("Failed to delete identity key."));
      };
    });
  } catch {
    // ignore if IndexedDB restricted
  }
}
