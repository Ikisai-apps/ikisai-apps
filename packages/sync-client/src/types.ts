/**
 * Contrato público de @ikisai/sync-client (ver docs/core/CONTRATO_SINCRONIZACION.md §5 y §6).
 * Este archivo lo fija Core; la implementación vive en el resto del paquete.
 */

export type RowId = string;
export type TableName = `${string}.${string}`;

/** Fila sincronizable: todas llevan las columnas del §2.1 del contrato. */
export interface SyncedRow {
  id: RowId;
  revision: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  deleted_at: string | null;
  [column: string]: unknown;
}

export type RowOperation =
  | { op: 'insert'; table: TableName; id: RowId; fields: Record<string, unknown> }
  | { op: 'update'; table: TableName; id: RowId; expectedRevision: number; fields: Record<string, unknown> }
  | { op: 'delete'; table: TableName; id: RowId; expectedRevision: number }
  | { op: 'restore'; table: TableName; id: RowId; expectedRevision: number; fields?: Record<string, unknown> }
  | { op: 'call'; procedure: string; args: Record<string, unknown> };

export interface CommandBatch {
  requestId: string;
  expectedCursor?: number | null;
  operations: RowOperation[];
  /** Hashes SHA-256 de los blobs que este lote referencia; se suben antes de enviar el lote. */
  blobs?: string[];
}

export interface ChangeRecord {
  cursor: number;
  seq: number;
  at: string;
  actorId: string | null;
  requestId: string | null;
  table: TableName;
  id: RowId;
  op: 'insert' | 'update' | 'delete' | 'restore' | 'purge';
  revision: number | null;
  after: SyncedRow | null;
}

export interface CommandResult {
  cursor: number;
  requestId: string;
  replayed?: boolean;
  results: Array<{ op: string; table?: TableName; id?: RowId; revision?: number; procedure?: string; result?: unknown }>;
  changes: ChangeRecord[];
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details: unknown;
}

export interface Bootstrap {
  app: string;
  cursor: number;
  serverTime: string;
  release: string;
  membership: { role: Role; scopes: unknown; revision: number };
  /** `houseLevel`: nivel de casa de la cuenta (Central), desde la 0.7.0 / migración 0092. */
  profile: { userId: string; displayName: string; kind: 'human' | 'agent'; houseLevel?: HouseLevel | null };
  tables: Array<{ table: TableName; writableColumns: string[]; readable: boolean; writable: boolean }>;
}

export interface Session {
  token: string;
  refreshToken: string;
  expiresAt: number; // epoch segundos
  /** Solo en `loginWithLink` (0.7.1): el ámbito del enlace canjeado (p. ej. `{reservation_id, guest_id}`). No se guarda. */
  grant?: unknown;
}

/** Conflicto que requiere decisión humana (campos solapados). */
export interface PendingConflict {
  requestId: string;
  operation: RowOperation & { op: 'update' | 'delete' };
  /** Fila tal y como la vio el usuario al editar. */
  base: SyncedRow | null;
  /** Fila actual en el servidor. */
  current: SyncedRow;
  /** Campos que el usuario cambió y que también cambió el servidor. */
  overlapping: string[];
  /** Si lo que chocó fue un `call` (p. ej. `invoices.validate`), su procedimiento (0.5.2). */
  procedure?: string;
  detectedAt: string;
}

/** Lote que el servidor rechazó con un error definitivo (4xx); espera corrección (`retryRejected`) o descarte (`discardRejected`). */
export interface RejectedBatch {
  requestId: string;
  operations: RowOperation[];
  /** Hashes SHA-256 de los blobs que el lote referenciaba. */
  blobs?: string[];
  /** Error completo devuelto por el servidor (o `BLOB_MISSING` si el lote referenciaba un adjunto inexistente). */
  error: ApiError;
  /** Filas tal y como estaban en el espejo al editar, por `schema.tabla|id` (null = no existía). */
  baseRows: Record<string, SyncedRow | null>;
  rejectedAt: string;
  /** Posición que tenía el lote en la cola; da un orden estable aunque dos rechazos compartan milisegundo. */
  seq?: number;
}

