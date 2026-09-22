/**
 * db.js - IndexedDB storage implementation for PLBT Trader Terminal.
 * This file handles initialization of the IndexedDB database, saving and loading data,
 * and storing large objects such as audio Blobs or complex drawing states.
 */

let dbPromise = null;

/**
 * Initializes the IndexedDB database.
 * Returns a promise that resolves to the IDBDatabase instance.
 */
export function initDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("PLBT_Database", 2);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // Create a general key-value store
            if (!db.objectStoreNames.contains("app_state")) {
                db.createObjectStore("app_state");
            }
            // Create separate voice notes store
            if (!db.objectStoreNames.contains("voice_notes")) {
                db.createObjectStore("voice_notes", { keyPath: "id" });
            }
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error("IndexedDB initialization error:", event.target.error);
            reject(event.target.error);
        };
    });

    return dbPromise;
}

/**
 * Saves a key-value pair to IndexedDB.
 * Works seamlessly with Blobs (for voice notes) or Objects/Arrays (for trade history or drawings).
 * @param {string} key 
 * @param {any} value 
 */
export async function saveData(key, value) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("app_state", "readwrite");
        const store = transaction.objectStore("app_state");
        const request = store.put(value, key);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = (event) => {
            console.error(`Error saving data for key "${key}":`, event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Retrieves a value by its key from IndexedDB.
 * @param {string} key 
 * @returns {Promise<any>}
 */
export async function getData(key) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("app_state", "readonly");
        const store = transaction.objectStore("app_state");
        const request = store.get(key);

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onerror = (event) => {
            console.error(`Error retrieving data for key "${key}":`, event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Deletes a value by its key from IndexedDB.
 * @param {string} key 
 */
export async function deleteData(key) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("app_state", "readwrite");
        const store = transaction.objectStore("app_state");
        const request = store.delete(key);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = (event) => {
            console.error(`Error deleting data for key "${key}":`, event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Clears the entire database (both app_state and voice_notes stores).
 */
export async function clearDB() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(["app_state", "voice_notes"], "readwrite");
        const stateStore = transaction.objectStore("app_state");
        const voiceStore = transaction.objectStore("voice_notes");
        stateStore.clear();
        voiceStore.clear();

        transaction.oncomplete = () => {
            resolve();
        };

        transaction.onerror = (event) => {
            console.error("Error clearing IndexedDB:", event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Saves a voice note object { id, audio: Blob, timestamp } to IndexedDB.
 * @param {string} id - The ID of the voice note (usually "voice_note_" + tradeId)
 * @param {Blob} blobData - The audio recording Blob
 */
export async function saveVoiceNote(id, blobData) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("voice_notes", "readwrite");
        const store = transaction.objectStore("voice_notes");
        const voiceNoteObj = {
            id: id,
            audio: blobData,
            timestamp: Date.now()
        };
        const request = store.put(voiceNoteObj);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = (event) => {
            console.error(`Error saving voice note for id "${id}":`, event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Retrieves all saved voice note objects.
 * @returns {Promise<Array<{id: string, audio: Blob, timestamp: number}>>}
 */
export async function getAllVoiceNotes() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("voice_notes", "readonly");
        const store = transaction.objectStore("voice_notes");
        const request = store.getAll();

        request.onsuccess = (event) => {
            resolve(event.target.result || []);
        };

        request.onerror = (event) => {
            console.error("Error retrieving all voice notes:", event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Deletes a voice note by its ID from IndexedDB.
 * @param {string} id 
 */
export async function deleteVoiceNoteFromDB(id) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction("voice_notes", "readwrite");
        const store = transaction.objectStore("voice_notes");
        const request = store.delete(id);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = (event) => {
            console.error(`Error deleting voice note "${id}":`, event.target.error);
            reject(event.target.error);
        };
    });
}

/**
 * Saves trade thoughts (before, during, after) to IndexedDB.
 */
export async function saveTradeThoughts(tradeId, thoughtBefore, thoughtDuring, thoughtAfter) {
    const key = `trade_thoughts_${tradeId}`;
    await saveData(key, { thoughtBefore, thoughtDuring, thoughtAfter, timestamp: Date.now() });
}

/**
 * Retrieves trade thoughts (before, during, after) from IndexedDB.
 */
export async function getTradeThoughts(tradeId) {
    const key = `trade_thoughts_${tradeId}`;
    return await getData(key);
}

