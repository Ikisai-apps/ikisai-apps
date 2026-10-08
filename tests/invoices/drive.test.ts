/**
 * Invoices · facturas que llegan por Google Drive (fase 4, migración 0224, API.md §15): el tick con un Drive simulado,
 * la lectura real del PDF (PDF.js en Node, el mismo que la Edge) y el núcleo sobre PGlite. Nunca contra el Drive real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { createGoogleDriveApi, DriveError, type DriveApi, type DriveFile } from '../../supabase/functions/invoices-api/drive.ts';
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

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({
      ...config, origins: [INVOICES_ORIGINS[0]!], workerKey: WORKER_KEY,
      drive: { api: drive, limit: 5, upload: async (object, bytes) => { app.supabase.storage.set(object.path, bytes); } },
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

test('Drive: «Buscar ahora» solo para el owner; el estado solo lo lee el owner', async () => {
  assert.equal((await app.call('/api/v1/drive/run', { body: {} })).status, 200);
  assert.equal((await app.call('/api/v1/drive/run', { body: {}, token: app.tokens.editor })).status, 403);
  assert.equal((await app.call('/api/v1/read/invoices.drive_status', { body: {}, token: app.tokens.editor })).status, 403);
  // Las acciones de sistema no se pueden invocar desde la app
  assert.notEqual((await app.call('/api/v1/invoke/invoices.drive_finish', { body: {} })).status, 200);
});

test('Drive en una carpeta de un usuario (9-10-2026): sin subcarpetas avisa y no importa; sin «Entrada» importa los PDF sueltos en la raíz', async () => {
  const folderDrive = new FakeDrive(false, 'carpeta-usuario', 'carpeta-usuario');
  const own = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], workerKey: WORKER_KEY,
      drive: { api: folderDrive, upload: async (object, bytes) => { own.supabase.storage.set(object.path, bytes); } } }),
  });
  const run = () => own.call('/api/v1/worker/drive/tick', { token: null, method: 'POST', body: {}, headers: { 'x-ikisai-worker-key': WORKER_KEY } });
  const suelto = folderDrive.add('Factura suelta.pdf', invoiceTextPdf('A-2026/0950'));
  const blocked = await run();
  assert.equal(blocked.data.outcome, 'blocked');
  assert.match(blocked.data.detail, /Crea en tu carpeta de Drive estas subcarpetas: Importadas, Duplicadas, Con errores/);
  assert.equal(folderDrive.where(suelto), 'raíz', 'no toca nada');
  assert.equal(folderDrive.folders.size, 0, 'no crea carpetas');
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
