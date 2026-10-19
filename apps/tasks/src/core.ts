/**
 * Ikisai Tasks · núcleo del adaptador (docs/tasks/API.md §13). Se empaqueta como script clásico `/sync-core.js`
 * y expone `window.IkisaiTasks`. Encapsula `@ikisai/sync-client` y el dominio compartido para que `sync.js`
 * (el pegamento con la interfaz heredada) trabaje con el modelo anidado de siempre:
 *
 *   espejo IndexedDB ──compose──▶ state.tabs ──(la interfaz edita)──▶ plan() ──decompose──▶ commit() ──▶ sync-client
 */
import { createSyncClient, type Bootstrap, type PendingConflict, type RejectedBatch, type RowOperation, type Session, type SyncClient, type SyncStatus, type TableName } from '@ikisai/sync-client';
import {
  DomainError, TABLES, adoptLegacyIds, allAccess, applyOperations, chunkOperations, compose, decompose, effectiveScopes, emptyDataset, validateOperations,
  assertLabelNames, generalMergeProblem, labelClashMessage, labelNameClash, labelNameKey,
  addCommentOps, commentCounts, deleteCommentOps, editCommentOps, taskComments,
  approvalOps, outsiderScopes, outsiderScopesFrom, outsiderScopesWith, suggestNoteOps, suggestStepOps, suggestTaskOps, type SuggestionDetail, type SuggestionPhoto,
  itemStock, isSupplyKind, lowStock, openRequestFor, receiptEntryOperation, requestPurchaseOps, reorderItemOps, setPurchaseStatusOps,
  receivePurchaseOps, nextRecurringOps, dueRecurring, preparePlanOps, deletePlanOps, KITCHEN_KINDS, type ResourceItem, type ResourceMovement,
  taskMaterials, addMaterialOps, setMaterialQuantityOps, removeMaterialOps, kitSuggestions, addKitOps, pendingConsumption, consumeCall, confirmConsumptionOps, materialRef,
  type TradeKitOption,
  pendingRequests, requestGroups, routeFor, routeTarget, classifyRequestOps, dismissRequestOps, reopenRequestOps, saveRouteOps, deleteRouteOps, routeWaitingOps,
  type Dataset, type LegacyTab, type Operation, type Role,
} from '@ikisai/domain-tasks';
import { availabilityOptionsFrom, capabilityOptionsFrom, hasApprentices, whoKnows, type AvailabilityOption, type CapabilityOption } from './who-knows.ts';

export { availabilityOptionsFrom, capabilityOptionsFrom, hasApprentices, whoKnows } from './who-knows.ts';
export type { AvailabilityOption, CapabilityOption, WhoKnows } from './who-knows.ts';

export interface CoreOptions {
  apiBase?: string;
  /** Solo lectura del espejo (pestaña secundaria): no arranca el ciclo de sincronización. */
  readOnly?: boolean;
  pullIntervalMs?: number;
}

/** Tablas del inventario de Recursos que sincroniza el segundo cliente (las que lee `createSyncItemSource` del kit). */
const RESOURCE_INVENTORY_TABLES = ['resources.items', 'resources.item_units', 'resources.item_kinds', 'resources.lots', 'resources.movements',
  'resources.movement_costs', 'resources.counts', 'resources.count_lines'];

/** Filas de `central.trade_kit_options` (`{rows}` o lista), solo las bien formadas. */
function tradeKitFrom(raw: unknown): TradeKitOption[] {
  const rows = Array.isArray(raw) ? raw : (raw as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is TradeKitOption => !!r && typeof r === 'object' && typeof (r as TradeKitOption).trade_id === 'string' && typeof (r as TradeKitOption).item_id === 'string')
    .map((r) => ({ trade_id: r.trade_id, item_id: r.item_id, quantity: r.quantity ?? null, note: r.note ?? null }));
}

/** Uuid estable a partir de un texto (la misma solicitud, la misma entrada en Recursos). */
async function stableUuid(seed: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BLOCKERS_KEY = 'ikisai-tasks-blockers';
const TRADES_KEY = 'ikisai-tasks-trades';
const TRADE_KIT_KEY = 'ikisai-tasks-trade-kit';

/** Fila de `central.trade_options` (P2, docs/tasks/API.md §32): oficios activos de Central con su ruta. */
export interface TradeOption {
  trade_id: string;
  parent_id: string | null;
  name: string;
  path: string | null;
  position: number;
  source_label_id: string | null;
}

/** Solo lo que la interfaz necesita de cada fila (descarta lo que no sea un oficio con id y nombre). */
export function tradeOptionsFrom(value: unknown): TradeOption[] {
  const list = Array.isArray(value) ? value : (value as { rows?: unknown[] } | null)?.rows;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).trade_id === 'string' && typeof (r as Record<string, unknown>).name === 'string')
    .map((r) => ({
      trade_id: r.trade_id as string, parent_id: typeof r.parent_id === 'string' ? r.parent_id : null, name: r.name as string,
      path: typeof r.path === 'string' ? r.path : null, position: Number(r.position ?? 0) || 0, source_label_id: typeof r.source_label_id === 'string' ? r.source_label_id : null,
    }));
}

