import { PlayerStats, BotSettings, DEFAULT_SETTINGS } from '../types/poker';

// ============================================================
// IndexedDB Storage for Persistent Opponent Data
// ============================================================

const DB_NAME = 'pokernow-gto-bot';
const DB_VERSION = 1;
const STORES = {
  PLAYER_STATS: 'playerStats',
  SETTINGS: 'settings',
  HAND_HISTORY: 'handHistory',
};

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORES.PLAYER_STATS)) {
        const store = db.createObjectStore(STORES.PLAYER_STATS, { keyPath: 'playerName' });
        store.createIndex('lastSeen', 'lastSeen', { unique: false });
        store.createIndex('handsPlayed', 'handsPlayed', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains(STORES.HAND_HISTORY)) {
        const histStore = db.createObjectStore(STORES.HAND_HISTORY, { autoIncrement: true });
        histStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      resolve(dbInstance);
    };

    request.onerror = () => reject(request.error);
  });
}

// ============================================================
// Player Stats CRUD
// ============================================================

export async function getPlayerStats(playerName: string): Promise<PlayerStats | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PLAYER_STATS, 'readonly');
    const store = tx.objectStore(STORES.PLAYER_STATS);
    const request = store.get(playerName);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function savePlayerStats(stats: PlayerStats): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PLAYER_STATS, 'readwrite');
    const store = tx.objectStore(STORES.PLAYER_STATS);
    const request = store.put(stats);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getAllPlayerStats(): Promise<PlayerStats[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PLAYER_STATS, 'readonly');
    const store = tx.objectStore(STORES.PLAYER_STATS);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function deletePlayerStats(playerName: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PLAYER_STATS, 'readwrite');
    const store = tx.objectStore(STORES.PLAYER_STATS);
    const request = store.delete(playerName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** Create a fresh stats object for a new player */
export function createEmptyStats(playerName: string): PlayerStats {
  return {
    playerName,
    handsPlayed: 0,
    vpipCount: 0,
    pfrCount: 0,
    threeBetCount: 0,
    threeBetOpportunity: 0,
    foldToThreeBetCount: 0,
    foldToThreeBetOpportunity: 0,
    coldCallCount: 0,
    coldCallOpportunity: 0,
    cbetFlopCount: 0,
    cbetFlopOpportunity: 0,
    cbetTurnCount: 0,
    cbetTurnOpportunity: 0,
    foldToCbetFlopCount: 0,
    foldToCbetFlopOpportunity: 0,
    foldToCbetTurnCount: 0,
    foldToCbetTurnOpportunity: 0,
    betCount: 0,
    raiseCount: 0,
    callCount: 0,
    foldCount: 0,
    wentToShowdownCount: 0,
    wonAtShowdownCount: 0,
    showdownOpportunity: 0,
    lastSeen: Date.now(),
    firstSeen: Date.now(),
  };
}

// ============================================================
// Settings
// ============================================================

export async function getSettings(): Promise<BotSettings> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SETTINGS, 'readonly');
    const store = tx.objectStore(STORES.SETTINGS);
    const request = store.get('botSettings');
    request.onsuccess = () => {
      resolve(request.result?.value || DEFAULT_SETTINGS);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function saveSettings(settings: BotSettings): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.SETTINGS, 'readwrite');
    const store = tx.objectStore(STORES.SETTINGS);
    const request = store.put({ key: 'botSettings', value: settings });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ============================================================
// Hand History
// ============================================================

export async function saveHandHistory(hand: any): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.HAND_HISTORY, 'readwrite');
    const store = tx.objectStore(STORES.HAND_HISTORY);
    const request = store.add({ ...hand, timestamp: Date.now() });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
