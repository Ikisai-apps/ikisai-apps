/**
 * Invoices · facturas que llegan por Google Drive (fase 4, migración 0224, API.md §15): el tick con un Drive simulado,
 * la lectura real del PDF (PDF.js en Node, el mismo que la Edge) y el núcleo sobre PGlite. Nunca contra el Drive real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { createGoogleDriveApi, DriveError, readPdfItemsServer, type DriveApi, type DriveFile } from '../../supabase/functions/invoices-api/drive.ts';
import { invoiceTextPdf, textPdf } from './pdf-fixture.ts';

const WORKER_KEY = 'clave-de-worker-de-prueba';

class FakeDrive implements DriveApi {
  folders = new Map<string, string>();
  files = new Map<string, { file: DriveFile; parent: string; bytes: Uint8Array }>();
  count = 0;
  seq = 0;
  failMoves = 0;
  /** `false`: carpeta de un usuario (la cuenta de servicio no puede crear subcarpetas). */
  constructor(readonly canCreate = true, readonly rootId = 'carpeta-raiz', readonly inbox = 'carpeta-Entrada') {}
  calls() { return this.count; }
  root() { return this.rootId; }
  async folder(name: string) {
    this.count += 1;
    if (!this.folders.has(name)) { if (!this.canCreate) return null; this.folders.set(name, `carpeta-${name}`); }
    return this.folders.get(name)!;
  }
  async list(folderId: string, limit: number) {
    this.count += 1;
    return [...this.files.values()].filter((f) => f.parent === folderId).slice(0, limit).map((f) => f.file);
  }
  async download(id: string) { this.count += 1; const f = this.files.get(id); if (!f) throw new DriveError('gone', 'DRIVE_NOT_FOUND'); return f.bytes; }
  async move(id: string, _from: string, to: string) {
    this.count += 1;
    if (this.failMoves > 0) { this.failMoves -= 1; throw new DriveError('recoverable', 'DRIVE_503'); }
    this.files.get(id)!.parent = to;
  }
  add(name: string, bytes: Uint8Array, mimeType = 'application/pdf') {
    const id = `drv${++this.seq}`;
    this.files.set(id, { file: { id, name, mimeType, size: bytes.length, webViewLink: `https://drive.google.com/file/d/${id}/view` }, parent: this.inbox, bytes });
    return id;
  }
  where(id: string) { const parent = this.files.get(id)!.parent; return [...this.folders].find(([, v]) => v === parent)?.[0] ?? (parent === 'carpeta-Entrada' ? 'Entrada' : parent === this.rootId ? 'raíz' : parent); }
}

const drive = new FakeDrive();
let app: TestApp;
/** Avisos que Finance manda a Tasks › Gestiones. */
const notices: Array<Record<string, any>> = [];

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({
      ...config, origins: [INVOICES_ORIGINS[0]!], workerKey: WORKER_KEY,
      drive: { api: drive, limit: 5, upload: async (object, bytes) => { app.supabase.storage.set(object.path, bytes); },
        notifyTasks: async (request) => { notices.push(request); return true; }, today: () => '2026-10-09' },
    }),
  });
});

const tick = () => app.call('/api/v1/worker/drive/tick', { token: null, method: 'POST', body: {}, headers: { 'x-ikisai-worker-key': WORKER_KEY } });
async function rows(table: string) {
  const snap = await app.call(`/api/v1/snapshot?tables=${table}&includeDeleted=1`);
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  return snap.data.tables[0].rows as Array<Record<string, any>>;
}
const status = async () => (await app.call('/api/v1/read/invoices.drive_status', { body: {} })).data;
const withSuffix = (bytes: Uint8Array, text: string) => new Uint8Array([...bytes, ...new TextEncoder().encode(text)]);

test('Drive sin configurar: el tick lo registra y no hace nada', async () => {
  const off = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], workerKey: WORKER_KEY, drive: { api: null } }),
  });
  const res = await off.call('/api/v1/worker/drive/tick', { token: null, method: 'POST', body: {}, headers: { 'x-ikisai-worker-key': WORKER_KEY } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.outcome, 'not_configured');
  const st = (await off.call('/api/v1/read/invoices.drive_status', { body: {} })).data;
  assert.equal(st.state.health, 'not_configured');
  assert.equal((await off.call('/api/v1/worker/drive/tick', { token: null, method: 'POST', body: {} })).status, 401, 'sin la clave del worker');
});

