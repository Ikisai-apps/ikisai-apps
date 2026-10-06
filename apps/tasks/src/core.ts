/**
 * Ikisai Tasks · núcleo del adaptador (docs/tasks/API.md §13). Se empaqueta como script clásico `/sync-core.js`
 * y expone `window.IkisaiTasks`. Encapsula `@ikisai/sync-client` y el dominio compartido para que `sync.js`
 * (el pegamento con la interfaz heredada) trabaje con el modelo anidado de siempre:
 *
 *   espejo IndexedDB ──compose──▶ state.tabs ──(la interfaz edita)──▶ plan() ──decompose──▶ commit() ──▶ sync-client
 */
import { createSyncClient, type Bootstrap, type PendingConflict, type RejectedBatch, type RowOperation, type Session, type SyncClient, type SyncStatus, type TableName } from '@ikisai/sync-client';
import {
  DomainError, TABLES, adoptLegacyIds, allAccess, applyOperations, chunkOperations, compose, decompose, emptyDataset, validateOperations,
  type Dataset, type LegacyTab, type Operation, type Role,
} from '@ikisai/domain-tasks';

export interface CoreOptions {
  apiBase?: string;
  /** Solo lectura del espejo (pestaña secundaria): no arranca el ciclo de sincronización. */
  readOnly?: boolean;
  pullIntervalMs?: number;
}

const BLOCKERS_KEY = 'ikisai-tasks-blockers';

export class TasksCore {
  readonly client: SyncClient;
  /** Copia en memoria del espejo (incluida la papelera), con los cambios locales aún sin encolar aplicados. */
  data: Dataset = emptyDataset();
  /** Lotes locales entregados a `commit()` cuya escritura en la cola todavía no ha terminado. */
  localPending = 0;
  private listeners = new Set<(kind: 'data' | 'status') => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private started = false;
  private hidden: Record<string, number> | undefined;

  constructor(private readonly options: CoreOptions = {}) {
    this.client = createSyncClient({
      app: 'tasks',
      apiBase: options.apiBase ?? '/api/v1',
      tables: [...TABLES] as TableName[],
      clearOnLogout: true,
      pullIntervalMs: options.readOnly ? 0 : options.pullIntervalMs ?? 20000,
    });
    try { this.hidden = JSON.parse(localStorage.getItem(BLOCKERS_KEY) ?? 'null') ?? undefined; } catch { this.hidden = undefined; }
  }

