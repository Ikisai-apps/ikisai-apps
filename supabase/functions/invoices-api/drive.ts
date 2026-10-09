/**
 * Invoices · facturas recibidas que llegan por Google Drive (fase 4, docs/invoices/API.md §15).
 *
 * El usuario, la gestoría o un proveedor (por reenvío) deja PDF en la carpeta «Entrada» de la unidad compartida. Cada
 * tick del planificador (`POST /api/v1/worker/drive/tick`) lista unos pocos, y por cada uno:
 * 1. Si ya tiene registro (un tick murió antes de moverlo), solo lo mueve.
 * 2. Lo descarga; si no es un PDF real o pasa de 15 MB, a «Con errores».
 * 3. Si sus bytes ya son el documento de otra factura, a «Duplicadas».
 * 4. Lo lee como «Leer PDF» (texto con posiciones, plantillas del proveedor, reglas). Si el contenido ya está importado
 *    (huella del documento o proveedor + número), a «Duplicadas».
 * 5. Guarda el PDF como documento y crea la factura en un solo lote con la cuenta de servicio `drive`: pendiente de
 *    datos (sin fecha, proveedor provisional) y, si se leyó, `import_v1` sobre ella en el mismo lote (pendiente de
 *    revisión). Validar sigue siendo cosa de una persona.
 * 6. La mueve a «Importadas». Nunca se borra ni se manda a la papelera nada en Drive.
 *
 * Errores de Drive: credenciales o permisos (bloqueo: lo arregla una persona, el tick no insiste) o pasajeros (red, 5xx,
 * 429: el siguiente tick reintenta). Nada de la clave, el token ni el contenido del PDF va a registros.
 */
import {
  buildImportArgs, detectRectification, extractWithTemplates, negateDocument, findDuplicateImport, findDuplicateInvoice, importDocumentSha256, matchSupplier, softDuplicate,
  type ImportDocument, type InvoiceRow, type PdfTextItem, type SupplierRow, type TemplateLike,
} from '../_domain/invoices/mod.ts';

export const DRIVE_FOLDERS = ['Entrada', 'Importadas', 'Duplicadas', 'Con errores'] as const;
export type DriveFolder = (typeof DRIVE_FOLDERS)[number];
export const DRIVE_MAX_BYTES = 15 * 1024 * 1024;
export const DRIVE_PER_TICK = 5;
const MAX_PAGES = 10;
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile { id: string; name: string; mimeType: string; size: number | null; webViewLink: string | null }

/** Lo que el tick necesita de Drive (real con la cuenta de servicio o simulado en las pruebas). */
export interface DriveApi {
  /**
   * Id de una subcarpeta de la raíz. En una unidad compartida la crea si falta; en una carpeta de un usuario no puede
   * (la cuenta de servicio no tiene cuota de almacenamiento) y devuelve null.
   */
  folder(name: DriveFolder): Promise<string | null>;
  /** Id de la raíz (`INVOICES_DRIVE_ID`): sin «Entrada», los PDF sueltos en ella cuentan como entrada. */
  root(): string;
  /** Archivos de una carpeta, los más antiguos primero. */
  list(folderId: string, limit: number): Promise<DriveFile[]>;
  download(fileId: string): Promise<Uint8Array>;
  move(fileId: string, fromFolderId: string, toFolderId: string): Promise<void>;
  /** Llamadas hechas a la API desde que se creó (para `drive_runs.api_calls`). */
  calls?(): number;
}

export class DriveError extends Error {
  constructor(readonly kind: 'blocked' | 'recoverable' | 'gone', readonly code: string) { super(code); }
}