test('Drive: PDF con texto → factura leída (pendiente de revisión) con su documento; duplicados por bytes y por contenido; escaneado sin leer; lo que no es PDF, a «Con errores»', async () => {
  const leida = drive.add('Factura Pepe septiembre.pdf', invoiceTextPdf('A-2026/0900'));
  const res = await tick();
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual({ outcome: res.data.outcome, listed: res.data.listed, imported: res.data.imported, read: res.data.read }, { outcome: 'ok', listed: 1, imported: 1, read: 1 });
  assert.ok(res.data.api_calls >= 3, 'cuenta las llamadas a la Drive API');
  // Aviso del día en Tasks › Gestiones
  const notice = notices.at(-1)!;
  assert.deepEqual([notice.source, notice.kind, notice.external_ref, notice.priority], ['invoices', 'invoices.drive_review', 'drive:2026-10-09', 'normal']);
  assert.equal(notice.title, 'Revisar 1 factura llegada por Drive');
  assert.equal(notice.external_url, 'https://finance.ikisai.com/#/facturas?filtro=drive');
  assert.equal(drive.where(leida), 'Importadas');
  const invoice = (await rows('invoices.invoices')).find((i) => i.drive_file_id === leida)!;
  assert.ok(invoice, 'factura con su origen en Drive');
  assert.equal(invoice.status, 'pendiente_revision');
  assert.equal(invoice.invoice_number, 'A-2026/0900');
  assert.equal(invoice.invoice_date, '2026-10-06');
  assert.equal(Number(invoice.source_total), 159);
  assert.equal(invoice.drive_url, `https://drive.google.com/file/d/${leida}/view`);
  assert.equal(invoice.import_meta.origin, 'pdf_text');
  assert.ok(Object.keys(invoice.import_meta.provenance ?? {}).length >= 3, 'procedencia por campo de la lectura');
  const supplier = (await rows('invoices.suppliers')).find((s) => s.id === invoice.supplier_id)!;
  assert.equal(supplier.tax_id, 'B12345674');
  const files = (await rows('invoices.invoice_files')).filter((f) => f.invoice_id === invoice.id);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.original_filename, 'Factura Pepe septiembre.pdf');
  assert.match(files[0]!.normalized_filename, /^2026_10_06_/);
  // El texto queda guardado para que «Validar» aprenda la plantilla sin volver a leer el PDF
  const text = (await app.t.db.query<{ n: number }>(`select count(*)::int n from invoices.document_texts where file_id = $1`, [files[0]!.file_id])).rows[0]!.n;
  assert.equal(text, 1);
  // Firmado por la cuenta de servicio
  const actor = (await app.t.db.query<{ name: string }>(`select coalesce(display_name, '') name from core.profiles where user_id = (select updated_by from invoices.invoices where id = $1)`, [invoice.id]).catch(() => ({ rows: [{ name: '' }] }))).rows[0]?.name ?? '';
  assert.ok(actor === '' || /Drive/.test(actor));

  // Mismos bytes: «Duplicadas», sin factura nueva
  const copia = drive.add('reenvio.pdf', invoiceTextPdf('A-2026/0900'));
  // Mismo contenido con otros bytes (otro envío del mismo PDF): «Duplicadas» por la huella del documento
  const otraCopia = drive.add('otra copia.pdf', withSuffix(invoiceTextPdf('A-2026/0900'), '\n% reenviado\n'));
  // Escaneado: se importa sin leer, en «Pendiente de datos», sin fecha y con el proveedor provisional
  const escaneada = drive.add('ticket escaneado.pdf', textPdf([]));
  // No es PDF y documento de Google
  const foto = drive.add('foto.pdf', new TextEncoder().encode('esto no es un pdf'));
  const doc = drive.add('Hoja de gastos', new Uint8Array(), 'application/vnd.google-apps.spreadsheet');
  const before = (await rows('invoices.invoices')).length;
  const second = await tick();
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.deepEqual({ listed: second.data.listed, imported: second.data.imported, read: second.data.read, duplicates: second.data.duplicates, errors: second.data.errors },
    { listed: 5, imported: 1, read: 0, duplicates: 2, errors: 2 });
  assert.deepEqual([copia, otraCopia, escaneada, foto, doc].map((id) => drive.where(id)), ['Duplicadas', 'Duplicadas', 'Importadas', 'Con errores', 'Con errores']);
  const after = await rows('invoices.invoices');
  assert.equal(after.length, before + 1);
  const pending = after.find((i) => i.drive_file_id === escaneada)!;
  assert.equal(pending.status, 'pendiente_datos');
  assert.equal(pending.invoice_date, null);
  assert.equal(pending.object, 'ticket escaneado');
  assert.equal((await rows('invoices.suppliers')).find((s) => s.id === pending.supplier_id)!.slug, 'sin_identificar');

  const st = await status();
  assert.equal(st.state.health, 'ok');
  assert.equal(st.runs[0].duplicates, 2);
  assert.ok(st.files.some((f: any) => f.name === 'foto.pdf' && f.status === 'error' && /No es un PDF/.test(f.reason)));
  assert.ok(st.files.some((f: any) => f.name === 'reenvio.pdf' && f.status === 'duplicada' && f.duplicate_of === invoice.id));
});

