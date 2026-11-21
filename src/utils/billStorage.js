// IndexedDB utility for persisting uploaded bill files (PDFs/Images) locally
// Allows high-resolution preview across page refreshes without 5MB localStorage limits.

const DB_NAME = 'UtilitySenseBillStore';
const DB_VERSION = 1;
const STORE_NAME = 'bill_documents';

function openBillDb() {
    return new Promise((resolve, reject) => {
        if (typeof window === 'undefined' || !window.indexedDB) {
            reject(new Error('IndexedDB not supported in this environment'));
            return;
        }

        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Save a bill file (Blob / File) into IndexedDB
 * @param {string} key - e.g. "4010_2026-06"
 * @param {Blob|File} fileBlob
 * @param {string} fileName
 */
export async function saveBillFile(key, fileBlob, fileName) {
    try {
        const db = await openBillDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const record = {
                key,
                fileName: fileName || 'uploaded_bill.pdf',
                blob: fileBlob,
                mimeType: fileBlob.type || 'application/pdf',
                savedAt: new Date().toISOString()
            };
            const request = store.put(record);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.warn('Could not save bill file to IndexedDB:', err);
        return false;
    }
}

/**
 * Retrieve a bill file from IndexedDB
 * @param {string} key - e.g. "4010_2026-06"
 * @returns {Promise<{blob: Blob, fileName: string, url: string}|null>}
 */
export async function getBillFile(key) {
    try {
        const db = await openBillDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => {
                const res = request.result;
                if (!res || !res.blob) {
                    resolve(null);
                    return;
                }
                const url = URL.createObjectURL(res.blob);
                resolve({
                    blob: res.blob,
                    fileName: res.fileName,
                    url,
                    savedAt: res.savedAt
                });
            };
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.warn('Could not retrieve bill file from IndexedDB:', err);
        return null;
    }
}

/**
 * Delete a bill file from IndexedDB
 * @param {string} key
 */
export async function deleteBillFile(key) {
    try {
        const db = await openBillDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.delete(key);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.warn('Could not delete bill file from IndexedDB:', err);
        return false;
    }
}

/**
 * Clear all bill files from IndexedDB
 */
export async function clearAllBillFiles() {
    try {
        const db = await openBillDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.clear();
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.warn('Could not clear all bill files from IndexedDB:', err);
        return false;
    }
}