export type NetworkState = 'online' | 'offline' | 'syncing' | 'error';

export interface SyncStatus {
  network: NetworkState;
  cursor: number;
  pendingCommands: number;
  pendingBlobs: number;
  conflicts: number;
  lastPullAt: string | null;
  lastError: ApiError | null;
  autoMerged: number; // fusiones automáticas desde el arranque, para el aviso discreto
  /** Lotes rechazados por el servidor que esperan corrección o descarte. */
  rejected: number;
}

export interface SyncClientOptions {
  app: string;
  /** Prefijo de la API, normalmente '/api/v1'. */
  apiBase?: string;
  /** Tablas a mantener en el espejo local. Por defecto, todas las legibles del bootstrap. */
  tables?: TableName[];
  /** Nombre de la base IndexedDB; por defecto `ikisai-<app>-v1`. */
  databaseName?: string;
  /** Intervalo de pull en ms cuando hay red; 0 desactiva. */
  pullIntervalMs?: number;
  /**
   * Qué borrar al hacer `logout()`: `true` vacía espejo, outbox, conflictos, rechazados y blobs;
   * una lista vacía solo esas tablas (y lo que las referencia). Por defecto `false`: solo se borra la sesión.
   */
  clearOnLogout?: boolean | TableName[];
  /** Sesión única entre apps de ikisai.com: al arrancar sin sesión, intenta entrar con el pase común. Por defecto true. */
  sso?: boolean;
  /**
   * Cliente secundario (módulos del núcleo, p. ej. `resources` en `/api/v1/resources`): usa la sesión de otro cliente de la
   * misma app en lugar de tener la suya. No inicia ni cierra sesión: refresca a través del principal y, cuando el principal
   * cierra sesión, se cierra con él (aplicando `clearOnLogout`).
   */
  sessionFrom?: SessionSource;
  /** Inyectable para pruebas. */
  fetch?: typeof fetch;
  indexedDB?: IDBFactory;
  now?: () => number;
}

/** Lo que un cliente secundario necesita del principal (lo cumple cualquier `SyncClient`). */
export interface SessionSource {
  session(): Session | null;
  refreshSessionNow(): Promise<boolean>;
  onSessionEnd(listener: (userId: string) => void): () => void;
}

export interface SyncClient {
  /** Inicia sesión por email y contraseña (proxy de Supabase Auth). */
  login(email: string, password: string): Promise<Session>;
  /** Refresca la sesión ya mismo (lo usan los clientes secundarios). true si se refrescó. */
  refreshSessionNow(): Promise<boolean>;
  /** Portales (contrato §3.6): canjea el token de un enlace personal (`/i/<token>`) por una sesión. */
  loginWithLink(token: string): Promise<Session>;
  /** Portales (0108, 0.8.0): pide un código de un solo uso al correo. Responde igual exista o no la cuenta. */
  sendEmailCode(email: string): Promise<void>;
  /** Portales (0108, 0.8.0): canjea el código del correo por una sesión. */
  loginWithEmailCode(email: string, code: string): Promise<Session>;
  /** Entra con el pase de sesión única del dispositivo si existe (contrato §3.4); null si no hay pase o acceso. */
  trySso(): Promise<Session | null>;
  logout(): Promise<void>;
  session(): Session | null;

  /** Arranca: carga el espejo local, hace bootstrap si hay red y lanza el primer pull. */
  start(): Promise<Bootstrap | null>;
  stop(): void;
  bootstrap(): Bootstrap | null;
  /** Vuelve a pedir el bootstrap (rol, ámbitos, tablas) sin reiniciar; útil tras un cambio de permisos. */
  refreshBootstrap(): Promise<Bootstrap | null>;
  status(): SyncStatus;
  onStatus(listener: (status: SyncStatus) => void): () => void;
  /**
   * Fin de la sesión de una persona en este dispositivo: al cerrar sesión o al entrar otra persona. Lo usan el kit y las apps
   * para borrar lo local que no pertenece a nadie más (borradores y bandeja del feedback, contrato §3.7). Recibe su userId.
   */
  onSessionEnd(listener: (userId: string) => void): () => void;
  /** Se dispara cuando cambian filas de una tabla en el espejo local, por pull o por edición. */
  onTable(table: TableName, listener: (rows: SyncedRow[]) => void): () => void;