test('Drive: si el tick muere antes de mover el archivo, el siguiente solo lo mueve (sin factura repetida); más de 5 archivos quedan para el siguiente', async () => {
  const id = drive.add('Factura 0901.pdf', invoiceTextPdf('A-2026/0901'));
  drive.failMoves = 1;
  const first = await tick();
  assert.equal(first.data.outcome, 'error');
  assert.equal(first.data.more, true);
  assert.equal(drive.where(id), 'Entrada');
  const count = (await rows('invoices.invoices')).filter((i) => i.drive_file_id === id).length;
  assert.equal(count, 1);
  const second = await tick();
  assert.equal(second.data.outcome, 'ok');
  assert.equal(drive.where(id), 'Importadas');
  assert.equal((await rows('invoices.invoices')).filter((i) => i.drive_file_id === id).length, 1);

  // Seis archivos: cinco ahora y uno en el siguiente tick
  const many = Array.from({ length: 6 }, (_, i) => drive.add(`lote ${i}.pdf`, textPdf([[`Nota ${i}`, 40, 800]])));
  const third = await tick();
  assert.equal(third.data.listed, 5);
  assert.equal(third.data.more, true);
  const fourth = await tick();
  assert.equal(fourth.data.listed, 1);
  assert.equal(fourth.data.more, false);
  assert.ok(many.every((m) => drive.where(m) === 'Importadas'));
  // Un tick sin archivos: una sola llamada (las carpetas están en el estado)
  const idle = await tick();
  assert.equal(idle.data.api_calls, 1);
});

test('Drive: un abono (rectificativa impresa en positivo) se importa en negativo y se enlaza con su original', async () => {
  const id = drive.add('Abono Pepe.pdf', textPdf([
    ['FACTURA RECTIFICATIVA', 40, 815],
    ['FRUTAS PEPE S.L.', 40, 800], ['C/ Mayor 1, Madrid', 40, 786], ['CIF: B12345674', 300, 786],
    ['Factura nº: AB-0900-1', 40, 760], ['Fecha factura: 08/10/2026', 300, 760],
    ['Rectifica a la factura nº: A-2026/0900', 40, 745],
    ['Base imponible', 40, 690], ['140,00 €', 450, 690],
    ['IVA 10%', 40, 676], ['40,00', 300, 676], ['4,00', 450, 676],
    ['IVA 21%', 40, 662], ['100,00', 300, 662], ['21,00', 450, 662],
    ['Retención IRPF 15%', 40, 648], ['6,00', 450, 648],
    ['TOTAL FACTURA', 40, 620], ['159,00 €', 450, 620],
  ]));
  const res = await tick();
  assert.equal(res.data.read, 1, JSON.stringify(res.data));
  const invoices = await rows('invoices.invoices');
  const abono = invoices.find((i) => i.drive_file_id === id)!;
  const original = invoices.find((i) => i.invoice_number === 'A-2026/0900')!;
  assert.equal(abono.invoice_kind, 'rectificativa');
  assert.equal(abono.rectifies_number, 'A-2026/0900');
  assert.equal(abono.rectifies_invoice_id, original.id, 'enlazada con la original');
  assert.equal(Number(abono.calculated_total), -159);
});