const PEOPLE_KEY = 'ikisai-tasks-people';
const CAPABILITIES_KEY = 'ikisai-tasks-capabilities';
const AVAILABILITY_KEY = 'ikisai-tasks-availability';
/** Páginas de 2000 filas (el máximo de una lectura registrada); como mucho 10. */
const READ_PAGE = 2000;
const HOUSE_LEVELS = ['direccion', 'staff', 'outsider'] as const;

/** Fila de `central.people_options` (P2, PR 3; docs/tasks/API.md §33): personas activas de Central, con su nivel de casa. */
export interface PersonOption {
  person_id: string;
  name: string;
  user_id: string | null;
  active: boolean;
  house_level: 'direccion' | 'staff' | 'outsider' | null;
  initials: string | null;
}

/** Solo lo que la interfaz necesita de cada fila (descarta lo que no sea una persona con id y nombre). */
export function peopleOptionsFrom(value: unknown): PersonOption[] {
  const list = Array.isArray(value) ? value : (value as { rows?: unknown[] } | null)?.rows;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).person_id === 'string' && typeof (r as Record<string, unknown>).name === 'string')
    .map((r) => ({
      person_id: r.person_id as string, name: r.name as string, user_id: typeof r.user_id === 'string' ? r.user_id : null, active: r.active !== false,
      house_level: (HOUSE_LEVELS as readonly unknown[]).includes(r.house_level) ? r.house_level as PersonOption['house_level'] : null,
      initials: typeof r.initials === 'string' && r.initials.trim() ? r.initials.trim() : null,
    }));
}