  /** Lectura del espejo local. */
  list(table: TableName, options?: { includeDeleted?: boolean }): Promise<SyncedRow[]>;
  get(table: TableName, id: RowId): Promise<SyncedRow | null>;

  /**
   * Edición optimista: aplica en local, encola el comando y devuelve el requestId.
   * `expectedRevision` de cada operación debe ser la revisión que la UI tenía al abrir la fila.
   */
  commit(operations: RowOperation[], options?: { requestId?: string; blobs?: Blob[] }): Promise<{ requestId: string }>;

  /** Sincroniza ahora: pull de cambios y push de la cola. */
  sync(): Promise<void>;

  conflicts(): Promise<PendingConflict[]>;
  /** Resuelve un conflicto: 'mine' reaplica mis campos sobre la fila actual, 'theirs' descarta mi comando, 'merge' envía los campos indicados. */
  resolveConflict(requestId: string, decision: { choice: 'mine' } | { choice: 'theirs' } | { choice: 'merge'; fields: Record<string, unknown> }): Promise<void>;

  /** Lotes rechazados por el servidor con un error definitivo, en orden de rechazo. */
  rejected(): Promise<RejectedBatch[]>;
  /** Reencola un lote rechazado con un `requestId` nuevo, opcionalmente con las operaciones corregidas. */
  retryRejected(requestId: string, operations?: RowOperation[]): Promise<{ requestId: string }>;
  /** Olvida un lote rechazado. */
  discardRejected(requestId: string): Promise<void>;

  /** Guarda un blob (ya recomprimido por la app) para subirlo cuando haya red; devuelve su sha256. */
  stageBlob(blob: Blob, meta: { filename: string; mime: string }): Promise<string>;
  /** URL firmada de corta duración para ver o descargar un archivo. */
  fileUrl(fileId: string): Promise<string>;

  /** Sugerencias (0.7.0): propuestas de personas que staff o dirección aprueba o descarta. Necesitan red. */
  suggest(input: SuggestionInput): Promise<Suggestion>;
  /** `mine` (por defecto): las propias, también de otra app con `app`. `pending` y `all`: las de la app, para quien decide. */
  suggestions(options?: { scope?: 'mine' | 'pending' | 'all'; app?: string; limit?: number; before?: string }): Promise<{ items: Suggestion[]; pendingCount: number | null }>;
  /** Antes y después del lote (o del lote corregido), sin escribir. */
  previewSuggestion(id: string, operations?: RowOperation[]): Promise<{ cursor: number; results: unknown[]; changes: unknown[] }>;
  /** Aprobar aplica el lote (o el corregido) como commit de quien aprueba; descartar admite comentario. */
  decideSuggestion(id: string, decision: 'approve' | 'reject', options?: { comment?: string; operations?: RowOperation[] }): Promise<Suggestion>;
  /** Retirar una propia pendiente. */
  withdrawSuggestion(id: string, options?: { app?: string }): Promise<Suggestion>;

  /** Llamada directa a la API (rutas propias de la app). Añade bearer, refresca sesión y mapea errores. */
  api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
}

/** Roles del núcleo. `outsider` (0.7.0): gente de fuera por trato personal; solo lee y escribe lo que cada app le abre. */
export type Role = 'reader' | 'outsider' | 'editor' | 'owner';
export type HouseLevel = 'direccion' | 'staff' | 'outsider';

export interface SuggestionInput {
  kind: string;
  summary: string;
  operations: RowOperation[];
  /** Datos libres para que la app pinte el detalle. */
  detail?: Record<string, unknown> | null;
  /** Otra app destino (p. ej. `food` desde Guests). */
  app?: string;
  requestId?: string;
}

export interface Suggestion {
  id: string;
  app: string;
  kind: string;
  label: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  operations: RowOperation[];
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  comment: string | null;
  author: { id: string; name: string };
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  appliedCursor: number | null;
  result: unknown[] | null;
  createdAt: string;
  updatedAt: string;
  replayed?: boolean;
}
