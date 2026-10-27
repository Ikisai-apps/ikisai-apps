/** Central · dirección: contrato de KPIs, proyección de Central, panel con varias apps y objetivos con umbrales. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { collapseSeries, COMPLIANCE_TABLES, currentPeriod, formatKpi, formatPeriod, groupBySection, kpiState, seriesLength, stateSummary, targetFor, TABLES } from '../../supabase/functions/_domain/central/mod.ts';

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
  // Las apps que aún no publican van en `unavailable` y no rompen el panel; las que ya publican, no. No depende de cuáles sean.
  const published = (await app.t.db.query<{ app: string }>(`select split_part(name, '.', 1) as app from core.allowed_reads where app = 'central' and name like '%.central_kpi_projection' and name <> 'central.central_kpi_projection'`)).rows.map((r) => r.app);
  const expected = ['booking', 'guests', 'invoices', 'tasks', 'food'].filter((a) => !published.includes(a));
  assert.deepEqual(dash.data.unavailable, expected);
});

test('kpis · otra app publica su proyección con el contrato y entra en el panel', async () => {
  // Simula lo que hará Booking en su migración (vista + core.allow_read para central).
  await app.t.db.query(`create or replace view booking.central_kpi_projection as
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

test('kpis · R7: temas del panel en su orden; lo que no tiene tema va detrás, sin título', () => {
  const items = ['booking.x', 'central.trades_at_risk', 'central.legal_due_soon', 'central.people_active', 'central.legal_overdue'].map((kpi) => ({ kpi }));
  assert.deepEqual(groupBySection(items).map((g) => [g.title, g.items.map((i) => i.kpi)]), [
    ['Cumplimiento', ['central.legal_overdue', 'central.legal_due_soon']],
    ['Personas', ['central.people_active']],
    ['Oficios', ['central.trades_at_risk']],
    [null, ['booking.x']],
  ]);
  // Guests (#876): primero lo que falta (portal y firmas), después los partes de viajeros.
  assert.deepEqual(groupBySection(['guests.ses_sent_30d', 'guests.signatures_done', 'guests.portal_entered_pct', 'guests.retreats_ses_pending'].map((kpi) => ({ kpi }))).map((g) => [g.title, g.items.map((i) => i.kpi)]), [
    ['Portal y firmas', ['guests.portal_entered_pct', 'guests.signatures_done']],
    ['Partes de viajeros', ['guests.retreats_ses_pending', 'guests.ses_sent_30d']],
  ]);
  // Una app sin claves con tema se queda en un solo bloque y en el orden de llegada.
  assert.deepEqual(groupBySection([{ kpi: 'tasks.b' }, { kpi: 'tasks.a' }]).map((g) => [g.title, g.items.map((i) => i.kpi)]), [[null, ['tasks.b', 'tasks.a']]]);
  assert.deepEqual(stateSummary([{ state: 'critico' }, { state: 'atencion' }, { state: 'atencion' }, { state: null }, { state: 'ok' }]), { critico: 1, atencion: 2, total: 5 });
});

test('kpis · R7: personas y oficios del directorio, con lo heredado del padre (1510); Recursos entra en el panel', async () => {
  const v = (dash: any, kpi: string) => dash.data.items.find((i: any) => i.kpi === kpi)?.value;
  // Sin niveles de casa todavía, los nuevos no dicen nada («—»).
  const before = await app.call('/api/v1/dashboard');
  for (const kpi of ['central.people_direction_staff', 'central.trades_at_risk', 'central.trades_per_person']) assert.equal(v(before, kpi), null, kpi);

  const P = { ana: uuid(), car: uuid(), dan: uuid(), eva: uuid(), fed: uuid(), gem: uuid(), hug: uuid() };
  const T = { man: uuid(), fon: uuid(), ele: uuid(), lim: uuid(), soc: uuid(), arc: uuid() };
  const person = (id: string, name: string, house_level: string | null, active = true) =>
    ({ op: 'insert', table: TABLES.people, id, fields: { display_name: name, relation: house_level === 'outsider' ? 'colaborador' : 'equipo', house_level, active } });
  const trade = (id: string, name: string, parent_id: string | null = null) => ({ op: 'insert', table: TABLES.trades, id, fields: { name, parent_id } });
  const cap = (person_id: string, trade_id: string, level: number) => ({ op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id, trade_id, level } });
  const record = (person_id: string, days: number, status = 'ok') => ({ op: 'insert', table: TABLES.personRecords, id: uuid(), fields: { person_id, kind: 'formacion', record_type: 'primeros_auxilios', status, expires_on: madrid(days) } });
  const seeded = await commit([
    person(P.ana, 'Ana Ficticia', 'staff'), person(P.car, 'Carlos Ficticio', 'direccion'), person(P.dan, 'Dani Ficticio', 'outsider'),
    person(P.eva, 'Eva Ficticia', 'outsider'), person(P.fed, 'Fede Ficticio', 'staff'), person(P.gem, 'Gema Ficticia', null), person(P.hug, 'Hugo Ficticio', 'staff', false),
    trade(T.man, 'Mantenimiento'), trade(T.fon, 'Fontanería', T.man), trade(T.ele, 'Electricidad', T.man), trade(T.lim, 'Limpieza'), trade(T.soc, 'Socorrismo'), trade(T.arc, 'Pintura'),
  ]);
  assert.equal(seeded.status, 200, JSON.stringify(seeded.data));
  const caps = await commit([
    cap(P.ana, T.fon, 2), cap(P.ana, T.ele, 1), cap(P.car, T.fon, 1), cap(P.eva, T.lim, 0), cap(P.dan, T.soc, 1),
    cap(P.hug, T.lim, 2), // inactiva: fuera del directorio
    cap(P.gem, T.ele, 2), // sin nivel de casa: fuera del directorio
    cap(P.ana, T.arc, 1), // oficio que se archiva
    record(P.ana, 10), record(P.ana, 60), record(P.ana, -5), record(P.car, 5, 'no_aplica'),
  ]);
  assert.equal(caps.status, 200, JSON.stringify(caps.data));
  const archived = await commit([{ op: 'update', table: TABLES.trades, id: T.arc, expectedRevision: 1, fields: { active: false } }]);
  assert.equal(archived.status, 200, JSON.stringify(archived.data));

  const dash = await app.call('/api/v1/dashboard', { token: app.tokens.reader });
  assert.equal(dash.status, 200, JSON.stringify(dash.data));
  // Directorio: Ana, Carlos, Fede (casa) y Dani, Eva (outsiders). Marga (de la prueba anterior) y Gema, activas sin nivel.
  assert.equal(v(dash, 'central.people_direction_staff'), 3);
  assert.equal(v(dash, 'central.people_outsiders'), 2);
  assert.equal(v(dash, 'central.people_without_level'), 2);
  assert.equal(v(dash, 'central.outsiders_without_account'), 2);
  assert.equal(v(dash, 'central.people_records_due_30d'), 1);
  assert.equal(v(dash, 'central.people_records_due_90d'), 2);
  // 1510: lo del padre baja a los hijos, nunca al revés. Mantenimiento ya no cuenta a Ana y a Carlos por Fontanería: en
  // riesgo Mantenimiento (nadie), Electricidad (Ana), Limpieza (Eva aprende) y Socorrismo (Dani, outsider).
  assert.equal(v(dash, 'central.trades_at_risk'), 4);
  assert.equal(v(dash, 'central.trades_learners_no_expert'), 1);
  assert.equal(v(dash, 'central.trades_only_outsiders'), 1);
  assert.equal(v(dash, 'central.people_without_trades'), 1);
  assert.equal(v(dash, 'central.trades_per_person'), 1);
  assert.equal(v(dash, 'central.trades_archived_with_people'), 1);
  assert.equal(dash.data.items.find((i: any) => i.kpi === 'central.trades_at_risk').link, 'https://central.ikisai.com/#/personas/oficios?riesgo');
  // Solo agregados: ningún nombre.
  assert.equal(/Fictici/.test(JSON.stringify(dash.data)), false);
  // Las 7 de siempre siguen.
  for (const kpi of ['central.legal_overdue', 'central.people_active', 'central.people_records_expired']) assert.ok(dash.data.items.some((i: any) => i.kpi === kpi), kpi);

  // Recursos (0805) va justo detrás de Central; el valor del inventario, en euros, no llega al lector.
  const apps = [...new Set(dash.data.items.map((i: any) => i.app))];
  assert.deepEqual(apps.slice(0, 2), ['central', 'resources']);
  assert.ok(dash.data.items.some((i: any) => i.kpi === 'resources.spaces_active'));
  assert.equal(dash.data.items.some((i: any) => i.kpi === 'resources.stock_value'), false);
  const owner = await app.call('/api/v1/dashboard');
  assert.ok(owner.data.items.some((i: any) => i.kpi === 'resources.stock_value'));
  assert.equal(owner.data.unavailable.includes('resources'), false);
});

test('kpis · series en una tarjeta: el periodo en curso (o el último anterior) y la serie entera en orden', () => {
  assert.equal(currentPeriod('2026-03', '2026-10-18'), '2026-10');
  assert.equal(currentPeriod('2025T1', '2026-10-18'), '2026T4');
  assert.equal(currentPeriod('2025', '2026-10-18'), '2026');
  assert.equal(currentPeriod('actual', '2026-10-18'), 'actual');
  const row = (kpi: string, period: string) => ({ kpi, period });
  const items = [row('a.uno', 'actual'), row('b.mes', '2026-11'), row('b.mes', '2026-09'), row('b.mes', '2026-10'), row('c.pasado', '2026-08'), row('c.pasado', '2026-07'),
    row('d.futuro', '2027-01'), row('d.futuro', '2026-12')];
  const out = collapseSeries(items, '2026-10-18');
  // Una tarjeta por clave, en el orden de llegada; las de un solo periodo, igual que antes.
  assert.deepEqual(out.map((c) => [c.shown.kpi, c.shown.period, c.series.map((r) => r.period)]), [
    ['a.uno', 'actual', ['actual']],
    ['b.mes', '2026-10', ['2026-09', '2026-10', '2026-11']],
    ['c.pasado', '2026-08', ['2026-07', '2026-08']],
    ['d.futuro', '2026-12', ['2026-12', '2027-01']],
  ]);
  assert.equal(seriesLength(out[1]!.series), '3 meses');
  assert.equal(seriesLength([row('x', '2026T1')]), '1 trimestre');
});
