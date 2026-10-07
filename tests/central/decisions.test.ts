/** Central · registro de decisiones: código DEC, quién escribe, sustituciones coherentes y búsqueda. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { DECISIONS_TABLE, filterDecisions, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `dec-${++seq}`, operations } });
const decision = (fields: Record<string, unknown> = {}) => ({
  decided_on: '2026-10-06', name: 'Las apps se llaman en inglés y tienen un alias en español',
  summary: 'Cada app tiene un nombre en inglés y una dirección en español que lleva a la misma app.', scopes: ['ecosistema'], ...fields,
});

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('decisiones · dominio: búsqueda sin acentos, filtros y orden', () => {
  const rows = [
    { code: 'DEC_2026_001', decided_on: '2026-10-05', name: 'Facturación con otra herramienta', summary: 'Se registran las emitidas.', status: 'vigente', scopes: ['invoices'] },
    { code: 'DEC_2026_002', decided_on: '2026-10-06', name: 'Nombres en inglés', summary: 'Alias en español.', technical: 'Redirección 301 en Cloudflare', status: 'vigente', scopes: ['ecosistema'] },
    { code: 'DEC_2026_003', decided_on: '2026-10-07', name: 'Antigua', summary: 'x', status: 'sustituida', scopes: ['invoices'], deleted_at: null },
    { code: 'DEC_2026_004', decided_on: '2026-10-08', name: 'Borrada', summary: 'x', status: 'vigente', scopes: [], deleted_at: '2026-10-08' },
  ];
  assert.deepEqual(filterDecisions(rows, 'facturacion', '', '').map((d) => d.code), ['DEC_2026_001']);
  assert.deepEqual(filterDecisions(rows, 'cloudflare 301', '', '').map((d) => d.code), ['DEC_2026_002']);
  assert.deepEqual(filterDecisions(rows, '', 'invoices', '').map((d) => d.code), ['DEC_2026_003', 'DEC_2026_001']);
  assert.deepEqual(filterDecisions(rows, '', '', 'vigente').map((d) => d.code), ['DEC_2026_002', 'DEC_2026_001']);
  const owner = { role: 'owner' };
  assert.equal(validateOperations([{ op: 'insert', table: DECISIONS_TABLE, id: 'x', fields: decision({ scopes: ['marte'] }) }], owner)?.details.field, 'scopes');
  assert.equal(validateOperations([{ op: 'insert', table: DECISIONS_TABLE, id: 'x', fields: decision({ status: 'sustituida' }) }], owner)?.details.field, 'superseded_by');
  assert.equal(validateOperations([{ op: 'update', table: DECISIONS_TABLE, id: 'x', fields: { status: 'sustituida', superseded_by: 'x' } }], owner, () => ({}))?.details.field, 'superseded_by');
});

test('decisiones · código DEC; editor escribe y lector lee; sustitución coherente', async () => {
  const a = uuid();
  const first = await commit([{ op: 'insert', table: DECISIONS_TABLE, id: a, fields: decision() }], app.tokens.editor);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.changes[0].after.code, /^DEC_\d{4}_\d{3}$/);
  assert.equal((await commit([{ op: 'insert', table: DECISIONS_TABLE, id: uuid(), fields: decision() }], app.tokens.reader)).status, 403);
  const snap = await app.call(`/api/v1/snapshot?tables=${DECISIONS_TABLE}`, { token: app.tokens.reader });
  assert.equal(snap.data.tables[0].rows.length, 1);

  const bad = await commit([{ op: 'update', table: DECISIONS_TABLE, id: a, expectedRevision: 1, fields: { status: 'sustituida' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.details.field, 'superseded_by');

  // B sustituye a A en un solo lote.
  const b = uuid();
  const replace = await commit([
    { op: 'insert', table: DECISIONS_TABLE, id: b, fields: decision({ name: 'Nueva versión', decided_on: '2026-10-07' }) },
    { op: 'update', table: DECISIONS_TABLE, id: a, expectedRevision: 1, fields: { status: 'sustituida', superseded_by: b } },
  ]);
  assert.equal(replace.status, 200, JSON.stringify(replace.data));
  // B no puede ir a la papelera mientras A apunte a ella.
  const orphan = await commit([{ op: 'delete', table: DECISIONS_TABLE, id: b, expectedRevision: 1 }]);
  assert.equal(orphan.status, 422); assert.equal(orphan.data.error.code, 'ORPHAN_CHILD');
  // Un enlace que no es https se rechaza.
  const link = await commit([{ op: 'update', table: DECISIONS_TABLE, id: b, expectedRevision: 1, fields: { link_url: 'http://x' } }]);
  assert.equal(link.data.error.details.field, 'link_url');
});