test('Drive: «Buscar ahora» solo para el owner; el estado solo lo lee el owner', async () => {
  assert.equal((await app.call('/api/v1/drive/run', { body: {} })).status, 200);
  assert.equal((await app.call('/api/v1/drive/run', { body: {}, token: app.tokens.editor })).status, 403);
  assert.equal((await app.call('/api/v1/read/invoices.drive_status', { body: {}, token: app.tokens.editor })).status, 403);
  // Las acciones de sistema no se pueden invocar desde la app
  assert.notEqual((await app.call('/api/v1/invoke/invoices.drive_finish', { body: {} })).status, 200);
});

test('Drive en una carpeta de un usuario (9-10-2026): sin subcarpetas avisa y no importa; sin «Entrada» importa los PDF sueltos en la raíz', async () => {
  const folderDrive = new FakeDrive(false, 'carpeta-usuario', 'carpeta-usuario');
  const folderNotices: Array<Record<string, any>> = [];
  const own = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], workerKey: WORKER_KEY,
      drive: { api: folderDrive, upload: async (object, bytes) => { own.supabase.storage.set(object.path, bytes); }, notifyTasks: async (r) => { folderNotices.push(r); return true; } } }),
  });
  const run = () => own.call('/api/v1/worker/drive/tick', { token: null, method: 'POST', body: {}, headers: { 'x-ikisai-worker-key': WORKER_KEY } });
  const suelto = folderDrive.add('Factura suelta.pdf', invoiceTextPdf('A-2026/0950'));
  const blocked = await run();
  assert.equal(blocked.data.outcome, 'blocked');
  assert.match(blocked.data.detail, /Crea en tu carpeta de Drive estas subcarpetas: Importadas, Duplicadas, Con errores/);
  assert.equal(folderDrive.where(suelto), 'raíz', 'no toca nada');
  assert.equal(folderDrive.folders.size, 0, 'no crea carpetas');
  assert.deepEqual([folderNotices[0]?.kind, folderNotices[0]?.external_ref, folderNotices[0]?.priority], ['invoices.drive_blocked', 'drive:blocked', 'high']);
  assert.equal((await own.call('/api/v1/read/invoices.drive_status', { body: {} })).data.state.health, 'blocked');
  // El usuario crea las tres de destino (sin «Entrada»): los PDF sueltos en la raíz se importan
  for (const name of ['Importadas', 'Duplicadas', 'Con errores']) folderDrive.folders.set(name, `carpeta-${name}`);
  const ok = await run();
  assert.equal(ok.data.outcome, 'ok', JSON.stringify(ok.data));
  assert.deepEqual([ok.data.imported, ok.data.read], [1, 1]);
  assert.equal(folderDrive.where(suelto), 'Importadas');
});

test('Cliente de Drive: carpeta de un usuario (allDrives, sin crear subcarpetas) y unidad compartida (las crea)', async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fakeFetch = (shared: boolean): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (url.includes('/drives/')) return shared ? Response.json({ id: 'u' }) : Response.json({ error: { message: 'Shared drive not found' } }, { status: 404 });
    if (method === 'POST') return Response.json({ id: 'nueva' });
    return Response.json({ files: [] });
  }) as typeof fetch;
  const userFolder = createGoogleDriveApi({ driveId: 'raiz', accessToken: async () => 'token', fetch: fakeFetch(false) });
  assert.equal(await userFolder.folder('Importadas'), null);
  assert.ok(calls[0]!.url.includes('corpora=allDrives') && !calls[0]!.url.includes('driveId='));
  assert.ok(calls.some((c) => c.url.includes('/drives/raiz')));
  assert.ok(!calls.some((c) => c.method === 'POST'), 'nunca crea en la carpeta de un usuario');
  await userFolder.list('raiz', 6);
  const listUrl = decodeURIComponent(calls.at(-1)!.url);
  assert.match(listUrl, /'raiz' in parents and trashed = false and mimeType != 'application\/vnd\.google-apps\.folder'/);
  calls.length = 0;
  const sharedDrive = createGoogleDriveApi({ driveId: 'unidad', accessToken: async () => 'token', fetch: fakeFetch(true) });
  assert.equal(await sharedDrive.folder('Importadas'), 'nueva');
  assert.ok(calls.some((c) => c.method === 'POST'));
});

