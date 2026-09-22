import { getData, saveData } from "./server/db.js";

export const SCHEMA_VERSION = 1;

const SCHEMA_VERSION_KEY = "plbt_schema_version";
const BACKUP_KEY = "plbt_migration_backup";
const INDEXEDDB_BACKUP_KEYS = ["drawings"];

function getStoredSchemaVersion() {
  const raw = localStorage.getItem(SCHEMA_VERSION_KEY);
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function createBackup() {
  const localStorageSnapshot = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === BACKUP_KEY) continue;
    localStorageSnapshot[key] = localStorage.getItem(key);
  }
  const indexedDbSnapshot = {};
  for (const key of INDEXEDDB_BACKUP_KEYS) {
    try {
      indexedDbSnapshot[key] = await getData(key);
    } catch (e) {}
  }
  const backup = {
    timestamp: Date.now(),
    schemaVersion: getStoredSchemaVersion(),
    localStorage: localStorageSnapshot,
    indexedDb: indexedDbSnapshot
  };
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
  } catch (e) {}
  return backup;
}

async function restoreFromBackup(backup) {
  if (!backup) return;
  try {
    Object.entries(backup.localStorage || {}).forEach(([key, value]) => {
      localStorage.setItem(key, value);
    });
    for (const [key, value] of Object.entries(backup.indexedDb || {})) {
      if (value !== undefined && value !== null) await saveData(key, value);
    }
    localStorage.setItem(SCHEMA_VERSION_KEY, String(backup.schemaVersion));
  } catch (e) {
    console.error("[DataMigration ERROR] Восстановление не удалось:", e);
  }
}

const MIGRATIONS_PIPELINE = [];

export async function runMigrations() {
  const storedVersion = getStoredSchemaVersion();
  if (storedVersion >= SCHEMA_VERSION) {
    return { migrated: false, from: storedVersion, to: storedVersion };
  }
  const pending = MIGRATIONS_PIPELINE
    .filter((m) => m.version > storedVersion && m.version <= SCHEMA_VERSION)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    localStorage.setItem(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
    return { migrated: false, from: storedVersion, to: SCHEMA_VERSION };
  }

  const backup = await createBackup();
  try {
    for (const m of pending) {
      await m.run();
      localStorage.setItem(SCHEMA_VERSION_KEY, String(m.version));
    }
    return { migrated: true, from: storedVersion, to: SCHEMA_VERSION };
  } catch (err) {
    await restoreFromBackup(backup);
    throw err;
  }
}