// ---------------------------------------------------------------------------
// Cliente real: Drive API v3 con un token de la cuenta de servicio (`createGoogleTokenSource` del kit)
// ---------------------------------------------------------------------------
export function createGoogleDriveApi(config: { driveId: string; accessToken: () => Promise<string>; fetch?: typeof fetch; timeoutMs?: number }): DriveApi {
  const transport = config.fetch ?? fetch;
  const API = 'https://www.googleapis.com/drive/v3';
  const all = 'supportsAllDrives=true';
  let calls = 0;

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    let token: string;
    try { token = await config.accessToken(); } catch (error) {
      const kind = (error as { kind?: string })?.kind === 'blocked' ? 'blocked' : 'recoverable';
      throw new DriveError(kind, 'DRIVE_AUTH');
    }
    let response: Response;
    calls += 1;
    try {
      response = await transport(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(config.timeoutMs ?? 30_000) });
    } catch { throw new DriveError('recoverable', 'DRIVE_NETWORK'); }
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 404) throw new DriveError('gone', 'DRIVE_NOT_FOUND');
    if (response.status === 401 || response.status === 403) {
      // 403 por cuota (rateLimitExceeded) también llega así; se trata como bloqueo solo si no es de cuota.
      throw new DriveError(response.headers.get('x-ratelimit') ? 'recoverable' : 'blocked', `DRIVE_${response.status}`);
    }
    throw new DriveError(response.status === 429 || response.status >= 500 ? 'recoverable' : 'blocked', `DRIVE_${response.status}`);
  }
  const q = (s: string) => encodeURIComponent(s);
  const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  // `INVOICES_DRIVE_ID` puede ser una unidad compartida o una carpeta compartida con la cuenta de servicio (9-10-2026):
  // buscar y listar con `corpora=allDrives` vale para las dos sin gastar llamadas en averiguarlo.
  const scope = `corpora=allDrives&includeItemsFromAllDrives=true&${all}`;
  let shared: Promise<boolean> | null = null;
  /** ¿Es una unidad compartida? Solo hace falta para decidir si se puede crear una subcarpeta que falta. */
  const isSharedDrive = () => (shared ??= (async () => {
    try { await (await call(`${API}/drives/${q(config.driveId)}?fields=id`)).body?.cancel(); return true; } catch (error) {
      if (error instanceof DriveError && error.kind === 'gone') return false;
      throw error;
    }
  })().catch((error) => { shared = null; throw error; }));

  return {
    calls: () => calls,
    root: () => config.driveId,
    async folder(name) {
      const query = `${quote(config.driveId)} in parents and name = ${quote(name)} and mimeType = ${quote(FOLDER_MIME)} and trashed = false`;
      const found = await (await call(`${API}/files?q=${q(query)}&${scope}&fields=files(id)&pageSize=1`)).json();
      if (found?.files?.[0]?.id) return String(found.files[0].id);
      if (!(await isSharedDrive())) return null; // carpeta de un usuario: la crea él
      const created = await (await call(`${API}/files?${all}&fields=id`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [config.driveId] }),
      })).json();
      return String(created.id);
    },
    async list(folderId, limit) {
      const query = `${quote(folderId)} in parents and trashed = false and mimeType != ${quote(FOLDER_MIME)}`;
      const body = await (await call(`${API}/files?q=${q(query)}&${scope}&orderBy=createdTime&pageSize=${limit}&fields=files(id,name,mimeType,size,webViewLink)`)).json();
      return (body?.files ?? []).map((f: Record<string, unknown>) => ({
        id: String(f.id), name: String(f.name ?? 'documento'), mimeType: String(f.mimeType ?? ''), size: f.size === undefined ? null : Number(f.size), webViewLink: typeof f.webViewLink === 'string' ? f.webViewLink : null,
      }));
    },
    async download(fileId) {
      return new Uint8Array(await (await call(`${API}/files/${q(fileId)}?alt=media&${all}`)).arrayBuffer());
    },
    async move(fileId, from, to) {
      await (await call(`${API}/files/${q(fileId)}?addParents=${q(to)}&removeParents=${q(from)}&${all}&fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).body?.cancel();
    },
  };
}

// ---------------------------------------------------------------------------
// Texto del PDF en el servidor: el mismo PDF.js que el dispositivo (6.4.299, compilación legacy, sin worker)
// ---------------------------------------------------------------------------
export async function readPdfItemsServer(bytes: Uint8Array): Promise<PdfTextItem[]> {
  // PDF.js 6 usa Promise.withResolvers (Deno y Node 22 lo tienen; Node 20, el de algunas pruebas locales, no).
  const P = Promise as unknown as { withResolvers?: () => unknown };
  P.withResolvers ??= () => { let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const items: PdfTextItem[] = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , c, d, e, f] = item.transform as number[];
        items.push({ str: item.str, page: n, x: e!, y: f!, w: item.width, h: item.height || Math.hypot(c!, d!) });
      }
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return items;
}

// ---------------------------------------------------------------------------
// El tick
// ---------------------------------------------------------------------------
export interface DriveSeen { drive_file_id: string; status: 'importada' | 'duplicada' | 'error'; invoice_id: string | null; moved_to: DriveFolder | null }

export interface DriveTickDeps {
  drive: DriveApi | null;
  /** Acciones de sistema de la migración 0224 (`invoices.drive_seen`, `drive_record`, `drive_finish`). */
  invoke(name: string, args: Record<string, unknown>): Promise<any>;
  /** Filas que la cuenta de servicio ve en Finance. */
  rows(): Promise<{ suppliers: SupplierRow[]; templates: TemplateLike[]; invoices: InvoiceRow[]; files: Array<{ invoice_id: string; file_id?: string; kind?: string; page_order?: number; sha256: string | null; deleted_at: string | null }> }>;
  /** Guarda el PDF como archivo verificado de Finance y devuelve su id. */
  storeFile(bytes: Uint8Array, name: string, sha256: string): Promise<string>;
  /** Lote con la cuenta de servicio y los hooks de Finance (requestId estable: repetirlo no duplica). */
  commit(requestId: string, operations: unknown[]): Promise<unknown>;
  /** Texto del documento para que «Validar» aprenda la plantilla sin volver a leer el PDF. */
  saveText(fileId: string, items: PdfTextItem[]): Promise<void>;
  readPdf(bytes: Uint8Array): Promise<PdfTextItem[]>;
  uuid(seed: string): Promise<string>;
  limit?: number;
  /** Aviso en Tasks › Gestiones (`POST worker/requests/task`, origen `invoices`); sin él, no se avisa. */
  notifyTasks?: (request: TasksDriveRequest) => Promise<boolean>;
  /** Hoy en Madrid (AAAA-MM-DD), inyectable en pruebas. */
  today?: () => string;
}

/** Petición a Tasks (contrato acordado con Core el 9-10-2026). */
export interface TasksDriveRequest {
  source: 'invoices'; kind: 'invoices.drive_review' | 'invoices.drive_blocked'; kind_label: string; external_ref: string;
  title: string; note: string; external_url: string; priority: 'normal' | 'high';
}
const FINANCE_URL = 'https://finance.ikisai.com';
const madridToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export interface DriveTickResult { outcome: 'ok' | 'not_configured' | 'blocked' | 'error'; listed: number; imported: number; read: number; duplicates: number; errors: number; api_calls: number; more: boolean; detail?: string | null }

/** Proveedor provisional de lo que llega sin leer: `import_v1` lo sustituye al leerlo después («Leer PDF», IA o JSON). */
export const UNIDENTIFIED_SUPPLIER = { name: 'Sin identificar (Drive)', slug: 'sin_identificar' };

const isPdf = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const objectFromName = (name: string) => (name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\s]+/g, ' ').trim() || 'factura de Drive').slice(0, 120);
const codeOf = (error: unknown) => String((error as { code?: unknown })?.code ?? (error as Error)?.message ?? 'ERROR').slice(0, 60);
const detailsOf = (error: unknown) => (error as { details?: Record<string, unknown> })?.details ?? {};

export async function runDriveTick(deps: DriveTickDeps): Promise<DriveTickResult> {
  const startedAt = new Date().toISOString();
  const result: DriveTickResult = { outcome: 'ok', listed: 0, imported: 0, read: 0, duplicates: 0, errors: 0, api_calls: 0, more: false, detail: null };
  const callsAtStart = deps.drive?.calls?.() ?? 0;
  const finish = async (folders?: Record<string, string>) => {
    result.api_calls = (deps.drive?.calls?.() ?? 0) - callsAtStart;
    await notify().catch(() => undefined);
    await deps.invoke('invoices.drive_finish', { started_at: startedAt, ...result, ...(folders ? { folders } : {}) });
    return result;
  };
  /** Aviso en Tasks: uno al día con lo pendiente de Drive (se actualiza con el recuento) o uno si Drive se bloquea. */
  const notify = async () => {
    if (!deps.notifyTasks) return;
    if (result.outcome === 'blocked') {
      await deps.notifyTasks({ source: 'invoices', kind: 'invoices.drive_blocked', kind_label: 'Finance · Drive bloqueado', external_ref: 'drive:blocked',
        title: 'Drive no puede importar facturas', note: `${result.detail ?? 'Drive rechaza la cuenta de servicio o falta una carpeta.'} Mientras tanto, las facturas de «Entrada» esperan.`,
        external_url: `${FINANCE_URL}/#/`, priority: 'high' });
      return;
    }
    if (result.outcome !== 'ok' || !result.imported) return;
    const data = await deps.rows();
    const pending = data.invoices.filter((i) => !i.deleted_at && i.drive_file_id && (i.status === 'pendiente_datos' || i.status === 'pendiente_revision'));
    const unread = pending.filter((i) => i.status === 'pendiente_datos').length;
    await deps.notifyTasks({ source: 'invoices', kind: 'invoices.drive_review', kind_label: 'Finance · Facturas por revisar', external_ref: `drive:${(deps.today ?? madridToday)()}`,
      title: `Revisar ${pending.length} factura${pending.length === 1 ? '' : 's'} llegada${pending.length === 1 ? '' : 's'} por Drive`,
      note: `Por revisar y validar: ${pending.length - unread} leída${pending.length - unread === 1 ? '' : 's'} y ${unread} sin leer (las completa Claude o la IA). En esta búsqueda: ${result.imported} nueva${result.imported === 1 ? '' : 's'}, ${result.duplicates} duplicada${result.duplicates === 1 ? '' : 's'}, ${result.errors} con errores.`,
      external_url: `${FINANCE_URL}/#/facturas?filtro=drive`, priority: 'normal' });
  };
  if (!deps.drive) { result.outcome = 'not_configured'; result.detail = 'Faltan GOOGLE_SERVICE_ACCOUNT_JSON o INVOICES_DRIVE_ID.'; return finish(); }
  const drive = deps.drive;
  const limit = deps.limit ?? DRIVE_PER_TICK;
  let folders: Record<string, string> = {};
  try {
    // Las carpetas se buscan (o crean) una vez y sus ids quedan en el estado: un tick sin archivos es una sola llamada.
    const cached = ((await deps.invoke('invoices.drive_seen', { drive_file_ids: [] }))?.state?.folders ?? {}) as Record<string, string>;
    const lookup = async () => {
      folders = {};
      for (const name of DRIVE_FOLDERS) { const id = await drive.folder(name); if (id) folders[name] = id; }
      if (!folders.Entrada) folders.Entrada = drive.root(); // sin «Entrada», los PDF sueltos en la raíz
    };
    // Con la raíz haciendo de «Entrada» se vuelve a buscar cada vez, por si el usuario la crea después.
    if (DRIVE_FOLDERS.every((name) => typeof cached[name] === 'string' && cached[name]) && cached.Entrada !== drive.root()) folders = { ...cached }; else await lookup();
    const missing = DRIVE_FOLDERS.filter((name) => name !== 'Entrada' && !folders[name]);
    if (missing.length) {
      result.outcome = 'blocked';
      result.detail = `Crea en tu carpeta de Drive estas subcarpetas: ${missing.join(', ')}. La cuenta de servicio no puede crearlas.`;
      return finish();
    }
    let listed: DriveFile[];
    try { listed = await drive.list(folders.Entrada!, limit + 1); } catch (error) {
      if (!(error instanceof DriveError && error.kind === 'gone')) throw error;
      await lookup(); // alguien movió o renombró las carpetas: se vuelven a buscar
      listed = await drive.list(folders.Entrada!, limit + 1);
    }
    result.more = listed.length > limit;
    const files = listed.slice(0, limit);
    result.listed = files.length;
    if (!files.length) return finish(folders);
    const seen = new Map<string, DriveSeen>(((await deps.invoke('invoices.drive_seen', { drive_file_ids: files.map((f) => f.id) }))?.seen ?? []).map((s: DriveSeen) => [s.drive_file_id, s]));
    let data = await deps.rows();
    const move = async (file: DriveFile, to: DriveFolder) => { await drive.move(file.id, folders.Entrada!, folders[to]!); };
    const record = (file: DriveFile, fields: Record<string, unknown>) => deps.invoke('invoices.drive_record', { drive_file_id: file.id, name: file.name, ...fields });

    for (const file of files) {
      // 1. Ya registrado: solo falta moverlo.
      const known = seen.get(file.id);
      if (known) {
        const to: DriveFolder = known.status === 'importada' ? 'Importadas' : known.status === 'duplicada' ? 'Duplicadas' : 'Con errores';
        await move(file, to);
        await record(file, { status: known.status, moved_to: to });
        continue;
      }
      const reject = async (reason: string, sha?: string) => {
        result.errors += 1;
        await record(file, { status: 'error', reason, sha256: sha ?? null });
        await move(file, 'Con errores');
        await record(file, { status: 'error', moved_to: 'Con errores' });
      };
      const duplicate = async (of: string | null, reason: string, sha: string) => {
        result.duplicates += 1;
        await record(file, { status: 'duplicada', duplicate_of: of, reason, sha256: sha });
        await move(file, 'Duplicadas');
        await record(file, { status: 'duplicada', moved_to: 'Duplicadas' });
      };
      // 2. Solo PDF real y de tamaño razonable.
      if (file.mimeType.startsWith('application/vnd.google-apps.')) { await reject('Documento de Google (no es un PDF): expórtalo a PDF y déjalo en «Entrada».'); continue; }
      if (file.size !== null && file.size > DRIVE_MAX_BYTES) { await reject('Pasa de 15 MB.'); continue; }
      let bytes: Uint8Array;
      try { bytes = await drive.download(file.id); } catch (error) {
        if (error instanceof DriveError && error.kind === 'gone') continue; // lo movieron o borraron a mano mientras tanto
        throw error;
      }
      if (bytes.length > DRIVE_MAX_BYTES) { await reject('Pasa de 15 MB.'); continue; }
      if (!isPdf(bytes)) { await reject('No es un PDF (solo se importan PDF).'); continue; }
      const sha = await sha256Hex(bytes);
      // 3. Mismos bytes que el documento de otra factura viva.
      const live = new Map(data.invoices.filter((i) => !i.deleted_at && i.status !== 'anulada').map((i) => [i.id, i]));
      const sameBytes = data.files.find((f) => !f.deleted_at && f.sha256 === sha && live.has(f.invoice_id));
      if (sameBytes) { await duplicate(sameBytes.invoice_id, 'Mismo archivo que otra factura.', sha); continue; }
      // 4. Lectura (como «Leer PDF»). Un PDF que no se abre (dañado o protegido) va a «Con errores».
      let items: PdfTextItem[];
      try { items = await deps.readPdf(bytes); } catch { await reject('No se pudo abrir el PDF (dañado o protegido).', sha); continue; }
      const extraction = extractWithTemplates(items, {
        suppliers: data.suppliers.filter((s) => !s.deleted_at).map((s) => ({ id: s.id, name: s.name, tax_id: s.tax_id })),
        templates: data.templates,
      });
      let document: ImportDocument | null = extraction.hasText && extraction.ok && extraction.document ? extraction.document : null;
      // Rectificativa (abono o devolución, 0227): por el texto o el total negativo; impresa en positivo, se importa en negativo.
      const rectification = document ? detectRectification({ text: items.map((i) => i.str).join('\n'), document }) : null;
      if (document && rectification?.isRectification && document.document_totals.total > 0) document = negateDocument(document);
      let documentSha: string | null = null;
      let supplierMode: { mode: 'existing'; id: string } | { mode: 'create'; id: string } | null = null;
      if (document) {
        documentSha = await importDocumentSha256(document);
        const best = matchSupplier(document, data.suppliers)[0];
        supplierMode = best && best.score >= 0.8 ? { mode: 'existing', id: best.supplier.id } : { mode: 'create', id: await deps.uuid(`drive-supplier:${file.id}`) };
        const dup = findDuplicateImport(documentSha, data.invoices)
          ?? findDuplicateInvoice(document, supplierMode.mode === 'existing' ? supplierMode.id : null, data.invoices)
          // Mismo proveedor, fecha y total solo cuenta como duplicada si el documento no trae número (con número distinto es otra factura).
          ?? (supplierMode.mode === 'existing' && !document.invoice.invoice_number?.trim() ? softDuplicate(data.invoices, { supplier_id: supplierMode.id, invoice_date: document.invoice.invoice_date, total: document.document_totals.total }) : null);
        if (dup) { await duplicate(dup.id, `Ya está importada${dup.code ? ` (${dup.code})` : ''}.`, sha); continue; }
      }
      // 5. Documento y factura en un solo lote.
      const fileId = await deps.storeFile(bytes, file.name, sha);
      const invoiceId = await deps.uuid(`drive-invoice:${file.id}`);
      const placeholder = data.suppliers.find((s) => !s.deleted_at && s.slug === UNIDENTIFIED_SUPPLIER.slug);
      const placeholderId = placeholder?.id ?? await deps.uuid('drive-supplier:sin-identificar');
      const base: unknown[] = [
        ...(placeholder ? [] : [{ op: 'insert', table: 'invoices.suppliers', id: placeholderId, fields: { name: UNIDENTIFIED_SUPPLIER.name, slug: UNIDENTIFIED_SUPPLIER.slug } }]),
        { op: 'insert', table: 'invoices.invoices', id: invoiceId, fields: { supplier_id: placeholderId, invoice_date: null, object: objectFromName(file.name), drive_file_id: file.id, drive_url: file.webViewLink } },
        { op: 'insert', table: 'invoices.invoice_files', id: await deps.uuid(`drive-file:${file.id}`), fields: { invoice_id: invoiceId, file_id: fileId, original_filename: file.name.slice(0, 255), page_order: 1, kind: 'original', mime_type: 'application/pdf', size_bytes: bytes.length, sha256: sha } },
      ];
      let readOk = false;
      let reason: string | null = null;
      if (document && documentSha && supplierMode) {
        let n = 0;
        const importArgs = buildImportArgs({ document, documentSha256: documentSha, invoiceId, supplier: supplierMode, files: [], origin: 'pdf_text',
          overrides: rectification?.isRectification ? { invoice_kind: 'rectificativa', rectifies_number: rectification.number } : undefined,
          provenance: Object.fromEntries(Object.entries(extraction.provenance).map(([k, p]) => [k, { method: p.method, text: p.text, page: p.page, confidence: p.confidence }])), uuid: () => `${invoiceId.slice(0, 24)}${(++n).toString(16).padStart(12, '0')}` });
        try {
          await deps.commit(`drive-${file.id}`, [...base, { op: 'call', procedure: 'invoices.import_v1', args: importArgs }]);
          readOk = true;
        } catch (error) {
          const code = codeOf(error);
          if (code === 'DUPLICATE_INVOICE' || code === 'DUPLICATE_IMPORT') { await duplicate(String(detailsOf(error).invoice_id ?? '') || null, 'Ya está importada.', sha); continue; }
          reason = `Leída, pero no se pudo importar (${code}): revísala con «Leer PDF» o la IA.`;
        }
      } else {
        // Diagnóstico sin contenido (9-10-2026): páginas con texto, fragmentos y caracteres leídos.
        const pages = items.reduce((n, it) => Math.max(n, it.page), 0);
        const chars = items.reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0);
        const shape = `${pages} pág. con texto, ${items.length} fragmentos, ${chars} caracteres`;
        reason = !extraction.hasText ? `PDF sin texto (escaneado o foto; ${shape}): la completa Claude o la IA.` : `Sin leer del todo (falta ${extraction.missing.join(', ') || 'algún dato'}; ${shape}): la completa Claude, «Leer PDF» o la IA.`;
      }
      if (!readOk) await deps.commit(`drive-${file.id}-pendiente`, base);
      if (items.length) await deps.saveText(fileId, items).catch(() => undefined);
      result.imported += 1;
      if (readOk) result.read += 1;
      await record(file, { status: 'importada', invoice_id: invoiceId, sha256: sha, reason });
      await move(file, 'Importadas');
      await record(file, { status: 'importada', moved_to: 'Importadas' });
      data = await deps.rows(); // proveedores nuevos y la factura recién creada cuentan para los duplicados del siguiente
    }
    return finish(folders);
  } catch (error) {
    if (error instanceof DriveError) {
      result.outcome = error.kind === 'blocked' ? 'blocked' : 'error';
      result.detail = error.kind === 'blocked' ? `Drive rechaza la cuenta de servicio o la unidad (${error.code}).` : `Drive no respondió (${error.code}); se reintenta en el siguiente tick.`;
    } else {
      result.outcome = 'error';
      result.detail = `Error al importar (${codeOf(error)}); se reintenta en el siguiente tick.`;
    }
    result.more = true;
    return finish(Object.keys(folders).length ? folders : undefined);
  }
}