export class TasksCore {
  readonly client: SyncClient;
  /**
   * Módulo común Recursos (R2, docs/resources/API.md): segundo cliente con la sesión del principal y su propio espejo
   * (`ikisai-resources-v1`). Lo usan los componentes de espacios del kit y, sin red, sigue sirviendo lo último leído.
   */
  resources: SyncClient | null = null;
  /** Espacios vivos del espejo de Recursos (para chips, filtros y agrupar, que se pintan sin esperar). */
  spaces: Array<Record<string, unknown>> = [];
  /**
   * Oficios activos de Central (P2): no se sincronizan, se leen con `central.trade_options`. La última respuesta queda en
   * el dispositivo, así que sin red se siguen viendo los nombres; si nunca se pudo leer, está vacía.
   */
  trades: TradeOption[] = [];
  /** Kit de cada oficio (R6 PR 3, `central.trade_kit_options`): como los oficios, la última respuesta queda en el dispositivo. */
  tradeKit: TradeKitOption[] = [];
  /**
   * Personas activas de Central (P2, PR 3): como los oficios, no se sincronizan; se leen con `central.people_options` y la
   * última respuesta queda en el dispositivo (sin red siguen saliendo los nombres y las iniciales).
   */
  people: PersonOption[] = [];
  /**
   * «Quién sabe hacerlo» (P2, PR 4): capacidades de Central (`central.capability_options`, el grado efectivo con la herencia
   * ya resuelta) y disponibilidad (`central.availability_options`, que el outsider no puede leer). Como las personas: no se
   * sincronizan y la última respuesta queda en el dispositivo.
   */
  capabilities: CapabilityOption[] = [];
  availability: AvailabilityOption[] = [];
  /** Copia en memoria del espejo (incluida la papelera), con los cambios locales aún sin encolar aplicados. */
  data: Dataset = emptyDataset();
  /** Lotes locales entregados a `commit()` cuya escritura en la cola todavía no ha terminado. */
  localPending = 0;
  private listeners = new Set<(kind: 'data' | 'status') => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private started = false;
  /** Ciclos de sincronización empezados (cada paso a `syncing`): dice si `sync()` se unió a uno que ya estaba en marcha. */
  private cycles = 0;
  /** Guardados locales empezados: dice si alguno empezó mientras se leía el espejo. */
  private commits = 0;
  private syncing = false;
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
    try { this.trades = tradeOptionsFrom(JSON.parse(localStorage.getItem(TRADES_KEY) ?? 'null')); } catch { this.trades = []; }
    try { this.tradeKit = tradeKitFrom(JSON.parse(localStorage.getItem(TRADE_KIT_KEY) ?? 'null')); } catch { this.tradeKit = []; }
    try { this.people = peopleOptionsFrom(JSON.parse(localStorage.getItem(PEOPLE_KEY) ?? 'null')); } catch { this.people = []; }
    try { this.capabilities = capabilityOptionsFrom(JSON.parse(localStorage.getItem(CAPABILITIES_KEY) ?? 'null')); } catch { this.capabilities = []; }
    try { this.availability = availabilityOptionsFrom(JSON.parse(localStorage.getItem(AVAILABILITY_KEY) ?? 'null')); } catch { this.availability = []; }
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
      for (const table of TABLES) this.client.onTable(table as TableName, (rows) => this.tableChanged(table, rows as unknown as Array<{ id: string; revision?: number }>));
      this.client.onStatus((status) => {
        const syncing = status.network === 'syncing';
        if (syncing && !this.syncing) this.cycles += 1;
        this.syncing = syncing;
        this.emit('status');
      });
    }
    const boot = this.options.readOnly ? this.client.bootstrap() : await this.client.start();
    await this.reload();
    if (!this.options.readOnly) void this.startResources();
    if (!this.options.readOnly) void this.refreshBlockers();
    // El kit, después de los oficios (una lectura cada vez).
    if (!this.options.readOnly && this.tradeSource() === 'central') void this.refreshTrades().then(() => this.refreshTradeKit());
    if (!this.options.readOnly && this.peopleSource() === 'central') void this.refreshPeople();
    if (!this.options.readOnly && this.tradeSource() === 'central' && this.peopleSource() === 'central') void this.refreshCapabilities();
    return boot ?? this.client.bootstrap();
  }

  /** De dónde sale la zona: `'labels'` (familia «Zona: Espacio») o `'spaces'` (Recursos), según `tasks.settings`. */
  zoneSource(): 'labels' | 'spaces' {
    const row = (this.data['tasks.settings'] ?? []).find((r) => r.key === 'zone_source' && !r.deleted_at);
    return row?.value === 'spaces' ? 'spaces' : 'labels';
  }

  /** De dónde sale la acción: `'labels'` (familia «Tipo: Acción») o `'central'` (oficios de Central, P2), según `tasks.settings`. */
  tradeSource(): 'labels' | 'central' {
    const row = (this.data['tasks.settings'] ?? []).find((r) => r.key === 'trade_source' && !r.deleted_at);
    return row?.value === 'central' ? 'central' : 'labels';
  }

  /** Vuelve a leer los oficios de Central y guarda la respuesta en el dispositivo. Sin red o sin permiso, se queda lo último leído. */
  async refreshTrades(): Promise<boolean> {
    if (!this.client.session()) return false;
    try {
      const out = await this.client.api<unknown>('/read/central.trade_options', { method: 'POST', json: { limit: 2000 } });
      this.trades = tradeOptionsFrom(out);
      try { localStorage.setItem(TRADES_KEY, JSON.stringify(this.trades)); } catch { /* sin almacenamiento */ }
      this.emit('data');
      return true;
    } catch { return false; }
  }

  /** Vuelve a leer el kit de los oficios (R6 PR 3). Sin red o sin permiso (el outsider no lo lee), se queda lo último leído. */
  async refreshTradeKit(): Promise<boolean> {
    if (!this.client.session()) return false;
    try {
      const out = await this.client.api<unknown>('/read/central.trade_kit_options', { method: 'POST', json: { limit: 2000 } });
      this.tradeKit = tradeKitFrom(out);
      try { localStorage.setItem(TRADE_KIT_KEY, JSON.stringify(this.tradeKit)); } catch { /* sin almacenamiento */ }
      this.emit('data');
      return true;
    } catch { return false; }
  }

  /**
   * «Confirmar consumo» (R6 PR 3): gasta en Recursos lo que se usó de cada material (`resources.consume`, `consumo_tarea`,
   * una sola vez por material aunque se repita). Va antes del lote de Tasks que lo apunta (lo envía la interfaz).
   */
  async recordConsumption(lines: ReadonlyArray<{ materialId: string; consumed: number }>): Promise<number> {
    const materials = new Map(this.data['tasks.task_materials'].filter((m) => !m.deleted_at).map((m) => [m.id, m]));
    const calls = lines.filter((l) => l.consumed > 0 && materials.has(l.materialId) && materials.get(l.materialId)!.consumed == null);
    if (!calls.length) return 0;
    if (!this.resources) throw new DomainError(503, 'RESOURCES_UNAVAILABLE', 'El inventario no está disponible ahora mismo.');
    const items = new Map(this.inventory.items.map((i) => [i.id, i]));
    for (const line of calls) {
      const material = materials.get(line.materialId)!;
      await this.resources.commit([consumeCall(material, line.consumed, items.get(material.item_id)?.default_space_id ?? null) as RowOperation], { requestId: `tasks-consume-${material.id}` });
    }
    return calls.length;
  }

  /** De dónde sale la persona: `'labels'` (familia «Grupo: Persona») o `'central'` (personas de Central, P2), según `tasks.settings`. */
  peopleSource(): 'labels' | 'central' {
    const row = (this.data['tasks.settings'] ?? []).find((r) => r.key === 'people_source' && !r.deleted_at);
    return row?.value === 'central' ? 'central' : 'labels';
  }

  /** Vuelve a leer las personas de Central y guarda la respuesta en el dispositivo. Sin red o sin permiso, se queda lo último leído. */
  async refreshPeople(): Promise<boolean> {
    if (!this.client.session()) return false;
    try {
      const out = await this.client.api<unknown>('/read/central.people_options', { method: 'POST', json: { limit: 2000 } });
      this.people = peopleOptionsFrom(out);
      try { localStorage.setItem(PEOPLE_KEY, JSON.stringify(this.people)); } catch { /* sin almacenamiento */ }
      this.emit('data');
      return true;
    } catch { return false; }
  }

  /** Lee todas las páginas de una lectura registrada (como mucho 10 de 2000 filas). */
  private async readAll(name: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (let page = 0; page < 10; page += 1) {
      const out = await this.client.api<unknown>(`/read/${name}`, { method: 'POST', json: page ? { limit: READ_PAGE, offset: page * READ_PAGE } : { limit: READ_PAGE } });
      const list = Array.isArray(out) ? out : (out as { rows?: unknown[] } | null)?.rows ?? [];
      rows.push(...list);
      if (list.length < READ_PAGE) break;
    }
    return rows;
  }

  /**
   * «Quién sabe hacerlo» (P2, PR 4): vuelve a leer las capacidades y la disponibilidad de Central y las guarda en el
   * dispositivo. Sin red, se queda lo último leído. La disponibilidad es aparte: si se niega (403, el outsider), se vacía y se
   * ordena solo por grado; si falla por otra cosa, se queda la última. Devuelve si se pudieron leer las capacidades.
   */
  async refreshCapabilities(): Promise<boolean> {
    if (!this.client.session()) return false;
    let ok = false;
    try {
      this.capabilities = capabilityOptionsFrom(await this.readAll('central.capability_options'));
      try { localStorage.setItem(CAPABILITIES_KEY, JSON.stringify(this.capabilities)); } catch { /* sin almacenamiento */ }
      ok = true;
    } catch { /* sin red o sin permiso: lo último leído */ }
    try {
      this.availability = availabilityOptionsFrom(await this.readAll('central.availability_options'));
      try { localStorage.setItem(AVAILABILITY_KEY, JSON.stringify(this.availability)); } catch { /* sin almacenamiento */ }
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 403 || status === 404) {
        this.availability = [];
        try { localStorage.removeItem(AVAILABILITY_KEY); } catch { /* sin almacenamiento */ }
      }
    }
    this.emit('data');
    return ok;
  }

  /** Arranca el cliente de Recursos (una vez por sesión). Un fallo no impide usar Tasks: los espacios salen vacíos. */
  async startResources(): Promise<void> {
    try {
      if (!this.resources) {
        this.resources = createSyncClient({
          app: 'resources', apiBase: `${this.options.apiBase ?? '/api/v1'}/resources`, sessionFrom: this.client, clearOnLogout: true,
          // Espacios (R2) e inventario común (R6): lo que leen `createSyncSpaceSource` y `createSyncItemSource` del kit.
          tables: ['resources.spaces', 'resources.space_kinds', ...RESOURCE_INVENTORY_TABLES] as TableName[],
          pullIntervalMs: this.options.pullIntervalMs ?? 20000,
        });
        this.resources.onTable('resources.spaces' as TableName, () => void this.readSpaces());
        for (const table of ['resources.items', 'resources.movements']) this.resources.onTable(table as TableName, () => void this.readInventory());
      }
      await this.resources.start();
      await this.readSpaces();
      await this.readInventory();
    } catch (error) { console.warn('Recursos no disponible', error); }
  }

  /** Artículos y movimientos del espejo de Recursos, para el aviso «Queda poco» de Inicio (síncrono en la interfaz). */
  inventory: { items: ResourceItem[]; movements: ResourceMovement[] } = { items: [], movements: [] };

  private async readInventory(): Promise<void> {
    if (!this.resources) return;
    const [items, movements] = await Promise.all([this.resources.list('resources.items' as TableName), this.resources.list('resources.movements' as TableName)]);
    this.inventory = { items: items as unknown as ResourceItem[], movements: movements as unknown as ResourceMovement[] };
    this.emit('data');
  }

  /**
   * La entrada en Recursos al recibir una solicitud de compra (R6): `entrada_manual` en `spaceId`, con id y requestId
   * estables por solicitud (repetirla no suma dos veces). Sin artículo o sin cantidad no hay entrada. Va antes del lote de
   * Tasks que la marca recibida (lo envía la interfaz). Devuelve si se apuntó ahora.
   */
  async recordReceipt(requestId: string, spaceId: string | null): Promise<boolean> {
    const request = this.data['tasks.purchase_requests'].find((r) => r.id === requestId && !r.deleted_at);
    if (!request) throw new DomainError(404, 'NOT_FOUND', 'No existe esa solicitud.');
    if (!request.item_id || !(Number(request.quantity) > 0)) return false;
    if (!this.resources) throw new DomainError(503, 'RESOURCES_UNAVAILABLE', 'El inventario no está disponible ahora mismo.');
    if (!spaceId) throw new DomainError(422, 'SPACE_REQUIRED', 'Elige dónde se guarda lo recibido.');
    const id = await stableUuid(`tasks-receipt:${request.id}`);
    if ((await this.resources.list('resources.movements' as TableName)).some((m) => (m as { id?: string }).id === id)) return false;
    await this.resources.commit([receiptEntryOperation(request, { id, spaceId }) as RowOperation], { requestId: `tasks-receipt-${request.id}` });
    return true;
  }

  private async readSpaces(): Promise<void> {
    if (!this.resources) return;
    this.spaces = (await this.resources.list('resources.spaces' as TableName)) as unknown as Array<Record<string, unknown>>;
    this.emit('data');
  }

  session(): Session | null { return this.client.session(); }
  bootstrap(): Bootstrap | null { return this.client.bootstrap(); }
  status(): SyncStatus { return this.client.status(); }
  /** Al cerrar sesión o cambiar de cuenta: el feedback y el uso borran lo local de esa cuenta. */
  onSessionEnd(listener: (userId: string) => void): () => void { return this.client.onSessionEnd(listener); }
  hasData(): boolean { return this.data['tasks.tabs'].length > 0; }

  async login(email: string, password: string): Promise<Bootstrap | null> {
    await this.client.login(email, password);
    return this.start();
  }

  async logout(): Promise<void> {
    await this.client.logout();
    this.data = emptyDataset();
    this.spaces = [];
    this.hidden = undefined;
    this.trades = [];
    this.people = [];
    this.capabilities = [];
    this.availability = [];
    try {
      for (const key of [BLOCKERS_KEY, TRADES_KEY, TRADE_KIT_KEY, PEOPLE_KEY, CAPABILITIES_KEY, AVAILABILITY_KEY]) localStorage.removeItem(key);
    } catch { /* sin almacenamiento */ }
    this.emit('data');
  }

  /** Vuelve a leer todas las tablas del espejo. */
  async reload(): Promise<void> {
    this.data = await this.read();
  }

  private async read(): Promise<Dataset> {
    const next = emptyDataset() as unknown as Record<string, unknown[]>;
    for (const table of TABLES) next[table] = await this.client.list(table as TableName, { includeDeleted: true });
    return next as unknown as Dataset;
  }

  /**
   * Refresco tras cambios del espejo. Si durante la lectura empezó un guardado local, lo leído se descarta: el espejo aún
   * no contiene ese guardado y, sobre todo, la interfaz no ha adoptado lo que llegó del servidor. Quedarse con esos
   * datos haría que el siguiente `plan()` comparase un modelo de interfaz antiguo con datos remotos nuevos y devolviera
   * a su valor anterior lo que cambió otro dispositivo (por ejemplo, el color de un área). Se reintenta al terminar.
   */
  /**
   * Los refrescos van en fila: el que pide `settle()` espera al que ya estaba leyendo el espejo. Antes `refresh()` marcaba
   * `dirty = false` antes de leer y, mientras leía, `settle()` volvía enseguida e `idle()` decía «en reposo» con el modelo
   * aún viejo (intermitente de la CI en ui.spec.ts «adjuntos del proyecto»: el otro dispositivo abría la ficha justo antes
   * de que llegara la fila del adjunto; registro de la PR #578).
   */
  private refreshing = 0;
  private refreshChain: Promise<unknown> = Promise.resolve();
  private refresh(): Promise<boolean> {
    this.refreshing += 1;
    const run = this.refreshChain.then(() => this.refreshNow()).finally(() => { this.refreshing -= 1; });
    this.refreshChain = run.catch(() => undefined);
    return run;
  }

  private async refreshNow(): Promise<boolean> {
    if (this.localPending > 0 || !this.dirty) return false;
    this.dirty = false;
    const started = this.commits;
    const next = await this.read();
    if (this.localPending > 0 || this.commits !== started) { this.dirty = true; return false; }
    this.data = next;
    this.emit('data');
    return true;
  }

  /**
   * Aviso del espejo con las filas vivas de una tabla (p. ej. al confirmar un comando). Solo se adelanta la **revisión**
   * de las filas que ya están en la copia en memoria, sin esperar al refresco completo: si no, una edición planificada en
   * ese hueco salía con la revisión vieja y acababa en conflicto (app.spec.ts en la CI de #571: borrar una vista recién
   * creada con `expectedRevision: 0`). Todo lo demás (filas nuevas, borradas o purgadas, campos) lo pone al día el
   * refresco de siempre: tocar más rompía «vaciar papelera».
   */
  private tableChanged(table: string, rows: Array<{ id: string; revision?: number }>): void {
    if (this.localPending === 0) {
      const fresh = new Map(rows.map((row) => [row.id, row.revision]));
      const current = ((this.data as unknown as Record<string, Array<{ id: string; revision?: number }>>)[table] ?? []);
      let changed = false;
      const merged = current.map((row) => {
        const revision = fresh.get(row.id);
        if (typeof revision !== 'number' || revision <= (row.revision ?? 0)) return row;
        changed = true;
        return { ...row, revision };
      });
      if (changed) this.data = { ...this.data, [table]: merged } as Dataset;
    }
    this.scheduleRefresh();
  }

  /** En reposo: sin refresco pendiente ni guardados locales en vuelo; la copia en memoria refleja el espejo. */
  idle(): boolean { return !this.dirty && !this.refreshTimer && this.localPending === 0 && this.refreshing === 0; }

  private scheduleRefresh(): void {
    this.dirty = true;
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(async () => {
      this.refreshTimer = null;
      // Mientras haya guardados locales en vuelo, el espejo aún no los contiene: se espera a que terminen.
      try { await this.refresh(); } catch (error) { console.error(error); }
    }, 0);
  }

  /**
   * Aplica ya el refresco pendiente, si lo hay: relee el espejo y avisa. Quien acaba de sincronizar la llama para
   * que, al volver, el modelo que ve la interfaz incluya lo recibido (el refresco normal va en un temporizador).
   */
  async settle(): Promise<void> {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    // Si hay un guardado local en vuelo, `refresh()` se retira (el espejo aún no lo contiene) y deja el refresco
    // pendiente: se espera a que termine y se reintenta, para no volver con el modelo viejo (intermitente de la CI,
    // ui.spec.ts «adjuntos del proyecto», 18-10-2026: el otro dispositivo recibía la fila y abría la ficha sin ella).
    for (let tries = 0; tries < 200; tries += 1) {
      if (await this.refresh() || !this.dirty) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Ámbitos efectivos de la cuenta (para el outsider, vacío o «*» es nada; O1). */
  scopes(): unknown {
    const membership = this.client.bootstrap()?.membership;
    return membership ? effectiveScopes(membership) : undefined;
  }

  /** Modelo anidado que usa la interfaz, compuesto desde la copia en memoria. */
  model(): LegacyTab[] {
    const scopes = this.scopes();
    return compose(this.data, { scopes: scopes ?? '*', ...(allAccess(scopes) ? {} : { hiddenBlockers: this.hidden }) });
  }

  /**
   * Operaciones de fila que llevan el espejo al modelo editado, ya validadas como lo hará el servidor.
   * Lanza `DomainError` si el modelo no es válido. Puede ajustar ids del modelo (familias por defecto de un área nueva).
   */
  plan(tabs: LegacyTab[]): Operation[][] {
    adoptLegacyIds(tabs);
    const boot = this.client.bootstrap();
    const context = { role: (boot?.membership.role ?? 'reader') as Role, scopes: this.scopes() ?? '*' };
    const batches = decompose(this.data, tabs).flatMap((batch) => chunkOperations(batch));
    // Regla de nombres de etiquetas (FB_2026_033): lo mismo que el hook, sobre lo que habrá al aplicar cada lote.
    let seen = this.data;
    batches.forEach((batch, i) => {
      validateOperations(batch, context);
      assertLabelNames(seen, batch);
      if (i < batches.length - 1) seen = applyOperations(seen, batch);
    });
    return batches;
  }

  /** Encola los lotes en orden. La copia en memoria se actualiza al instante; el espejo, al terminar cada escritura. */
  async commit(batches: Operation[][], requestId?: () => string): Promise<string[]> {
    if (!batches.length) return [];
    for (const batch of batches) this.data = applyOperations(this.data, batch);
    this.localPending += 1;
    this.commits += 1;
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
   * cambios antes de lo que el llamante quiere ver: en ese caso se lanza otro al terminar. «En marcha» incluye el final
   * de un ciclo que ya anunció `online` pero aún no ha devuelto: por eso se cuenta si empezó alguno tras la llamada.
   */
  async sync(): Promise<void> {
    const joined = this.syncing || this.client.status().network === 'syncing';
    const before = this.cycles;
    await this.client.sync();
    if (joined || this.cycles === before) await this.client.sync();
  }
  conflicts(): Promise<PendingConflict[]> { return this.client.conflicts(); }
  resolveConflict(requestId: string, choice: 'mine' | 'theirs'): Promise<void> { return this.client.resolveConflict(requestId, { choice }); }
  rejected(): Promise<RejectedBatch[]> { return this.client.rejected(); }
  retryRejected(requestId: string): Promise<{ requestId: string }> { return this.client.retryRejected(requestId); }
  discardRejected(requestId: string): Promise<void> { return this.client.discardRejected(requestId); }
  stageBlob(blob: Blob, meta: { filename: string; mime: string }): Promise<string> { return this.client.stageBlob(blob, meta); }

  /** Comentarios vivos de una tarea, del más antiguo al más reciente (O1, paso 2). */
  comments(taskId: string) { return taskComments(this.data, taskId); }
  /** Cuántos comentarios vivos tiene cada tarea. */
  commentCounts(): Map<string, number> { return commentCounts(this.data); }
  /**
   * Operaciones de un comentario nuevo, editado o borrado, ya validadas como lo hará el servidor (con el rol real: el
   * outsider también comenta). Lanza `DomainError` si no valen.
   */
  commentOps(action: 'add' | 'edit' | 'delete', input: { taskId?: string; commentId?: string; body?: string; photo?: { $blob: string } | null }): Operation[] {
    const ops = action === 'add' ? addCommentOps(this.data, input.taskId!, input.body ?? '', input.photo ?? null)
      : action === 'edit' ? editCommentOps(this.data, input.commentId!, input.body ?? '')
        : deleteCommentOps(this.data, input.commentId!);
    const boot = this.client.bootstrap();
    if (ops.length) validateOperations(ops, { role: (boot?.membership.role ?? 'reader') as Role, scopes: this.scopes() ?? '*' });
    return ops;
  }
  api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> { return this.client.api<T>(path, init); }

  /**
   * Propuestas del outsider (O1, paso 3; docs/tasks/API.md §31): el lote de una sugerencia, desde la copia en memoria.
   * 'tarea': tarea nueva en un proyecto (con lo que hereda y la foto); 'step': un paso de una tarea; 'note': una línea más
   * en su nota. Lanza `Error` con un texto para la persona si no vale. El servidor lo vuelve a comprobar al proponer.
   */
  suggestionOps(kind: 'tarea' | 'step' | 'note', input: { projectId?: string; taskId?: string; title?: string; note?: string; line?: string; photo?: SuggestionPhoto | null }): Operation[] {
    if (kind === 'tarea') return suggestTaskOps(this.data, { projectId: input.projectId!, title: input.title ?? '', note: input.note ?? '', photo: input.photo ?? null });
    if (kind === 'step') return suggestStepOps(this.data, { taskId: input.taskId!, title: input.title ?? '' });
    return suggestNoteOps(this.data, { taskId: input.taskId!, line: input.line ?? '' });
  }
  /** Lote para aprobar rehecho con lo de ahora (otro proyecto de destino, o la nota al día); `null` si vale el original. */
  approvalOps(detail: SuggestionDetail | null | undefined, operations: Operation[], options: { projectId?: string | null } = {}): Operation[] | null {
    return approvalOps(this.data, detail, operations, options);
  }
  /**
   * Ámbitos de un outsider (O1, paso 4) para `POST members {userId, role: 'outsider', scopes}` (C24): normalizados, con un
   * proyecto abierto o cerrado («Abrir a…»; `TAB_OPEN` si tiene el área entera) o elegidos en «Cuentas de personas».
   * Siempre un objeto `{tabs, projects}`: nunca «*» ni nulo.
   */
  outsiderScopes(scopes: unknown, change?: { tabId: string; projectId: string; open: boolean }) {
    return change ? outsiderScopesWith(scopes, change) : outsiderScopes(scopes);
  }
  outsiderScopesFrom(tabs: string[], projects: Record<string, string[]>) { return outsiderScopesFrom(tabs, projects); }
  /**
   * Sube una foto ya (las sugerencias no pasan por la cola: necesitan red) y la deja verificada. El servidor solo deja que
   * acabe en una propuesta de quien la sube (`tasks.suggestion_check`).
   */
  async uploadNow(blob: Blob, meta: { filename: string; mime: string }): Promise<SuggestionPhoto> {
    const bytes = await blob.arrayBuffer();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ticket = await this.client.api<{ id: string; uploadUrl: string; method?: string; headers?: Record<string, string> }>('/uploads', {
      json: { filename: meta.filename, mime: meta.mime, size: blob.size, sha256 },
    });
    const headers = new Headers(ticket.headers ?? {});
    if (!headers.has('Content-Type')) headers.set('Content-Type', meta.mime);
    const put = await fetch(ticket.uploadUrl, { method: ticket.method ?? 'PUT', headers, body: blob });
    if (!put.ok) throw new Error('No se pudo subir la foto.');
    const verified = await this.client.api<{ verified: boolean }>(`/uploads/${encodeURIComponent(ticket.id)}/verify`, { method: 'POST' });
    if (!verified?.verified) throw new Error('El servidor no pudo verificar la foto.');
    return { fileId: ticket.id, name: meta.filename, mime: meta.mime, size: blob.size, sha256 };
  }

  /**
   * ¿Ha cambiado la pertenencia en el servidor (rol o ámbitos)? Pasa, por ejemplo, cuando la propietaria abre un proyecto
   * a un outsider con «Abrir a…» (O1, paso 4). sync-client solo rehace el espejo al arrancar, así que, si cambió, se vuelve
   * a arrancar (compara la revisión de la pertenencia y repone lo que ahora es visible). Sin red o sin sesión, no hace nada.
   */
  async refreshMembership(): Promise<boolean> {
    if (this.options.readOnly || !this.client.session()) return false;
    const before = this.client.bootstrap()?.membership;
    let me: { role?: string; scopes?: unknown };
    try { me = await this.client.api<{ role?: string; scopes?: unknown }>('/me'); } catch { return false; }
    if (before && me.role === before.role && JSON.stringify(me.scopes ?? null) === JSON.stringify(before.scopes ?? null)) return false;
    await this.client.start();
    await this.reload();
    this.emit('data');
    return true;
  }

  /** Bloqueos privados (API.md §5.3): solo para accesos por proyecto; la última respuesta se conserva sin red. */
  async refreshBlockers(): Promise<void> {
    const boot = this.client.bootstrap();
    if (!boot || allAccess(this.scopes()) || !this.client.session()) return;
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
  /** Compras no alimentarias (§18): operaciones puras del dominio para la interfaz (`public/purchases-ui.js`). */
  purchases: {
    itemStock, isSupplyKind, lowStock, openRequestFor, requestPurchaseOps, reorderItemOps, setPurchaseStatusOps,
    receivePurchaseOps, nextRecurringOps, dueRecurring, preparePlanOps, deletePlanOps, validateOperations, KITCHEN_KINDS,
  },
  /** Regla de nombres de etiquetas (FB_2026_033, §27.2): el aviso inmediato del editor (`public/navigation-ui.js`) y,
   *  con `mergeProblem`, lo que la vista previa de «Repetidas → General» anticipa del servidor (`public/general-ui.js`). */
  labelNames: { key: labelNameKey, clash: labelNameClash, message: labelClashMessage, mergeProblem: generalMergeProblem },
  /** Materiales y equipos de una tarea, kit del oficio y «Confirmar consumo» (R6 PR 3, §36; `public/materials-ui.js`). */
  materials: { taskMaterials, addMaterialOps, setMaterialQuantityOps, removeMaterialOps, kitSuggestions, addKitOps, pendingConsumption, confirmConsumptionOps, materialRef },
  /** «Quién sabe hacerlo» (§34): quién sabe los oficios de una ficha (`public/who-knows-ui.js`). */
  whoKnows: { whoKnows, hasApprentices },
  /** Entradas de otras apps (§20): «Por clasificar» y reglas de entrada (`public/inbox-ui.js`). */
  requests: {
    pendingRequests, requestGroups, routeFor, routeTarget, classifyRequestOps, dismissRequestOps, reopenRequestOps, saveRouteOps, deleteRouteOps, routeWaitingOps,
  },
};

declare global {
  interface Window { IkisaiTasks: typeof api }
}
window.IkisaiTasks = api;
