/**
 * Ikisai Tasks · rutas de consulta e intercambio (docs/tasks/API.md §6): tareas filtradas por REST, CSV, copia
 * portable y respaldo. Todas trabajan sobre el modelo anidado compuesto con lo que el usuario puede ver.
 */
import { createSync, fail, sha256Hex, type AppRoute, type RequestContext, type Supabase, type WorkerRoute, createStorage, type StorageAccess } from '../_kit/mod.ts';
import {
  ATTACHMENT_MIME, DomainError, PHOTO_MIME, PORTABLE_FORMAT, TABLES, checkPortableComments, checkPortableSettings, checkPortableTabs, chunkOperations, collectIds, compose, decompose,
  effectiveScopes, emptyDataset, exportCSV, importCSV, importNotices, importRows, isAdministrator, portableComments, portableSettings, portableSummary, remapComments, remapTabs,
  unzipStore, validateOperations, visibleRow, zipStore,
  type CsvCatalogs, type Dataset, type LegacyTab, type PersonOption, type PortableComment, type PortableManifest, type PortableSettings, type Role, type TradeOption, type ZipEntry,
} from '../_domain/tasks/mod.ts';

const BUCKET = 'ikisai-files';
/** Carpeta de los paquetes de importación ya revisados; el nombre de cada uno es `<caducidad en segundos>.<sha256>.zip`. */
const IMPORTS = 'tasks/imports';
const IMPORT_NAME = /^(\d{9,11})\.([0-9a-f]{64})\.zip$/;
/** Margen tras la caducidad antes de borrar, por si una importación empezó justo antes de vencer. */
const IMPORT_GRACE_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const PAGE = 2000;
const GROUPS: Record<string, string> = { direccion: 'Toda la dirección', staff: 'Todo el staff', outsider: 'Todos los outsiders' };
type CoreFile = { bucket: string; path: string; status: string; storage_provider?: 'supabase' | 'r2'; sha256: string; mime: string; size: number; filename: string };

/** Ejecuta código de dominio y convierte sus errores al sobre de la API. */
function domain<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof DomainError) fail(error.status, error.code, error.message, error.details);
    throw error;
  }
}

const storagePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function exchangeRoutes(supabase: Supabase, storage: StorageAccess = createStorage(supabase)): AppRoute[] {
  /** Confirmaciones internas (importación): mismo `core.commit`, sin el `beforeCommit` que veta los `call` de clientes. */
  const internal = createSync(supabase, 'tasks', {});

  async function visibleData(ctx: RequestContext): Promise<Dataset> {
    const data = emptyDataset() as unknown as Record<string, unknown[]>;
    for (const table of TABLES) {
      const rows: Array<Record<string, unknown>> = [];
      for (let offset = 0; ; offset += 2000) {
        const page = await supabase.rpc<{ rows: Array<Record<string, unknown>> }>('core_snapshot_table', { p_app: 'tasks', p_role: ctx.membership.role, p_table: table, p_include_deleted: true, p_limit: 2000, p_offset: offset });
        rows.push(...page.rows);
        if (page.rows.length < 2000) break;
      }
      data[table] = rows.filter((row) => visibleRow(table, row, effectiveScopes(ctx.membership)));
    }
    return data as unknown as Dataset;
  }
  /** Los ajustes de origen de esta instalación (`tasks.settings`), para los avisos de la importación. */
  const settingsHere = async (ctx: RequestContext): Promise<PortableSettings> => {
    const page = await supabase.rpc<{ rows: Dataset['tasks.settings'] }>('core_snapshot_table', { p_app: 'tasks', p_role: ctx.membership.role, p_table: 'tasks.settings', p_include_deleted: false, p_limit: 100, p_offset: 0 });
    return portableSettings({ 'tasks.settings': page.rows });
  };
  const model = async (ctx: RequestContext) => { const data = await visibleData(ctx); return { data, tabs: compose(data, { scopes: effectiveScopes(ctx.membership) ?? '*' }) }; };
  const admin = (ctx: RequestContext) => { if (!isAdministrator({ role: ctx.membership.role as Role, scopes: effectiveScopes(ctx.membership), kind: ctx.bootstrap.profile.kind })) fail(403, 'FORBIDDEN', 'Se necesita un propietario con acceso a toda la app.'); };
  const findTab = (tabs: LegacyTab[], id: string | null) => tabs.find((t) => t.id === id) ?? fail(404, 'NOT_FOUND', 'No existe el área solicitada.');

  async function readFile(ctx: RequestContext, fileId: string, known?: CoreFile): Promise<Uint8Array> {
    // Archivos de core.files: por el proveedor que diga su fila (contrato §3.9). Los ZIP temporales de importación siguen
    // en el bucket de Tasks en Supabase Storage: no son archivos de core.files.
    const file = known ?? await supabase.rpc<CoreFile>('core_file_get', { p_app: 'tasks', p_actor: ctx.user.id, p_id: fileId });
    const response: Response = await storage.download(file);
    if (!response.ok) fail(503, 'STORAGE_UNAVAILABLE', 'No se pudo leer un archivo adjunto.');
    return new Uint8Array(await response.arrayBuffer());
  }
  async function writeObject(path: string, bytes: Uint8Array, mime: string): Promise<void> {
    const response: Response = await supabase.remote(`/storage/v1/object/${BUCKET}/${storagePath(path)}`, { service: true, method: 'POST', binary: bytes, headers: { 'Content-Type': mime, 'x-upsert': 'true' }, raw: true });
    if (!response.ok) fail(503, 'STORAGE_UNAVAILABLE', 'No se pudo guardar un archivo.');
  }

  /**
   * Catálogos de las fuentes activas para el CSV (2c): espacios de Recursos con su ruta corta, oficios de Central con su
   * ruta y personas de Central con su nombre e iniciales (y los tres grupos). Sin fuente activa, no se lee nada.
   */
  async function csvCatalogs(ctx: RequestContext, data: Dataset): Promise<CsvCatalogs> {
    const sources = portableSettings(data), out: CsvCatalogs = {};
    const pages = async <T>(name: string): Promise<T[]> => {
      const rows: T[] = [];
      try {
        for (let offset = 0; ; offset += PAGE) {
          const page = await internal.read(ctx, name, { limit: PAGE, offset }) as { rows?: T[]; total?: number } | null;
          if (!page || !Array.isArray(page.rows)) throw new Error('lectura sin filas');
          rows.push(...page.rows);
          if (page.rows.length < PAGE || rows.length >= Number(page.total ?? 0)) break;
        }
      } catch (error) {
        console.error('[tasks] ' + name, (error as Error)?.message);
        fail(503, 'CENTRAL_UNAVAILABLE', 'No se pudo leer Central para las columnas de oficios o personas. Inténtalo de nuevo más tarde.');
      }
      return rows;
    };
    if (sources.zoneSource === 'spaces') {
      const rows: Array<{ id: string; parent_id: string | null; kind: string; name: string; active: boolean; deleted_at: string | null }> = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await supabase.rpc<{ rows: typeof rows }>('core_snapshot_table', { p_app: 'resources', p_role: 'reader', p_table: 'resources.spaces', p_include_deleted: false, p_limit: PAGE, p_offset: offset });
        rows.push(...page.rows);
        if (page.rows.length < PAGE) break;
      }
      const byId = new Map(rows.filter((r) => !r.deleted_at).map((r) => [r.id, r]));
      const chain = (r: (typeof rows)[number]) => { const out = [r]; for (let up = r.parent_id ? byId.get(r.parent_id) : undefined; up && out.length < 20; up = up.parent_id ? byId.get(up.parent_id) : undefined) out.unshift(up); return out; };
      // La ruta corta es la de las chips (`spaceShort`): la madre y el espacio, salvo que la madre sea una altura.
      out.spaces = [...byId.values()].map((r) => {
        const up = r.parent_id ? byId.get(r.parent_id) : undefined;
        return { id: r.id, path: up && up.kind !== 'altura' ? `${up.name} › ${r.name}` : r.name, aliases: [chain(r).map((x) => x.name).join(' › ')], active: r.active };
      });
    }
    if (sources.tradeSource === 'central') out.trades = (await pages<TradeOption>('central.trade_options')).map((t) => ({ id: t.trade_id, path: t.path || t.name, name: t.name }));
    if (sources.peopleSource === 'central') {
      out.people = [
        ...Object.entries(GROUPS).map(([level, label]) => ({ key: `level:${level}`, label })),
        ...(await pages<PersonOption>('central.people_options')).filter((p) => p.active !== false)
          .map((p) => ({ key: p.person_id, label: p.initials ? `${p.name} (${p.initials})` : p.name, name: p.name, initials: p.initials ?? null })),
      ];
    }
    return out;
  }

  /** ZIP con el modelo visible, sus adjuntos vivos y (2c) los ajustes de origen y los comentarios con sus fotos. */
  async function bundle(ctx: RequestContext): Promise<Uint8Array> {
    const { data, tabs } = await model(ctx);
    const files = new Map<string, Uint8Array>();
    for (const row of data['tasks.attachments']) {
      if (row.deleted_at || files.has(row.sha256)) continue;
      const bytes = await readFile(ctx, row.file_id);
      if ((await sha256Hex(bytes)) !== row.sha256) fail(503, 'STORAGE_UNAVAILABLE', 'Un archivo adjunto no coincide con su huella.');
      files.set(row.sha256, bytes);
    }
    // Fotos de los comentarios: como los adjuntos, por su huella. Una foto que ya no está verificada no viaja.
    const photos = new Map<string, PortableComment['photo']>();
    for (const row of data['tasks.task_comments'] ?? []) {
      if (row.deleted_at || !row.file_id || photos.has(row.file_id)) continue;
      const file = await supabase.rpc<CoreFile>('core_file_get', { p_app: 'tasks', p_actor: ctx.user.id, p_id: row.file_id });
      if (file.status !== 'verified' || !PHOTO_MIME.includes(String(file.mime).toLowerCase())) { photos.set(row.file_id, null); continue; }
      if (!files.has(file.sha256)) {
        const bytes = await readFile(ctx, row.file_id, file);
        if ((await sha256Hex(bytes)) !== file.sha256) fail(503, 'STORAGE_UNAVAILABLE', 'La foto de un comentario no coincide con su huella.');
        files.set(file.sha256, bytes);
      }
      photos.set(row.file_id, { sha256: file.sha256, mime: String(file.mime).toLowerCase(), size: Number(file.size), name: file.filename });
    }
    const comments = portableComments(data, tabs, (fileId) => photos.get(fileId) ?? null);
    const dataBytes = encoder.encode(JSON.stringify({ tabs, settings: portableSettings(data), comments }));
    const manifest: PortableManifest = {
      format: PORTABLE_FORMAT, exportedAt: new Date().toISOString(), data: { path: 'data.json', sha256: await sha256Hex(dataBytes) },
      files: [...files].map(([sha, bytes]) => ({ path: `files/${sha}`, sha256: sha, size: bytes.length })),
    };
    const entries: ZipEntry[] = [{ path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest, null, 1)) }, { path: 'data.json', bytes: dataBytes }, ...[...files].map(([sha, bytes]) => ({ path: `files/${sha}`, bytes }))];
    return zipStore(entries);
  }
  const zipResponse = (bytes: Uint8Array, filename: string) => new Response(bytes as unknown as BodyInit, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename=${filename}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

  /**
   * Abre una copia: verifica manifiesto y huellas y devuelve el modelo, los archivos por huella y, si la copia es de la 2c
   * o posterior, sus ajustes de origen y sus comentarios (una copia anterior no los trae: `settings` nulo, sin comentarios).
   */
  async function openBundle(bytes: Uint8Array): Promise<{ tabs: LegacyTab[]; files: Map<string, Uint8Array>; comments: PortableComment[]; settings: PortableSettings | null }> {
    const entries = new Map(domain(() => unzipStore(bytes)).map((e) => [e.path, e.bytes]));
    let manifest: PortableManifest;
    try { manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json') ?? new Uint8Array())); } catch { fail(422, 'INVALID_BUNDLE', 'Copia inválida: falta el manifiesto.'); }
    if (manifest.format !== PORTABLE_FORMAT || !manifest.data || !Array.isArray(manifest.files)) fail(422, 'INVALID_BUNDLE', 'Copia inválida: formato desconocido.');
    const dataBytes = entries.get(manifest.data.path);
    if (!dataBytes || (await sha256Hex(dataBytes)) !== manifest.data.sha256) fail(422, 'INVALID_BUNDLE', 'Copia inválida: los datos no coinciden con su huella.');
    const files = new Map<string, Uint8Array>();
    for (const file of manifest.files) {
      const content = entries.get(file.path);
      if (!content || content.length !== file.size || (await sha256Hex(content)) !== file.sha256) fail(422, 'INVALID_BUNDLE', 'Copia inválida: un adjunto no coincide con su huella.');
      files.set(file.sha256, content);
    }
    let parsed: { tabs?: unknown; settings?: unknown; comments?: unknown };
    try { parsed = JSON.parse(new TextDecoder().decode(dataBytes)); } catch { fail(422, 'INVALID_BUNDLE', 'Copia inválida: datos ilegibles.'); }
    const tabs = domain(() => checkPortableTabs(parsed.tabs));
    const comments = domain(() => checkPortableComments(parsed.comments, tabs));
    for (const c of comments) if (c.photo && !files.has(c.photo.sha256)) fail(422, 'INVALID_BUNDLE', 'Copia inválida: falta la foto de un comentario.');
    for (const tab of tabs) for (const project of tab.projects) for (const a of [...(project.attachments ?? []), ...project.tasks.flatMap((t) => t.attachments ?? [])]) {
      if (!a.sha256 || !files.has(a.sha256)) fail(422, 'INVALID_BUNDLE', 'Copia inválida: falta un archivo adjunto.');
      if (!ATTACHMENT_MIME.includes(String(a.mime).toLowerCase())) fail(422, 'INVALID_BUNDLE', 'Copia inválida: tipo de adjunto no admitido.');
    }
    return { tabs, files, comments, settings: checkPortableSettings(parsed.settings) };
  }
  /** uuid determinista por copia e id de origen: reintentar la misma importación produce el mismo lote. */
  async function stableId(ticket: string, id: string): Promise<string> {
    const h = await sha256Hex(`${ticket}|${id}`);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  return [
    /** Tareas de un área con filtros (búsqueda, estado, disponibilidad, proyecto, etiquetas). */
    {
      method: 'GET', pattern: 'tabs/:tabId/tasks', handler: async ({ ctx, params, url }) => {
        const tab = findTab((await model(ctx)).tabs, params.tabId ?? null);
        const query = url.searchParams, q = (query.get('q') ?? '').toLocaleLowerCase(), labels = query.getAll('label'), state = query.get('state'), project = query.get('projectId'), availability = query.get('availability');
        if (availability && !['ready', 'blocked'].includes(availability)) fail(422, 'INVALID_FILTER', 'Disponibilidad: ready o blocked.');
        if (state && !['pending', 'done'].includes(state)) fail(422, 'INVALID_FILTER', 'Estado: pending o done.');
        const integer = (name: string, fallback: number) => { const v = query.get(name); if (v === null) return fallback; if (!/^\d+$/.test(v)) fail(422, 'INVALID_FILTER', 'Paginación inválida.'); return Number(v); };
        const labelText = new Map(tab.labels.map((l) => [l.id, l.text.toLocaleLowerCase()]));
        let items = tab.projects.flatMap((p) => p.tasks.map((t) => ({ ...t, projectId: p.id, projectAvailable: !p.deleted && p.status !== 'archived' })));
        items = items.filter((t) => (query.get('includeDeleted') === 'true' || !t.deleted)
          && (!q || `${t.text} ${t.note}`.toLocaleLowerCase().includes(q) || t.labels.some((l) => labelText.get(l)?.includes(q)))
          && (!labels.length || labels.some((l) => t.labels.includes(l)))
          && (!state || t.done === (state === 'done'))
          && (!project || t.projectId === project)
          && (!availability || (!t.done && t.projectAvailable && !!t.blocked === (availability === 'blocked'))));
        const offset = integer('offset', 0), limit = Math.max(1, Math.min(500, integer('limit', 100)));
        return { items: items.slice(offset, offset + limit).map(({ projectAvailable: _omit, ...t }) => t), total: items.length };
      },
    },
    {
      method: 'GET', pattern: 'csv', handler: async ({ ctx, url }) => {
        const { data, tabs } = await model(ctx);
        const tab = findTab(tabs, url.searchParams.get('tabId'));
        return new Response(exportCSV(tab, await csvCatalogs(ctx, data)), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=Ikisai-tareas.csv', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      },
    },
    /** No escribe: devuelve las operaciones de fila para que el cliente las confirme por `commands` (se pueden deshacer). */
    {
      method: 'POST', pattern: 'csv/preview', handler: async ({ ctx, url, request }) => {
        if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', 'Tu acceso es de solo lectura.');
        if (Number(request.headers.get('content-length') ?? 0) > 2 * 1024 * 1024) fail(413, 'PAYLOAD_TOO_LARGE', 'CSV máximo 2 MB.');
        const source = await request.text();
        const { data, tabs } = await model(ctx);
        const tab = findTab(tabs, url.searchParams.get('tabId'));
        if (tab.restricted) fail(403, 'FORBIDDEN', 'La importación exige edición de toda el área.');
        const catalogs = await csvCatalogs(ctx, data);
        const result = domain(() => importCSV(tab, source, undefined, catalogs));
        const batches = domain(() => decompose(data, tabs).flatMap((batch) => chunkOperations(batch)));
        if (batches.length !== 1) fail(422, 'CSV_TOO_LARGE', 'Demasiados elementos para un solo lote; divide el CSV.', { operations: batches.reduce((n, b) => n + b.length, 0) });
        domain(() => validateOperations(batches[0]!, { role: ctx.membership.role as Role, scopes: effectiveScopes(ctx.membership) }));
        return { operations: batches[0], ...result };
      },
    },
    /**
     * Vaciar papelera (contrato §11.2): pasa a la papelera lo que cuelga de contenedores borrados y después purga las
     * tablas en orden canónico inverso. Las dependencias hacia una tarea purgada desaparecen con ella.
     */
    {
      method: 'POST', pattern: 'trash/empty', handler: async ({ ctx, json }) => {
        admin(ctx);
        const body = await json();
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        const prepared = await internal.commit(ctx, { requestId: body.requestId, operations: [{ op: 'call', procedure: 'tasks.empty_trash_prepare', args: {} }] });
        const purged = await supabase.rpc<{ purged: number; cursor: number }>('core_purge_deleted', { p_app: 'tasks', p_actor: ctx.user.id, p_request_id: `${body.requestId}:purge`, p_tables: [...TABLES].reverse() });
        return { trashed: (prepared.results[0] as { result?: { trashed?: number } })?.result?.trashed ?? 0, purged: purged.purged, cursor: purged.cursor };
      },
    },
    /**
     * Convertir un área en proyecto de otra (§24.4): en un lote y con historial, las tareas vivas pasan con los mismos ids a
     * un proyecto nuevo del área de destino y el área de origen, vacía, va a la papelera. Solo la propietaria con acceso
     * completo, desde la app y tras la vista previa.
     */
    {
      method: 'POST', pattern: 'tabs/:tabId/convert', handler: async ({ ctx, params, json }) => {
        admin(ctx);
        const body = await json();
        const sourceTabId = String(params.tabId ?? '').toLowerCase();
        const targetTabId = typeof body.targetTabId === 'string' ? body.targetTabId.toLowerCase() : '';
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        if (!UUID.test(sourceTabId) || !UUID.test(targetTabId) || sourceTabId === targetTabId) fail(422, 'INVALID_OPERATION', 'Elige un área de destino distinta.');
        if (!title || title.length > 300) fail(422, 'INVALID_OPERATION', 'El proyecto necesita un nombre (hasta 300 caracteres).');
        const projectId = typeof body.projectId === 'string' && UUID.test(body.projectId) ? body.projectId.toLowerCase() : await stableId(body.requestId, sourceTabId);
        const committed = await internal.commit(ctx, { requestId: body.requestId, operations: [{ op: 'call', procedure: 'tasks.convert_tab_into_project', args: { sourceTabId, targetTabId, projectId, title } }] });
        const result = (committed.results[0] as { result?: { projectId: string; counts: Record<string, number> } })?.result;
        return { projectId: result?.projectId ?? projectId, counts: result?.counts ?? {}, cursor: committed.cursor };
      },
    },
    /**
     * Fusionar en General etiquetas repetidas entre áreas (FB_2026_023): `groups` son las que la propietaria marcó en la vista
     * previa, cada una con sus copias de cada área. En un lote y con historial; las copias quedan archivadas.
     */
    {
      method: 'POST', pattern: 'labels/general/merge', handler: async ({ ctx, json }) => {
        admin(ctx);
        const body = await json();
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        // Cada grupo: una lista de ids, o `{ ids, root }` (root: la General queda en la raíz aunque las madres difieran). Con un
        // solo id, «Hacer General».
        const ids = (g: unknown): unknown => (Array.isArray(g) ? g : g && typeof g === 'object' ? (g as { ids?: unknown }).ids : null);
        const groups = body.groups;
        if (!Array.isArray(groups) || !groups.length || groups.length > 500 || !groups.every((g: unknown) => { const list = ids(g); return Array.isArray(list) && list.length >= 1 && list.length <= 100 && list.every((id) => typeof id === 'string' && UUID.test(id)); })) {
          fail(422, 'INVALID_OPERATION', 'groups es una lista de grupos de etiquetas (uno o más ids por grupo).');
        }
        const normalized = groups.map((g: unknown) => { const list = (ids(g) as string[]).map((id) => id.toLowerCase()); return Array.isArray(g) ? list : { ids: list, root: !!(g as { root?: unknown }).root }; });
        const committed = await internal.commit(ctx, { requestId: body.requestId, operations: [{ op: 'call', procedure: 'tasks.merge_labels_into_general', args: { groups: normalized } }] });
        const result = (committed.results[0] as { result?: { generals: Record<string, string>; counts: Record<string, number> } })?.result;
        return { generals: result?.generals ?? {}, counts: result?.counts ?? {}, cursor: committed.cursor };
      },
    },
    /**
     * «Solo de un área» (FB_2026_035, migración 0343): una etiqueta General vuelve a ser de un área. Las demás áreas que la
     * usan se quedan con su copia (la viva igual, la archivada o una nueva). En un lote y con historial.
     */
    {
      method: 'POST', pattern: 'labels/general/to-area', handler: async ({ ctx, json }) => {
        admin(ctx);
        const body = await json();
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        if (typeof body.labelId !== 'string' || !UUID.test(body.labelId) || typeof body.tabId !== 'string' || !UUID.test(body.tabId)) fail(422, 'INVALID_OPERATION', 'Elige la etiqueta y el área.');
        const committed = await internal.commit(ctx, { requestId: body.requestId, operations: [{ op: 'call', procedure: 'tasks.general_label_to_area', args: { labelId: body.labelId.toLowerCase(), tabId: body.tabId.toLowerCase() } }] });
        const result = (committed.results[0] as { result?: { labelId: string; tabId: string; copies: Record<string, string>; counts: Record<string, number> } })?.result;
        return { labelId: result?.labelId ?? null, tabId: result?.tabId ?? body.tabId, copies: result?.copies ?? {}, counts: result?.counts ?? {}, cursor: committed.cursor };
      },
    },
    /**
     * Pasar las zonas a espacios de Recursos y su marcha atrás (R2, §30). Solo la propietaria con acceso completo, desde la
     * app y tras la vista previa (`read/tasks.zones_preview`). En un lote y con historial.
     * - `zones/to-spaces {requestId, remove?}`: `remove`, las zonas sin espacio que se quitan («Exteriores» a secas).
     * - `zones/to-labels {requestId, dropUnmapped?}`: con `dropUnmapped`, se pierden los espacios que no vienen de una zona.
     */
    {
      method: 'POST', pattern: 'zones/:direction', handler: async ({ ctx, params, json }) => {
        admin(ctx);
        const body = await json();
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        let operation;
        if (params.direction === 'to-spaces') {
          const remove = body.remove ?? [];
          if (!Array.isArray(remove) || remove.length > 500 || !remove.every((id: unknown) => typeof id === 'string' && UUID.test(id))) fail(422, 'INVALID_OPERATION', 'remove es una lista de ids de zona.');
          operation = { op: 'call' as const, procedure: 'tasks.zones_to_spaces', args: { remove: remove.map((id: string) => id.toLowerCase()) } };
        } else if (params.direction === 'to-labels') {
          operation = { op: 'call' as const, procedure: 'tasks.spaces_to_zones', args: { dropUnmapped: body.dropUnmapped === true } };
        } else {
          fail(404, 'NOT_FOUND', 'Ruta desconocida.');
        }
        const committed = await internal.commit(ctx, { requestId: body.requestId, operations: [operation!] });
        const result = (committed.results[0] as { result?: { source: string; counts: Record<string, number> } })?.result;
        return { source: result?.source, counts: result?.counts ?? {}, cursor: committed.cursor };
      },
    },
    { method: 'GET', pattern: 'portable', handler: async ({ ctx }) => zipResponse(await bundle(ctx), 'Ikisai-portable.zip') },
    { method: 'GET', pattern: 'backup', handler: async ({ ctx }) => { admin(ctx); return zipResponse(await bundle(ctx), 'Ikisai-respaldo.zip'); } },
    {
      method: 'POST', pattern: 'portable/preview', handler: async ({ ctx, request }) => {
        admin(ctx);
        if (Number(request.headers.get('content-length') ?? 0) > 32 * 1024 * 1024) fail(413, 'BUNDLE_TOO_LARGE', 'Máximo 32 MB.');
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > 32 * 1024 * 1024) fail(413, 'BUNDLE_TOO_LARGE', 'Máximo 32 MB.');
        const { tabs, comments, settings } = await openBundle(bytes);
        const expires = Math.floor(Date.now() / 1000) + 3600, ticket = `${expires}.${await sha256Hex(bytes)}`;
        await writeObject(`${IMPORTS}/${ticket}.zip`, bytes, 'application/zip');
        const here = await settingsHere(ctx);
        return { ticket, expiresAt: new Date(expires * 1000).toISOString(), summary: portableSummary(tabs, { comments, settings }), notices: importNotices(null, settings, here) };
      },
    },
    {
      method: 'POST', pattern: 'portable/import', handler: async ({ ctx, json }) => {
        admin(ctx);
        const body = await json();
        const match = typeof body.ticket === 'string' ? body.ticket.match(/^(\d{9,11})\.([0-9a-f]{64})$/) : null;
        if (!match || typeof body.requestId !== 'string') fail(422, 'INVALID_OPERATION', 'ticket y requestId son obligatorios.');
        if (Number(match[1]) < Date.now() / 1000) fail(409, 'IMPORT_UNAVAILABLE', 'La revisión ha caducado. Vuelve a elegir la copia.');
        const stored: Response = await supabase.remote(`/storage/v1/object/${BUCKET}/${storagePath(`${IMPORTS}/${body.ticket}.zip`)}`, { service: true, raw: true });
        if (!stored.ok) fail(409, 'IMPORT_UNAVAILABLE', 'La copia revisada ya no está disponible.');
        const bytes = new Uint8Array(await stored.arrayBuffer());
        if ((await sha256Hex(bytes)) !== match[2]) fail(409, 'IMPORT_UNAVAILABLE', 'La copia revisada no coincide con su huella.');
        const { tabs, files, comments, settings } = await openBundle(bytes);
        const ids = collectIds(tabs, comments), map = new Map<string, string>();
        for (const id of ids) map.set(id, await stableId(body.ticket, id));
        const copy = domain(() => remapTabs(tabs, map));
        const copiedComments = domain(() => remapComments(comments, map));
        // Adjuntos y fotos de comentarios: se reutiliza el archivo verificado con la misma huella si ya existe; si no, se sube y se verifica.
        const fileIds = new Map<string, string>();
        const meta = new Map<string, { name: string; mime?: string }>(copiedComments.flatMap((c) => (c.photo ? [[c.photo.sha256, { name: c.photo.name || 'foto', mime: c.photo.mime }] as const] : [])));
        for (const a of copy.flatMap((t) => t.projects.flatMap((p) => [...(p.attachments ?? []), ...p.tasks.flatMap((x) => x.attachments ?? [])]))) meta.set(a.sha256!, a);
        for (const [sha, content] of files) {
          const a = meta.get(sha);
          if (!a) continue;
          const file = await supabase.rpc<{ id: string; path: string; duplicateOf: string | null }>('core_file_create', { p_app: 'tasks', p_actor: ctx.user.id, p_bucket: BUCKET, p_filename: a.name, p_mime: String(a.mime).toLowerCase(), p_size: content.length, p_sha256: sha });
          if (file.duplicateOf && UUID.test(file.duplicateOf)) { fileIds.set(sha, file.duplicateOf); continue; }
          await writeObject(file.path, content, String(a.mime));
          await supabase.rpc('core_file_mark', { p_id: file.id, p_status: 'verified', p_size: content.length, p_hash_verified: true });
          fileIds.set(sha, file.id);
        }
        // Los ids de las filas puente también deben ser los mismos en un reintento: se derivan de la copia y de un contador.
        const seed = await sha256Hex(`${body.ticket}|filas`);
        let counter = 0;
        const nextId = () => `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-8${seed.slice(17, 20)}-${(counter++).toString(16).padStart(12, '0')}`;
        const rows = domain(() => importRows(copy, fileIds, nextId, copiedComments));
        const here = await settingsHere(ctx);
        const result = await internal.commit(ctx, { requestId: body.requestId, operations: [{ op: 'call', procedure: 'tasks.import_rows', args: { mode: 'portable', rows } }] });
        const done = (result.results[0] as { result?: { inserted?: unknown; dropped?: { spaces?: string[]; trades?: string[]; people?: string[] } } })?.result;
        const dropped = { spaces: done?.dropped?.spaces ?? [], trades: done?.dropped?.trades ?? [], people: done?.dropped?.people ?? [] };
        return { cursor: result.cursor, replayed: result.replayed ?? false, inserted: done?.inserted ?? null, dropped, notices: importNotices(dropped, settings, here) };
      },
    },
  ];
}

/**
 * Rutas de sistema (planificador de Core, `X-Ikisai-Worker-Key`). `POST worker/imports/cleanup` borra de Storage los
 * paquetes de importación vencidos: caducan en una hora y nada más los retira. Su nombre lleva la caducidad, así que
 * basta con listarlos; se borran por la API de Storage, que es la que elimina también el binario.
 */
export function exchangeWorkerRoutes(): WorkerRoute[] {
  return [{
    method: 'POST', pattern: 'imports/cleanup',
    handler: async ({ supabase }) => {
      const before = Math.floor(Date.now() / 1000) - IMPORT_GRACE_SECONDS;
      // Por nombre ascendente salen primero los más antiguos: si hubiera más de mil, la siguiente pasada sigue.
      const listed = await supabase.remote(`/storage/v1/object/list/${BUCKET}`, { service: true, method: 'POST', body: { prefix: IMPORTS, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } } });
      const names: string[] = (Array.isArray(listed) ? listed : []).map((object) => String(object?.name ?? ''));
      const expired = names.filter((name) => { const match = name.match(IMPORT_NAME); return !!match && Number(match[1]) < before; });
      if (expired.length) await supabase.remote(`/storage/v1/object/${BUCKET}`, { service: true, method: 'DELETE', body: { prefixes: expired.map((name) => `${IMPORTS}/${name}`) } });
      return { deleted: expired.length, kept: names.length - expired.length };
    },
  }];
}