  /** Avisa de cambios en los datos del espejo (`data`) o en el estado de sincronización (`status`). */
  onChange(listener: (kind: 'data' | 'status') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(kind: 'data' | 'status'): void {
    for (const listener of this.listeners) {
      try { listener(kind); } catch (error) { console.error(error); }
    }
  }

  /** Arranca: carga el espejo, se suscribe a sus cambios y (salvo en solo lectura) inicia la sincronización. */
  async start(): Promise<Bootstrap | null> {
    if (!this.started) {
      this.started = true;
      for (const table of TABLES) this.client.onTable(table as TableName, () => this.scheduleRefresh());
      this.client.onStatus(() => this.emit('status'));
    }
    const boot = this.options.readOnly ? this.client.bootstrap() : await this.client.start();
    await this.reload();
    if (!this.options.readOnly) void this.refreshBlockers();
    return boot ?? this.client.bootstrap();
  }

  session(): Session | null { return this.client.session(); }
  bootstrap(): Bootstrap | null { return this.client.bootstrap(); }
  status(): SyncStatus { return this.client.status(); }
  hasData(): boolean { return this.data['tasks.tabs'].length > 0; }

  async login(email: string, password: string): Promise<Bootstrap | null> {
    await this.client.login(email, password);
    return this.start();
  }

  async logout(): Promise<void> {
    await this.client.logout();
    this.data = emptyDataset();
    this.hidden = undefined;
    try { localStorage.removeItem(BLOCKERS_KEY); } catch { /* sin almacenamiento */ }
    this.emit('data');
  }

  /** Vuelve a leer todas las tablas del espejo. */
  async reload(): Promise<void> {
    const next = emptyDataset() as unknown as Record<string, unknown[]>;
    for (const table of TABLES) next[table] = await this.client.list(table as TableName, { includeDeleted: true });
    this.data = next as unknown as Dataset;
  }

  private scheduleRefresh(): void {
    this.dirty = true;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      // Mientras haya guardados locales en vuelo, el espejo aún no los contiene: se espera a que terminen.
      if (this.localPending > 0 || !this.dirty) return;
      this.dirty = false;
      try { await this.reload(); } catch (error) { console.error(error); return; }
      if (this.localPending > 0) { this.dirty = true; return; }
      this.emit('data');
    }, 0);
  }

  /**
   * Aplica ya el refresco pendiente, si lo hay: relee el espejo y avisa. Quien acaba de sincronizar la llama para
   * que, al volver, el modelo que ve la interfaz incluya lo recibido (el refresco normal va en un temporizador).
   */
  async settle(): Promise<void> {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    if (!this.dirty || this.localPending > 0) return;
    this.dirty = false;
    await this.reload();
    if (this.localPending > 0) { this.dirty = true; return; }
    this.emit('data');
  }

  /** Modelo anidado que usa la interfaz, compuesto desde la copia en memoria. */
  model(): LegacyTab[] {
    const scopes = this.client.bootstrap()?.membership.scopes;
    return compose(this.data, { scopes: scopes ?? '*', ...(allAccess(scopes) ? {} : { hiddenBlockers: this.hidden }) });
  }

  /**
   * Operaciones de fila que llevan el espejo al modelo editado, ya validadas como lo hará el servidor.
   * Lanza `DomainError` si el modelo no es válido. Puede ajustar ids del modelo (familias por defecto de un área nueva).
   */
  plan(tabs: LegacyTab[]): Operation[][] {
    adoptLegacyIds(tabs);
    const boot = this.client.bootstrap();
    const context = { role: (boot?.membership.role ?? 'reader') as Role, scopes: boot?.membership.scopes ?? '*' };
    const batches = decompose(this.data, tabs).flatMap((batch) => chunkOperations(batch));
    for (const batch of batches) validateOperations(batch, context);
    return batches;
  }

  /** Encola los lotes en orden. La copia en memoria se actualiza al instante; el espejo, al terminar cada escritura. */
  async commit(batches: Operation[][], requestId?: () => string): Promise<string[]> {
    if (!batches.length) return [];
    for (const batch of batches) this.data = applyOperations(this.data, batch);
    this.localPending += 1;
    this.emit('status');
    const ids: string[] = [];
    try {
      for (const batch of batches) {
        const result = await this.client.commit(batch as RowOperation[], requestId ? { requestId: requestId() } : {});
        ids.push(result.requestId);
      }
    } finally {
      this.localPending -= 1;
      this.scheduleRefresh();
      this.emit('status');
    }
    return ids;
  }

  /**
   * Sincroniza ahora. Si ya había un ciclo en marcha, `client.sync()` se limita a esperarlo y ese ciclo pudo leer los
   * cambios antes de lo que el llamante quiere ver: en ese caso se lanza otro al terminar.
   */
  async sync(): Promise<void> {
    const joined = this.client.status().network === 'syncing';
    await this.client.sync();
    if (joined) await this.client.sync();
  }
  conflicts(): Promise<PendingConflict[]> { return this.client.conflicts(); }
  resolveConflict(requestId: string, choice: 'mine' | 'theirs'): Promise<void> { return this.client.resolveConflict(requestId, { choice }); }
  rejected(): Promise<RejectedBatch[]> { return this.client.rejected(); }
  retryRejected(requestId: string): Promise<{ requestId: string }> { return this.client.retryRejected(requestId); }
  discardRejected(requestId: string): Promise<void> { return this.client.discardRejected(requestId); }
  stageBlob(blob: Blob, meta: { filename: string; mime: string }): Promise<string> { return this.client.stageBlob(blob, meta); }
  api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> { return this.client.api<T>(path, init); }

  /** Bloqueos privados (API.md §5.3): solo para accesos por proyecto; la última respuesta se conserva sin red. */
  async refreshBlockers(): Promise<void> {
    const boot = this.client.bootstrap();
    if (!boot || allAccess(boot.membership.scopes) || !this.client.session()) return;
    try {
      const result = await this.client.api<{ items: Array<{ taskId: string; hidden: number }> }>('/blockers');
      this.hidden = Object.fromEntries(result.items.map((item) => [item.taskId, item.hidden]));
      try { localStorage.setItem(BLOCKERS_KEY, JSON.stringify(this.hidden)); } catch { /* sin almacenamiento */ }
      this.emit('data');
    } catch { /* sin red: se conserva el último dato */ }
  }
}

const api = {
  create: (options?: CoreOptions) => new TasksCore(options),
  DomainError,
};

declare global {
  interface Window { IkisaiTasks: typeof api }
}
window.IkisaiTasks = api;
