/**
 * Envoltorio mínimo de IndexedDB en promesas, sin librerías.
 * No usa IDBKeyRange ni índices para no depender de globales que puedan faltar en Node.
 */

export const META_STORE = 'meta';
export const OUTBOX_STORE = 'outbox';
export const CONFLICTS_STORE = 'conflicts';
export const BLOBS_STORE = 'blobs';
export const REJECTED_STORE = 'rejected';

const FIXED_STORES: ReadonlyArray<{ name: string; keyPath: string }> = [
  { name: META_STORE, keyPath: 'key' },
  { name: OUTBOX_STORE, keyPath: 'requestId' },
  { name: CONFLICTS_STORE, keyPath: 'requestId' },
  { name: BLOBS_STORE, keyPath: 'sha256' },
  { name: REJECTED_STORE, keyPath: 'requestId' },
];

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB: petición fallida'));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB: transacción fallida'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB: transacción abortada'));
  });
}

/** Los stores de tabla se distinguen de los fijos porque llevan `schema.tabla`. */
export function isTableStore(name: string): boolean {
  return name.includes('.');
}

export class Database {
  private db: IDBDatabase | null = null;

  constructor(
    private readonly factory: IDBFactory,
    readonly name: string,
  ) {}

  get handle(): IDBDatabase {
    if (!this.db) throw new Error('IndexedDB: la base no está abierta; llama a start() primero');
    return this.db;
  }

  get isOpen(): boolean {
    return this.db !== null;
  }

  storeNames(): string[] {
    return Array.from(this.handle.objectStoreNames);
  }

  tableStores(): string[] {
    return this.storeNames().filter(isTableStore);
  }

  /** Abre la base garantizando los stores fijos y los de las tablas indicadas; sube de versión si falta alguno. */
  async open(tables: string[] = []): Promise<void> {
    if (!this.db) this.db = await this.openVersion(undefined, tables);
    await this.ensureStores(tables);
  }

  /** Garantiza los stores fijos (también los añadidos en versiones posteriores del paquete) y los de las tablas indicadas. */
  async ensureStores(tables: string[]): Promise<void> {
    const current = this.handle;
    const wanted = [...FIXED_STORES.map((s) => s.name), ...tables];
    const missing = wanted.filter((t) => !current.objectStoreNames.contains(t));
    if (missing.length === 0) return;
    await this.reopen(current.version + 1, tables, []);
  }

  /** Elimina stores de tabla (p. ej. tablas que dejaron de ser legibles). */
  async dropStores(tables: string[]): Promise<void> {
    const current = this.handle;
    const present = tables.filter((t) => isTableStore(t) && current.objectStoreNames.contains(t));
    if (present.length === 0) return;
    await this.reopen(current.version + 1, [], present);
  }

  private async reopen(version: number, create: string[], drop: string[]): Promise<void> {
    this.handle.close();
    this.db = null;
    this.db = await this.openVersion(version, create, drop);
  }

  private openVersion(version: number | undefined, tables: string[], drop: string[] = []): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = version === undefined ? this.factory.open(this.name) : this.factory.open(this.name, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const store of FIXED_STORES) {
          if (!db.objectStoreNames.contains(store.name)) db.createObjectStore(store.name, { keyPath: store.keyPath });
        }
        for (const table of tables) {
          if (!db.objectStoreNames.contains(table)) db.createObjectStore(table, { keyPath: 'id' });
        }
        for (const table of drop) {
          if (db.objectStoreNames.contains(table)) db.deleteObjectStore(table);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          if (this.db === db) this.db = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB: no se pudo abrir la base'));
      req.onblocked = () => reject(new Error('IndexedDB: apertura bloqueada por otra pestaña'));
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    const tx = this.handle.transaction(store, 'readonly');
    return (await request(tx.objectStore(store).get(key))) as T | undefined;
  }

  async getAll<T>(store: string): Promise<T[]> {
    const tx = this.handle.transaction(store, 'readonly');
    return (await request(tx.objectStore(store).getAll())) as T[];
  }

  async count(store: string): Promise<number> {
    const tx = this.handle.transaction(store, 'readonly');
    return request(tx.objectStore(store).count());
  }

  async put<T>(store: string, value: T): Promise<void> {
    const tx = this.handle.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await transactionDone(tx);
  }

  async delete(store: string, key: IDBValidKey): Promise<void> {
    const tx = this.handle.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await transactionDone(tx);
  }

  async clear(store: string): Promise<void> {
    const tx = this.handle.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    await transactionDone(tx);
  }

  /** Vacía varios stores en una sola transacción. */
  async clearMany(stores: string[]): Promise<void> {
    const present = Array.from(new Set(stores)).filter((s) => this.handle.objectStoreNames.contains(s));
    if (present.length === 0) return;
    const tx = this.handle.transaction(present, 'readwrite');
    for (const s of present) tx.objectStore(s).clear();
    await transactionDone(tx);
  }

  /**
   * Varias escrituras en una sola transacción. `value === null` borra la clave.
   * Todo lo que haya que calcular se calcula antes: dentro no se espera nada que no sea IndexedDB.
   */
  async writeMany(writes: Array<{ store: string; key?: IDBValidKey; value: unknown | null }>): Promise<void> {
    if (writes.length === 0) return;
    const stores = Array.from(new Set(writes.map((w) => w.store)));
    const tx = this.handle.transaction(stores, 'readwrite');
    for (const w of writes) {
      const os = tx.objectStore(w.store);
      if (w.value === null) {
        if (w.key === undefined) throw new Error(`IndexedDB: borrar en ${w.store} requiere clave`);
        os.delete(w.key);
      } else {
        os.put(w.value);
      }
    }
    await transactionDone(tx);
  }
}

export function resolveIndexedDB(injected?: IDBFactory): IDBFactory {
  const factory = injected ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory || typeof factory.open !== 'function') {
    throw new Error(
      'IndexedDB no está disponible en este entorno. Pasa `indexedDB` en SyncClientOptions (por ejemplo fake-indexeddb en pruebas).',
    );
  }
  return factory;
}