test('«Volver a leer las pendientes» (owner): un borrador de Drive que no se leyó se completa en su sitio con el lector actual', async () => {
  const d = new FakeDrive();
  let oldReader = true; // la primera lectura simula el lector antiguo: no saca texto
  const own = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], workerKey: WORKER_KEY,
      drive: { api: d, readPdf: async (bytes) => { if (oldReader) { oldReader = false; return []; } return readPdfItemsServer(bytes); },
        upload: async (object, bytes) => { own.supabase.storage.set(object.path, bytes); } } }),
  });
  const id = d.add('Factura real.pdf', invoiceTextPdf('RE-2026/0001'));
  const first = await own.call('/api/v1/worker/drive/tick', { token: null, method: 'POST', body: {}, headers: { 'x-ikisai-worker-key': WORKER_KEY } });
  assert.deepEqual([first.data.imported, first.data.read], [1, 0]);
  const snap = async () => ((await own.call('/api/v1/snapshot?tables=invoices.invoices')).data.tables[0].rows as Array<Record<string, any>>);
  const draft = (await snap()).find((i) => i.drive_file_id === id)!;
  assert.equal(draft.status, 'pendiente_datos');
  assert.equal((await own.call('/api/v1/drive/reread', { body: {}, token: own.tokens.editor })).status, 403);
  const res = await own.call('/api/v1/drive/reread', { body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual([res.data.checked, res.data.read], [1, 1]);
  assert.match(res.data.items[0].detail, /Leída: .* RE-2026\/0001 .* total 159,00 €/);
  const after = (await snap()).filter((i) => i.drive_file_id === id);
  assert.equal(after.length, 1, 'la misma factura, sin crear otra');
  assert.equal(after[0]!.id, draft.id);
  assert.equal(after[0]!.status, 'pendiente_revision');
  assert.equal(after[0]!.invoice_number, 'RE-2026/0001');
  assert.equal(after[0]!.import_meta.origin, 'pdf_text');
  // Queda rastro en el registro de Drive (lo ve el owner en Inicio)
  const st = (await own.call('/api/v1/read/invoices.drive_status', { body: {} })).data;
  assert.ok(st.files.some((f: any) => /^Relectura \(lector v\d+\): leída/.test(f.reason ?? '')), JSON.stringify(st.files));
});

test('relectura automática (0229): el tick vuelve a leer solo los borradores de Drive leídos con un lector anterior', async () => {
  const d = new FakeDrive();
  let oldReader = true;
  const own = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], workerKey: WORKER_KEY,
      drive: { api: d, readPdf: async (bytes) => { if (oldReader) { oldReader = false; return []; } return readPdfItemsServer(bytes); },
        upload: async (object, bytes) => { own.supabase.storage.set(object.path, bytes); } } }),
  });
  const run = () => own.call('/api/v1/worker/drive/tick', { token: null, method: 'POST', body: {}, headers: { 'x-ikisai-worker-key': WORKER_KEY } });
  const id = d.add('Factura antigua.pdf', invoiceTextPdf('AU-2026/0001'));
  assert.deepEqual([(await run()).data.imported, oldReader], [1, false]);
  // Leída con un lector anterior (como las de antes de #422)
  await own.t.db.query(`update invoices.drive_imports set reader_version = 1 where drive_file_id = $1`, [id]);
  assert.equal((await own.t.db.query<{ w: boolean }>(`select invoices.drive_has_work() w`)).rows[0]!.w, true, 'la sonda lo detecta');
  const second = await run();
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.deepEqual([second.data.listed, second.data.reread, second.data.reread_read], [0, 1, 1]);
  const snap = (await own.call('/api/v1/snapshot?tables=invoices.invoices')).data.tables[0].rows as Array<Record<string, any>>;
  const inv = snap.find((i) => i.drive_file_id === id)!;
  assert.equal(inv.status, 'pendiente_revision');
  assert.equal(inv.invoice_number, 'AU-2026/0001');
  const row = (await own.t.db.query<{ v: number; reason: string }>(`select reader_version v, reason from invoices.drive_imports where drive_file_id = $1`, [id])).rows[0]!;
  assert.equal(row.v, 2);
  assert.match(row.reason, /^Relectura \(lector v2\): leída/);
  // Ya no queda nada viejo: el siguiente tick no relee
  assert.equal((await run()).data.reread ?? 0, 0);
});

