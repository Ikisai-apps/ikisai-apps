/** Central · dirección: contrato de KPIs, proyección de Central, panel con varias apps y objetivos con umbrales. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { COMPLIANCE_TABLES, formatKpi, formatPeriod, kpiState, targetFor, TABLES } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
const madrid = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));

let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `kpi-${++seq}`, operations } });

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('kpis · dominio: estado por umbrales y sentido, objetivo por periodo, formato', () => {
  const down = { kpi: 'central.legal_overdue', period: '*', target: 0, warn_at: 0, critical_at: 2, direction: 'down' as const };
  assert.equal(kpiState(0, down), 'ok');
  assert.equal(kpiState(1, down), 'atencion');
  assert.equal(kpiState(3, down), 'critico');
  const up = { kpi: 'booking.occupancy_rate', period: '2026', target: 70, warn_at: 60, critical_at: 40, direction: 'up' as const };
  assert.equal(kpiState(65, up), 'ok'); assert.equal(kpiState(50, up), 'atencion'); assert.equal(kpiState(30, up), 'critico');
  assert.equal(kpiState(null, up), null); assert.equal(kpiState(5, null), null);
  const monthly = { ...up, period: '2026-08', warn_at: 90 };
  assert.equal(targetFor([up, monthly], 'booking.occupancy_rate', '2026-08'), monthly);
  assert.equal(targetFor([up, monthly], 'booking.occupancy_rate', '2026-09'), up);
  assert.equal(targetFor([down], 'central.legal_overdue', 'actual'), down);
  assert.match(formatKpi(1234.5, 'eur'), /1\.?235/);
  assert.equal(formatKpi(62.25, 'pct'), '62,3 %');
  assert.equal(formatKpi(1, 'days'), '1 día');
  assert.equal(formatPeriod('2026-10'), 'octubre de 2026');
  assert.equal(formatPeriod('2026T4'), '4.º trimestre de 2026');
});

test('kpis · proyección de Central: solo recuentos, con los vencimientos de hoy', async () => {
  const person = uuid();
  await commit([
    { op: 'insert', table: COMPLIANCE_TABLES.requirements, id: uuid(), fields: { name: 'Vencida y bloquea', requirement_type: 'licencia_autorizacion', expires_on: madrid(-1), blocks_operation: true, risk: 'critico' } },
    { op: 'insert', table: COMPLIANCE_TABLES.requirements, id: uuid(), fields: { name: 'Pronto', requirement_type: 'seguro', expires_on: madrid(10), notice_days: 30 } },
    { op: 'insert', table: COMPLIANCE_TABLES.requirements, id: uuid(), fields: { name: 'Cerrada', requirement_type: 'seguro', expires_on: madrid(-100), status: 'cerrado' } },
    { op: 'insert', table: COMPLIANCE_TABLES.keyDocuments, id: uuid(), fields: { name: 'Póliza vieja', document_type: 'poliza', expires_on: madrid(-3) } },
    { op: 'insert', table: TABLES.people, id: person, fields: { display_name: 'Marga', relation: 'equipo' } },
    { op: 'insert', table: TABLES.personRecords, id: uuid(), fields: { person_id: person, kind: 'formacion', record_type: 'manipulador_alimentos', status: 'ok', expires_on: madrid(-5) } },
  ]);
  const dash = await app.call('/api/v1/dashboard', { token: app.tokens.reader });
  assert.equal(dash.status, 200, JSON.stringify(dash.data));
  const v = (kpi: string) => dash.data.items.find((i: any) => i.kpi === kpi)?.value;
  assert.equal(v('central.legal_overdue'), 1);
  assert.equal(v('central.legal_due_soon'), 1);
  assert.equal(v('central.blocking_overdue'), 1);
  assert.equal(v('central.risks_high_open'), 1);
  assert.equal(v('central.documents_expired'), 1);
  assert.equal(v('central.people_active'), 1);
  assert.equal(v('central.people_records_expired'), 1);
  assert.equal(JSON.stringify(dash.data).includes('Marga'), false);
  // Ninguna otra app publica todavía: no rompe el panel.
  assert.deepEqual(dash.data.unavailable, ['booking', 'invoices', 'tasks', 'food']);
});

test('kpis · otra app publica su proyección con el contrato y entra en el panel', async () => {
  // Simula lo que hará Booking en su migración (vista + core.allow_read para central).
  await app.t.db.query(`create view booking.central_kpi_projection as
    select 'booking.events_next_30d'::text as kpi, 'Eventos en los próximos 30 días'::text as label, 4::numeric as value, 'count'::text as unit,
           'actual'::text as period, current_date as period_start, current_date + 30 as period_end, 'up'::text as direction,
           'https://booking.ikisai.com/#/'::text as link, now() as computed_at
    union all
    select 'booking.occupancy_rate', 'Ocupación', 62.5, 'pct', '2026-10', date '2026-10-01', date '2026-10-31', 'up', null, now()
    union all
    select 'booking.income_agreed_month', 'Importe acordado del mes', 12500, 'eur', '2026-10', date '2026-10-01', date '2026-10-31', 'up', null, now()`);
  await app.t.db.query(`select core.allow_read('central', 'booking.central_kpi_projection', 'view')`);
  const dash = await app.call('/api/v1/dashboard');
  const booking = dash.data.items.filter((i: any) => i.app === 'booking');
  assert.deepEqual(booking.map((i: any) => [i.kpi, i.value, i.period]), [['booking.events_next_30d', 4, 'actual'], ['booking.income_agreed_month', 12500, '2026-10'], ['booking.occupancy_rate', 62.5, '2026-10']]);
  // Los importes, solo para owner y editor de Central.
  const asEditor = await app.call('/api/v1/dashboard', { token: app.tokens.editor });
  assert.ok(asEditor.data.items.some((i: any) => i.kpi === 'booking.income_agreed_month'));
  const asReader = await app.call('/api/v1/dashboard', { token: app.tokens.reader });
  assert.equal(asReader.data.items.some((i: any) => i.unit === 'eur'), false);
  assert.ok(asReader.data.items.some((i: any) => i.kpi === 'booking.occupancy_rate'));
  assert.equal(dash.data.unavailable.includes('booking'), false);
  assert.equal(dash.data.items[0].app, 'central');
});

test('kpis · objetivos: solo el owner los fija; el panel calcula el estado', async () => {
  const forbidden = await commit([{ op: 'insert', table: 'central.kpi_targets', id: uuid(), fields: { kpi: 'central.legal_overdue', warn_at: 0, critical_at: 2, direction: 'down' } }], app.tokens.editor);
  assert.equal(forbidden.status, 403);
  const bad = await commit([{ op: 'insert', table: 'central.kpi_targets', id: uuid(), fields: { kpi: 'sin punto', direction: 'down' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.details.field, 'kpi');
  const ok = await commit([
    { op: 'insert', table: 'central.kpi_targets', id: uuid(), fields: { kpi: 'central.legal_overdue', target: 0, warn_at: 0, critical_at: 2, direction: 'down' } },
    { op: 'insert', table: 'central.kpi_targets', id: uuid(), fields: { kpi: 'booking.occupancy_rate', period: '2026', target: 70, warn_at: 65, critical_at: 40, direction: 'up' } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const dash = await app.call('/api/v1/dashboard', { token: app.tokens.reader });
  const item = (kpi: string) => dash.data.items.find((i: any) => i.kpi === kpi);
  assert.equal(item('central.legal_overdue').state, 'atencion'); assert.equal(item('central.legal_overdue').target, 0);
  assert.equal(item('booking.occupancy_rate').state, 'atencion');
  assert.equal(item('central.people_active').state, null);
});
