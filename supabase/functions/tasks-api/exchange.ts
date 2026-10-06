/**
 * Ikisai Tasks · rutas de consulta e intercambio (docs/tasks/API.md §6): tareas filtradas por REST, CSV, copia
 * portable y respaldo. Todas trabajan sobre el modelo anidado compuesto con lo que el usuario puede ver.
 */
import { createSync, fail, sha256Hex, type AppRoute, type RequestContext, type Supabase } from '../_kit/mod.ts';
import {
  ATTACHMENT_MIME, DomainError, PORTABLE_FORMAT, TABLES, checkPortableTabs, chunkOperations, collectIds, compose, decompose, emptyDataset, exportCSV, importCSV,
  importRows, isAdministrator, portableSummary, remapTabs, unzipStore, validateOperations, visibleRow, zipStore,
  type Dataset, type LegacyTab, type PortableManifest, type Role, type ZipEntry,
} from '../_domain/tasks/mod.ts';

const BUCKET = 'ikisai-files';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

/** Ejecuta código de dominio y convierte sus errores al sobre de la API. */
function domain<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof DomainError) fail(error.status, error.code, error.message, error.details);
    throw error;
  }
}

const storagePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function exchangeRoutes(supabase: Supabase): AppRoute[] {
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
      data[table] = rows.filter((row) => visibleRow(table, row, ctx.membership.scopes));
    }
    return data as unknown as Dataset;
  }
  const model = async (ctx: RequestContext) => { const data = await visibleData(ctx); return { data, tabs: compose(data, { scopes: ctx.membership.scopes ?? '*' }) }; };
  const admin = (ctx: RequestContext) => { if (!isAdministrator({ role: ctx.membership.role as Role, scopes: ctx.membership.scopes, kind: ctx.bootstrap.profile.kind })) fail(403, 'FORBIDDEN', 'Se necesita un propietario con acceso a toda la app.'); };
  const findTab = (tabs: LegacyTab[], id: string | null) => tabs.find((t) => t.id === id) ?? fail(404, 'NOT_FOUND', 'No existe el área solicitada.');

  async function readFile(ctx: RequestContext, fileId: string): Promise<Uint8Array> {
    const file = await supabase.rpc<{ bucket: string; path: string; status: string }>('core_file_get', { p_app: 'tasks', p_actor: ctx.user.id, p_id: fileId });
    const response: Response = await supabase.remote(`/storage/v1/object/${file.bucket}/${storagePath(file.path)}`, { service: true, raw: true });
    if (!response.ok) fail(503, 'STORAGE_UNAVAILABLE', 'No se pudo leer un archivo adjunto.');
    return new Uint8Array(await response.arrayBuffer());
  }
  async function writeObject(path: string, bytes: Uint8Array, mime: string): Promise<void> {
    const response: Response = await supabase.remote(`/storage/v1/object/${BUCKET}/${storagePath(path)}`, { service: true, method: 'POST', binary: bytes, headers: { 'Content-Type': mime, 'x-upsert': 'true' }, raw: true });
    if (!response.ok) fail(503, 'STORAGE_UNAVAILABLE', 'No se pudo guardar un archivo.');
  }

  /** ZIP con el modelo visible y sus adjuntos vivos. */
  async function bundle(ctx: RequestContext): Promise<Uint8Array> {
    const { data, tabs } = await model(ctx);
    const files = new Map<string, Uint8Array>();
    for (const row of data['tasks.attachments']) {
      if (row.deleted_at || files.has(row.sha256)) continue;
      const bytes = await readFile(ctx, row.file_id);
      if ((await sha256Hex(bytes)) !== row.sha256) fail(503, 'STORAGE_UNAVAILABLE', 'Un archivo adjunto no coincide con su huella.');
      files.set(row.sha256, bytes);
    }
    const dataBytes = encoder.encode(JSON.stringify({ tabs }));
    const manifest: PortableManifest = {
      format: PORTABLE_FORMAT, exportedAt: new Date().toISOString(), data: { path: 'data.json', sha256: await sha256Hex(dataBytes) },
      files: [...files].map(([sha, bytes]) => ({ path: `files/${sha}`, sha256: sha, size: bytes.length })),
    };
    const entries: ZipEntry[] = [{ path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest, null, 1)) }, { path: 'data.json', bytes: dataBytes }, ...[...files].map(([sha, bytes]) => ({ path: `files/${sha}`, bytes }))];
    return zipStore(entries);
  }
  const zipResponse = (bytes: Uint8Array, filename: string) => new Response(bytes as unknown as BodyInit, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename=${filename}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

  /** Abre una copia: verifica manifiesto y huellas y devuelve el modelo y los archivos por huella. */
  async function openBundle(bytes: Uint8Array): Promise<{ tabs: LegacyTab[]; files: Map<string, Uint8Array> }> {
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
    let parsed: { tabs?: unknown };
    try { parsed = JSON.parse(new TextDecoder().decode(dataBytes)); } catch { fail(422, 'INVALID_BUNDLE', 'Copia inválida: datos ilegibles.'); }
    const tabs = domain(() => checkPortableTabs(parsed.tabs));
    for (const tab of tabs) for (const project of tab.projects) for (const a of [...(project.attachments ?? []), ...project.tasks.flatMap((t) => t.attachments ?? [])]) {
      if (!a.sha256 || !files.has(a.sha256)) fail(422, 'INVALID_BUNDLE', 'Copia inválida: falta un archivo adjunto.');
      if (!ATTACHMENT_MIME.includes(String(a.mime).toLowerCase())) fail(422, 'INVALID_BUNDLE', 'Copia inválida: tipo de adjunto no admitido.');
    }
    return { tabs, files };
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
        const tab = findTab((await model(ctx)).tabs, url.searchParams.get('tabId'));
        return new Response(exportCSV(tab), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=Ikisai-tareas.csv', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
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
        const result = domain(() => importCSV(tab, source));
        const batches = domain(() => decompose(data, tabs).flatMap((batch) => chunkOperations(batch)));
        if (batches.length !== 1) fail(422, 'CSV_TOO_LARGE', 'Demasiados elementos para un solo lote; divide el CSV.', { operations: batches.reduce((n, b) => n + b.length, 0) });
        domain(() => validateOperations(batches[0]!, { role: ctx.membership.role as Role, scopes: ctx.membership.scopes }));
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
    { method: 'GET', pattern: 'portable', handler: async ({ ctx }) => zipResponse(await bundle(ctx), 'Ikisai-portable.zip') },
    { method: 'GET', pattern: 'backup', handler: async ({ ctx }) => { admin(ctx); return zipResponse(await bundle(ctx), 'Ikisai-respaldo.zip'); } },
    {
      method: 'POST', pattern: 'portable/preview', handler: async ({ ctx, request }) => {
        admin(ctx);
        if (Number(request.headers.get('content-length') ?? 0) > 32 * 1024 * 1024) fail(413, 'BUNDLE_TOO_LARGE', 'Máximo 32 MB.');
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > 32 * 1024 * 1024) fail(413, 'BUNDLE_TOO_LARGE', 'Máximo 32 MB.');
        const { tabs } = await openBundle(bytes);
        const expires = Math.floor(Date.now() / 1000) + 3600, ticket = `${expires}.${await sha256Hex(bytes)}`;
        await writeObject(`tasks/imports/${ticket}.zip`, bytes, 'application/zip');
        return { ticket, expiresAt: new Date(expires * 1000).toISOString(), summary: portableSummary(tabs) };
      },
    },
    {
      method: 'POST', pattern: 'portable/import', handler: async ({ ctx, json }) => {
        admin(ctx);
        const body = await json();
        const match = typeof body.ticket === 'string' ? body.ticket.match(/^(\d{9,11})\.([0-9a-f]{64})$/) : null;
        if (!match || typeof body.requestId !== 'string') fail(422, 'INVALID_OPERATION', 'ticket y requestId son obligatorios.');
        if (Number(match[1]) < Date.now() / 1000) fail(409, 'IMPORT_UNAVAILABLE', 'La revisión ha caducado. Vuelve a elegir la copia.');
        const stored: Response = await supabase.remote(`/storage/v1/object/${BUCKET}/${storagePath(`tasks/imports/${body.ticket}.zip`)}`, { service: true, raw: true });
        if (!stored.ok) fail(409, 'IMPORT_UNAVAILABLE', 'La copia revisada ya no está disponible.');
        const bytes = new Uint8Array(await stored.arrayBuffer());
        if ((await sha256Hex(bytes)) !== match[2]) fail(409, 'IMPORT_UNAVAILABLE', 'La copia revisada no coincide con su huella.');
        const { tabs, files } = await openBundle(bytes);
        const ids = collectIds(tabs), map = new Map<string, string>();
        for (const id of ids) map.set(id, await stableId(body.ticket, id));
        const copy = domain(() => remapTabs(tabs, map));
        // Adjuntos: se reutiliza el archivo verificado con la misma huella si ya existe; si no, se sube y se verifica.
        const fileIds = new Map<string, string>();
        const meta = new Map(copy.flatMap((t) => t.projects.flatMap((p) => [...(p.attachments ?? []), ...p.tasks.flatMap((x) => x.attachments ?? [])])).map((a) => [a.sha256!, a]));
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
        const rows = domain(() => importRows(copy, fileIds, nextId));
        const result = await internal.commit(ctx, { requestId: body.requestId, operations: [{ op: 'call', procedure: 'tasks.import_rows', args: { mode: 'portable', rows } }] });
        return { cursor: result.cursor, replayed: result.replayed ?? false, inserted: (result.results[0] as { result?: { inserted?: unknown } })?.result?.inserted ?? null };
      },
    },
  ];
}
