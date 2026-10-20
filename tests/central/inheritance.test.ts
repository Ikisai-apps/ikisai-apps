/**
 * Central · las capacidades se heredan del padre a los hijos, nunca al revés (1510; decisión del usuario del 18-10-2026).
 * El grado del padre es el mínimo en los hijos; en un hijo se puede tener más, y eso no sube al padre. La misma regla en la
 * base (`central.person_trade_levels`, `capability_options`, indicadores) y en el dominio (`effectiveLevels`). Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { TABLES, effectiveLevels, inheritedLevel } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `inherit-${++seq}`, operations } });
const rows = async (sql: string, args: unknown[] = []) => (await app.t.db.query<any>(sql, args)).rows;

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('herencia · del padre a los hijos, nunca al revés: base, Tasks (el equipo; el outsider no, desde la 1513) y dominio dicen lo mismo', async () => {
  // Albañilería › Demolición › Escombros (tres niveles) y Pintura › Interior (se archiva) › Techos.
  const T = { alb: uuid(), dem: uuid(), esc: uuid(), pin: uuid(), int: uuid(), tec: uuid() };
  const P = { sabe: uuid(), mas: uuid(), hijo: uuid(), menos: uuid(), igual: uuid(), pinta: uuid() };
  const trade = (id: string, name: string, parent_id: string | null = null) => ({ op: 'insert', table: TABLES.trades, id, fields: { name, parent_id } });
  const person = (id: string, name: string) => ({ op: 'insert', table: TABLES.people, id, fields: { display_name: name, relation: 'equipo', house_level: 'staff' } });
  const cap = (person_id: string, trade_id: string, level: number) => ({ op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id, trade_id, level } });
  const ok = await commit([
    trade(T.alb, 'Albañilería'), trade(T.dem, 'Demolición', T.alb), trade(T.esc, 'Escombros', T.dem),
    trade(T.pin, 'Pintura'), trade(T.int, 'Interior', T.pin), trade(T.tec, 'Techos', T.int),
    person(P.sabe, 'Sabe Ficticia'), person(P.mas, 'Más Ficticia'), person(P.hijo, 'Hijo Ficticio'), person(P.menos, 'Menos Ficticia'),
    person(P.igual, 'Igual Ficticia'), person(P.pinta, 'Pinta Ficticia'),
    cap(P.sabe, T.alb, 1), // padre Sabe → hijo y nieto Sabe, heredados
    cap(P.mas, T.alb, 1), cap(P.mas, T.dem, 2), // padre Sabe + hijo Experto → Experto en el hijo (y el nieto), Sabe en el padre
    cap(P.hijo, T.esc, 2), // solo el nieto → no cuenta en el hijo ni en el padre
    cap(P.menos, T.alb, 2), cap(P.menos, T.dem, 0), // dato viejo: menos en el hijo que en el padre → manda el padre
    cap(P.igual, T.alb, 1), cap(P.igual, T.dem, 1), // lo mismo en el hijo: puesto, no heredado
    cap(P.pinta, T.pin, 1), cap(P.pinta, T.int, 2), // el del medio se archiva
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const [mid] = await rows(`select revision from central.trades where id = $1`, [T.int]);
  assert.equal((await commit([{ op: 'update', table: TABLES.trades, id: T.int, expectedRevision: Number(mid.revision), fields: { active: false } }])).status, 200);

  const expected = new Map<string, Array<[string, number, boolean]>>([
    [P.sabe, [[T.alb, 1, false], [T.dem, 1, true], [T.esc, 1, true]]],
    [P.mas, [[T.alb, 1, false], [T.dem, 2, false], [T.esc, 2, true]]],
    [P.hijo, [[T.esc, 2, false]]],
    [P.menos, [[T.alb, 2, false], [T.dem, 2, true], [T.esc, 2, true]]],
    [P.igual, [[T.alb, 1, false], [T.dem, 1, false], [T.esc, 1, true]]],
    // Interior archivado: no sale, y lo puesto en él no cuenta; Techos hereda de Pintura a través de él.
    [P.pinta, [[T.pin, 1, false], [T.tec, 1, true]]],
  ]);
  const ours = new Set(Object.values(P));
  const sort = (a: Array<[string, number, boolean]>) => [...a].sort((x, y) => x[0].localeCompare(y[0]));

  // Tasks: el lector y el editor leen lo mismo, con `inherited` al final. El outsider no las lee (1513, options.test.ts).
  for (const role of ['reader', 'editor']) {
    const user = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, $2)`, [user, role]);
    const out = (await app.t.rpc('core_read', { p_app: 'tasks', p_actor: user, p_name: 'central.capability_options', p_args: {} }) as { rows: any[] }).rows;
    for (const [p, list] of expected) {
      assert.deepEqual(sort(out.filter((r) => r.person_id === p).map((r) => [r.trade_id, r.level, r.inherited])), sort(list), `${role}: ${p}`);
    }
  }
  const cols = await rows(`select column_name from information_schema.columns where table_schema = 'central' and table_name = 'capability_options' order by ordinal_position`);
  assert.deepEqual(cols.map((c) => c.column_name), ['person_id', 'trade_id', 'level', 'inherited']);

  // El dominio (cliente) dice lo mismo que la base.
  const trades = await rows(`select id, parent_id, active, deleted_at from central.trades`);
  const capabilities = await rows(`select person_id, trade_id, level, deleted_at from central.person_trades`);
  const levels = effectiveLevels(trades, capabilities);
  for (const [p, list] of expected) {
    assert.deepEqual(sort([...(levels.get(p) ?? new Map())].map(([t, e]) => [t, e.level, e.inherited])), sort(list), `dominio: ${p}`);
  }
  assert.equal(levels.get(P.sabe)!.get(T.esc)!.from, T.alb);
  assert.equal(levels.get(P.mas)!.get(T.esc)!.from, T.dem); // el antepasado con más grado
  assert.equal(levels.get(P.pinta)!.get(T.tec)!.from, T.pin);
  // El mínimo que pide la ficha: lo heredado, sin contar lo puesto en el propio oficio.
  assert.deepEqual(inheritedLevel(trades, capabilities, P.mas, T.dem), { level: 1, from: T.alb });
  assert.equal(inheritedLevel(trades, capabilities, P.hijo, T.dem), null);
  assert.equal(inheritedLevel(trades, capabilities, P.sabe, T.alb), null);

  // Indicadores: con el grado efectivo. Albañilería: Sabe, Más, Menos e Igual (Hijo, no). Escombros: los seis menos Pinta.
  const [k] = await rows(`select count(*)::int as n from central.person_trade_levels where trade_id = $1 and person_id = any($2)`, [T.alb, [...ours]]);
  assert.equal(k.n, 4);
  const [e] = await rows(`select count(*)::int as n from central.person_trade_levels where trade_id = $1 and person_id = any($2)`, [T.esc, [...ours]]);
  assert.equal(e.n, 5);
});

test('herencia · indicadores de cobertura: lo del hijo no saca al padre de riesgo; lo del padre sí saca al hijo', async () => {
  const v = async (kpi: string) => Number((await rows(`select value from central.central_kpi_projection where kpi = $1`, [kpi]))[0].value);
  const base = { risk: await v('central.trades_at_risk'), learners: await v('central.trades_learners_no_expert') };
  const T = { pad: uuid(), hij: uuid() };
  const P = { a: uuid(), b: uuid() };
  const ok = await commit([
    { op: 'insert', table: TABLES.trades, id: T.pad, fields: { name: 'Carpintería Herencia' } },
    { op: 'insert', table: TABLES.trades, id: T.hij, fields: { name: 'Muebles', parent_id: T.pad } },
    { op: 'insert', table: TABLES.people, id: P.a, fields: { display_name: 'Aitana Herencia', relation: 'equipo', house_level: 'staff' } },
    { op: 'insert', table: TABLES.people, id: P.b, fields: { display_name: 'Bruno Herencia', relation: 'equipo', house_level: 'staff' } },
    // Dos personas saben el hijo: antes sacaban al padre de riesgo; ahora no.
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: P.a, trade_id: T.hij, level: 1 } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: P.b, trade_id: T.hij, level: 1 } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(await v('central.trades_at_risk'), base.risk + 1); // el padre, en riesgo; el hijo, con dos
  // Las dos aprenden el padre: el hijo sigue con dos capaces (lo suyo es más) y el padre pasa a tener aprendices sin experto.
  await commit([
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: P.a, trade_id: T.pad, level: 0 } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: P.b, trade_id: T.pad, level: 0 } },
  ]);
  assert.equal(await v('central.trades_at_risk'), base.risk + 1);
  assert.equal(await v('central.trades_learners_no_expert'), base.learners + 1);
});