test('lectura parcial (fase 0): un PDF de Drive con texto sin fecha ni IVA queda con proveedor, NIF, número y total, y el resumen de la lectura', async () => {
  const d = new FakeDrive();
  const own = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], workerKey: WORKER_KEY,
      drive: { api: d, upload: async (object, bytes) => { own.supabase.storage.set(object.path, bytes); } } }),
  });
  const run = () => own.call('/api/v1/worker/drive/tick', { token: null, method: 'POST', body: {}, headers: { 'x-ikisai-worker-key': WORKER_KEY } });
  const id = d.add('Parcial.pdf', textPdf([
    ['SUMINISTROS PARCIALES S.L.', 40, 800], ['CIF: B12345674', 300, 800],
    ['Factura nº: PAR-77', 40, 770],
    ['Material de oficina variado para el almacén', 40, 740],
    ['TOTAL FACTURA', 40, 700], ['121,00 €', 450, 700],
  ]));
  const r = await run();
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.imported, r.data.read], [1, 0]);
  const snap = (await own.call('/api/v1/snapshot?tables=invoices.invoices,invoices.suppliers')).data.tables as Array<{ rows: Array<Record<string, any>> }>;
  const inv = snap[0]!.rows.find((i) => i.drive_file_id === id)!;
  const supplier = snap[1]!.rows.find((s) => s.id === inv.supplier_id)!;
  assert.equal(inv.status, 'pendiente_datos');
  assert.equal(inv.invoice_number, 'PAR-77');
  assert.equal(Number(inv.source_total), 121);
  assert.equal(inv.invoice_date, null);
  assert.deepEqual([supplier.name, supplier.tax_id], ['SUMINISTROS PARCIALES S.L.', 'B12345674']);
  const reading = inv.import_meta.reading;
  assert.equal(reading.read, 'partial');
  assert.deepEqual(reading.found, ['proveedor', 'número', 'total']);
  assert.ok(reading.missing.includes('la fecha'));
  assert.ok(reading.stats.chars > 40);
  assert.equal(JSON.stringify(reading).includes('Material de oficina'), false, 'sin texto del documento en el resumen');
  const row = (await own.t.db.query<{ reason: string }>(`select reason from invoices.drive_imports where drive_file_id = $1`, [id])).rows[0]!;
  assert.match(row.reason, /^He leído el PDF \(1 pág\., \d+ caracteres\) y encontrado proveedor, número y total, pero no he identificado la fecha/);

  // Una persona escribe la fecha a mano; la relectura completa no la pisa y respeta el proveedor ya puesto.
  await own.t.db.query(`update invoices.invoices set invoice_number = 'PAR-77-MANO' where id = $1`, [inv.id]);
  const again = await own.call('/api/v1/drive/reread', { body: {} });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const after = (await own.call('/api/v1/snapshot?tables=invoices.invoices')).data.tables[0].rows.find((i: any) => i.id === inv.id);
  assert.equal(after.invoice_number, 'PAR-77-MANO', 'la relectura no pisa lo escrito a mano');
  assert.equal(after.supplier_id, inv.supplier_id);
});
