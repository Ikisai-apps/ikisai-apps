/**
 * Caché local por persona (API.md §10): la última respuesta de cada lectura, para verla sin red, y los borradores de los
 * formularios, para no perder lo tecleado; y la portada de cada retiro (`app/covers.ts`), para verla sin red. Vive en
 * IndexedDB y se borra al cerrar la sesión de esa persona (`onSessionEnd`), portadas incluidas. Si IndexedDB no está
 * disponible (modo privado), todo sigue funcionando sin caché.
 */
const DB = 'ikisai-organizers';
/** Versión 2: el almacén `images` (portadas). `onupgradeneeded` crea los que faltan. */
const VERSION = 2;
const STORES = ['reads', 'drafts', 'images'] as const;
type Store = (typeof STORES)[number];

interface Entry<T> { key: string; userId: string; at: string; value: T }

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, VERSION);
      request.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'key' }).createIndex('userId', 'userId');
        }
      };
      request.onsuccess = () => {
        // Otra pestaña con una versión más nueva: se suelta la base para no bloquearla.
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => resolve(null);
      // Otra pestaña abierta con la versión anterior bloquea la subida: la app sigue sin caché, como sin IndexedDB.
      request.onblocked = () => resolve(null);
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
const imageKey = (userId: string, reservationId: string) => `${userId}|cover|${reservationId}`;

/** Portada guardada: el archivo del que salió, la imagen y los archivos anteriores que se probaron y no eran imagen. */
export interface CachedImage { fileId: string; blob: Blob; mime: string; skipped?: string[] }

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
  async image(userId: string, reservationId: string): Promise<CachedImage | null> {
    return (await get<CachedImage>('images', imageKey(userId, reservationId)))?.value ?? null;
  },
  saveImage(userId: string, reservationId: string, value: CachedImage): Promise<void> {
    return put('images', userId, imageKey(userId, reservationId), value);
  },
  dropImage(userId: string, reservationId: string): Promise<void> {
    return remove('images', imageKey(userId, reservationId));
  },
  /** Fin de la sesión de una persona en el dispositivo: fuera sus lecturas, borradores y portadas. */
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
