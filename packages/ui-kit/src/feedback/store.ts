/**
 * Borradores y bandeja sin red del feedback (especificación §2.5, §2.6, §18; FEEDBACK.md §6). IndexedDB del origen
 * de la app (cada app tiene el suyo), con la cuenta en la clave: una cuenta nunca ve lo de otra. Guarda Blobs (imágenes
 * ya comprimidas). `clearFeedbackForUser` lo borra todo al cerrar sesión o cambiar de usuario (`onSessionEnd`).
 */
import type { FeedbackIntent, FeedbackSubject } from './constants.ts';

export interface FeedbackImage {
  id: string;
  blob: Blob;
  mime: string;
  filename: string;
  /** Id del archivo subido (`feedback/uploads`), cuando ya se subió. */
  uploadedId?: string;
}

export interface FeedbackDraft {
  id: string;
  userId: string;
  app: string;
  nodeId: string;
  nodePath: string[];
  message: string;
  intent: FeedbackIntent;
  subject: FeedbackSubject;
  images: FeedbackImage[];
  /** «Me bloquea». */
  blocking?: boolean;
  updatedAt: string;
}

export interface FeedbackOutboxItem extends FeedbackDraft {
  /** `id` y `requestId` del reporte: se mantienen en cada reintento (idempotencia). */
  requestId: string;
  context: Record<string, unknown>;
  scope?: Record<string, string>;
  category?: string;
  attempts: number;
  lastError?: string;
  /** Error que no se arregla reintentando (límite superado, fuera de ámbito): se queda para que la persona decida. */
  failed?: boolean;
}

const DB_NAME = 'ikisai-feedback';
const VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of ['drafts', 'outbox']) {
        if (!database.objectStoreNames.contains(name)) {
          const store = database.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('user', 'userId');
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function run<T>(storeName: 'drafts' | 'outbox', mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((database) => new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const request = work(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

async function byUser<T>(storeName: 'drafts' | 'outbox', userId: string, app: string): Promise<T[]> {
  const items = (await run<T[]>(storeName, 'readonly', (s) => s.index('user').getAll(IDBKeyRange.only(userId)) as IDBRequest<T[]>)) ?? [];
  return items.filter((i) => (i as unknown as { app: string }).app === app);
}

export const feedbackDrafts = {
  list: (userId: string, app: string) => byUser<FeedbackDraft>('drafts', userId, app),
  get: (id: string) => run<FeedbackDraft>('drafts', 'readonly', (s) => s.get(id) as IDBRequest<FeedbackDraft>),
  put: (draft: FeedbackDraft) => run('drafts', 'readwrite', (s) => { s.put(draft); }),
  delete: (id: string) => run('drafts', 'readwrite', (s) => { s.delete(id); }),
};

export const feedbackOutbox = {
  list: (userId: string, app: string) => byUser<FeedbackOutboxItem>('outbox', userId, app),
  put: (item: FeedbackOutboxItem) => run('outbox', 'readwrite', (s) => { s.put(item); }),
  delete: (id: string) => run('outbox', 'readwrite', (s) => { s.delete(id); }),
};

/** Borra borradores y bandeja de una cuenta (al cerrar sesión o cambiar de usuario). */
export async function clearFeedbackForUser(userId: string): Promise<void> {
  for (const storeName of ['drafts', 'outbox'] as const) {
    const keys = (await run<IDBValidKey[]>(storeName, 'readonly', (s) => s.index('user').getAllKeys(IDBKeyRange.only(userId)) as IDBRequest<IDBValidKey[]>)) ?? [];
    await run(storeName, 'readwrite', (s) => { for (const key of keys) s.delete(key); });
  }
}