// ---------------------------------------------------------------------------
// Volver a leer (9-10-2026): los borradores de Drive que siguen en «Pendiente de datos», con el lector actual
// ---------------------------------------------------------------------------
export interface RereadResult { checked: number; read: number; items: Array<{ invoice_id: string; code: string | null; read: boolean; detail: string }> }

/**
 * Lee otra vez el documento guardado de cada borrador de Drive en «Pendiente de datos» (como mucho `limit`) y, si ahora
 * sale entero, lo completa en su sitio con `import_v1` (origen `pdf_text`, procedencia por campo). Nada se valida.
 * El detalle dice qué faltó y la forma del texto, nunca su contenido.
 */
export async function rereadDriveDrafts(deps: Pick<DriveTickDeps, 'rows' | 'commit' | 'readPdf' | 'saveText' | 'invoke'> & { fileBytes(fileId: string): Promise<Uint8Array>; limit?: number }): Promise<RereadResult> {
  const data = await deps.rows();
  // Rastro (9-10-2026): el registro de Drive guarda lo que dio cada relectura (lo ve el owner en Inicio).
  const trace = async (invoice: InvoiceRow, read: boolean, detail: string) => {
    if (!invoice.drive_file_id) return;
    await deps.invoke('invoices.drive_record', { drive_file_id: invoice.drive_file_id, name: invoice.object, status: 'importada', invoice_id: invoice.id, reason: `Relectura: ${read ? 'leída' : 'sin leer'}. ${detail}`.slice(0, 300) }).catch(() => undefined);
  };
  const drafts = data.invoices.filter((i) => !i.deleted_at && i.status === 'pendiente_datos' && i.drive_file_id).slice(0, deps.limit ?? 10);
  const result: RereadResult = { checked: drafts.length, read: 0, items: [] };
  for (const invoice of drafts) {
    const before = result.items.length;
    await processOne(invoice);
    const item = result.items[before];
    if (item) await trace(invoice, item.read, item.detail);
  }
  return result;

  async function processOne(invoice: InvoiceRow): Promise<void> {
    const file = data.files.filter((f) => !f.deleted_at && f.invoice_id === invoice.id && (f.kind ?? 'original') === 'original' && f.file_id).sort((a, b) => (a.page_order ?? 1) - (b.page_order ?? 1))[0];
    if (!file?.file_id) { result.items.push({ invoice_id: invoice.id, code: invoice.code, read: false, detail: 'Sin documento.' }); return; }
    let items: PdfTextItem[];
    try { items = await deps.readPdf(await deps.fileBytes(file.file_id)); } catch { result.items.push({ invoice_id: invoice.id, code: invoice.code, read: false, detail: 'No se pudo abrir el PDF.' }); return; }
    const extraction = extractWithTemplates(items, { suppliers: data.suppliers.filter((s) => !s.deleted_at).map((s) => ({ id: s.id, name: s.name, tax_id: s.tax_id })), templates: data.templates });
    const pages = items.reduce((n, it) => Math.max(n, it.page), 0);
    const chars = items.reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0);
    const shape = `${pages} pág. con texto, ${items.length} fragmentos, ${chars} caracteres`;
    if (!(extraction.hasText && extraction.ok && extraction.document)) {
      result.items.push({ invoice_id: invoice.id, code: invoice.code, read: false, detail: `${extraction.hasText ? `Falta ${extraction.missing.join(', ') || 'algún dato'}` : 'Sin texto'} (${shape}).` });
      return;
    }
    const rectification = detectRectification({ text: items.map((i) => i.str).join('\n'), document: extraction.document });
    const document = rectification.isRectification && extraction.document.document_totals.total > 0 ? negateDocument(extraction.document) : extraction.document;
    const documentSha = await importDocumentSha256(document);
    const best = matchSupplier(document, data.suppliers)[0];
    const supplier = best && best.score >= 0.8 ? { mode: 'existing' as const, id: best.supplier.id } : { mode: 'create' as const, id: crypto.randomUUID() };
    const dup = findDuplicateImport(documentSha, data.invoices.filter((i) => i.id !== invoice.id))
      ?? findDuplicateInvoice(document, supplier.mode === 'existing' ? supplier.id : null, data.invoices.filter((i) => i.id !== invoice.id));
    if (dup) { result.items.push({ invoice_id: invoice.id, code: invoice.code, read: false, detail: `Ya está importada como ${dup.code ?? 'otra factura'}: anula este borrador.` }); return; }
    let n = 0;
    const args = buildImportArgs({ document, documentSha256: documentSha, invoiceId: invoice.id, supplier, files: [], origin: 'pdf_text',
      provenance: Object.fromEntries(Object.entries(extraction.provenance).map(([k, p]) => [k, { method: p.method, text: p.text, page: p.page, confidence: p.confidence }])),
      overrides: rectification.isRectification ? { invoice_kind: 'rectificativa', rectifies_number: rectification.number } : undefined,
      uuid: () => `${invoice.id.slice(0, 24)}${(++n).toString(16).padStart(12, '0')}` });
    try {
      await deps.commit(`drive-reread-${invoice.id}-${documentSha.slice(0, 12)}`, [{ op: 'call', procedure: 'invoices.import_v1', args }]);
      await deps.saveText(file.file_id, items).catch(() => undefined);
      result.read += 1;
      const total = document.document_totals.total.toFixed(2).replace('.', ',');
      result.items.push({ invoice_id: invoice.id, code: invoice.code, read: true, detail: `Leída: ${document.invoice.supplier_name} · ${document.invoice.invoice_number ?? 'sin número'} · ${document.invoice.invoice_date} · total ${total} €.` });
    } catch (error) {
      result.items.push({ invoice_id: invoice.id, code: invoice.code, read: false, detail: `Leída, pero no se pudo importar (${codeOf(error)}).` });
    }
  }
}
