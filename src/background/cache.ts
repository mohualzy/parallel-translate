/**
 * 译文缓存：IndexedDB 持久化 + 内存 LRU 热层。
 * 键由调用方生成（服务地址 + 模型 + 目标语言 + 提示词 + 原文 的哈希）。
 */

const DB_NAME = 'ptx-cache';
const STORE = 'translations';
const MEMORY_LIMIT = 2000;
/** 超过这个天数未写入的条目在启动时清理 */
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface Entry {
  key: string;
  value: string;
  ts: number;
}

const memory = new Map<string, string>();
let dbPromise: Promise<IDBDatabase> | undefined;

function remember(key: string, value: string) {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
}

function openDB(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = undefined;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getMany(keys: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const misses: string[] = [];
  for (const key of keys) {
    const hit = memory.get(key);
    if (hit !== undefined) found.set(key, hit);
    else misses.push(key);
  }
  if (misses.length === 0) return found;

  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  await Promise.all(
    misses.map(
      (key) =>
        new Promise<void>((resolve) => {
          const req = store.get(key);
          req.onsuccess = () => {
            const entry = req.result as Entry | undefined;
            if (entry) {
              found.set(key, entry.value);
              remember(key, entry.value);
            }
            resolve();
          };
          req.onerror = () => resolve(); // 单条读失败当作未命中
        }),
    ),
  );
  return found;
}

export async function setMany(entries: [key: string, value: string][]): Promise<void> {
  if (entries.length === 0) return;
  for (const [key, value] of entries) remember(key, value);
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const ts = Date.now();
  for (const [key, value] of entries) store.put({ key, value, ts } satisfies Entry);
  await done(tx);
}

export async function count(): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function clear(): Promise<void> {
  memory.clear();
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}

/** 删除早于 maxAgeMs 的条目 */
export async function prune(maxAgeMs = MAX_AGE_MS): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const range = IDBKeyRange.upperBound(Date.now() - maxAgeMs);
  const req = tx.objectStore(STORE).index('ts').openCursor(range);
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  await done(tx);
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
