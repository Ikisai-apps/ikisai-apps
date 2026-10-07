/**
 * Caché local por persona (API.md §10): la última respuesta de cada lectura, para verla sin red, los cambios pendientes de enviar (`outbox`) y los
 * formularios, para no perder lo tecleado. Vive en IndexedDB y se borra al cerrar la sesión de esa persona
 * (`onSessionEnd`). Si IndexedDB no está disponible (modo privado), todo sigue funcionando sin caché.
 */
const DB = 'ikisai-guests';
const STORES = ['reads', 'drafts', 'outbox'] as const;
type Store = (typeof STORES)[number];

interface Entry<T> { key: string; userId: string; at: string; value: T }

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'key' }).createIndex('userId', 'userId');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function done<T>(request: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

async function get<T>(store: Store, key: string): Promise<Entry<T> | null> {
  const db = await open();
  if (!db) return null;
  return ((await done(db.transaction(store).objectStore(store).get(key))) as Entry<T> | undefined) ?? null;
}

async function put<T>(store: Store, userId: string, key: string, value: T): Promise<void> {
  const db = await open();
  if (!db) return;
  await done(db.transaction(store, 'readwrite').objectStore(store).put({ key, userId, at: new Date().toISOString(), value } satisfies Entry<T>));
}

async function remove(store: Store, key: string): Promise<void> {
  const db = await open();
  if (!db) return;
  await done(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

const readKey = (userId: string, name: string, args: unknown) => `${userId}|${name}|${JSON.stringify(args ?? {})}`;
const draftKey = (userId: string, id: string) => `${userId}|${id}`;

export const cache = {
  async read<T>(userId: string, name: string, args: unknown): Promise<{ value: T; at: string } | null> {
    const entry = await get<T>('reads', readKey(userId, name, args));
    return entry ? { value: entry.value, at: entry.at } : null;
  },
  saveRead<T>(userId: string, name: string, args: unknown, value: T): Promise<void> {
    return put('reads', userId, readKey(userId, name, args), value);
  },
  async draft<T>(userId: string, id: string): Promise<T | null> {
    return (await get<T>('drafts', draftKey(userId, id)))?.value ?? null;
  },
  saveDraft<T>(userId: string, id: string, value: T): Promise<void> {
    return put('drafts', userId, draftKey(userId, id), value);
  },
  dropDraft(userId: string, id: string): Promise<void> {
    return remove('drafts', draftKey(userId, id));
  },
  /** Cambios de un huésped pendientes de enviar a Booking (autoguardado sin red, `writer.ts`); la firma va como Blob. */
  async outbox<T>(userId: string, guestId: string): Promise<T | null> {
    return (await get<T>('outbox', draftKey(userId, guestId)))?.value ?? null;
  },
  saveOutbox<T>(userId: string, guestId: string, value: T): Promise<void> {
    return put('outbox', userId, draftKey(userId, guestId), value);
  },
  dropOutbox(userId: string, guestId: string): Promise<void> {
    return remove('outbox', draftKey(userId, guestId));
  },
  /** Fin de la sesión de una persona en el dispositivo: fuera sus lecturas, borradores y cambios pendientes. */
  async clearUser(userId: string): Promise<void> {
    const db = await open();
    if (!db) return;
    for (const store of STORES) {
      const tx = db.transaction(store, 'readwrite');
      const keys = await done(tx.objectStore(store).index('userId').getAllKeys(userId));
      const write = db.transaction(store, 'readwrite').objectStore(store);
      for (const key of keys ?? []) await done(write.delete(key));
    }
  },
};
