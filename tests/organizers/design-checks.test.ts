/**
 * Organizers · veredicto y «Lo que te falta por rellenar» del diseño (pasada única, zona 2; tanda 30, MUELA-084): las
 * cuatro comprobaciones, sin comidas, el veredicto con «Siguiente» de Diseño y Fechas, y el recuento para el Resumen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DateOption, PortalDates } from '../../apps/organizers/src/app/api.ts';
import { designChecks, designPending, readyVerdict, type DesignCheckState } from '../../apps/organizers/src/app/design-checks.ts';

const option = (id: string, over: Partial<DateOption> = {}): DateOption => ({
  id, start: '2027-03-12', end: '2027-03-14', arrival_time: null, departure_time: null, proposed_by: 'ikisai', organizer_ok: false, availability: 'libre', ...over,
});
const offered: PortalDates = { mode: 'ikisai_options', definitive: null, options: [option('a'), option('b')] };
const empty: DesignCheckState = { expected_guests: null, requires_meals: true, meal_plan_requested: null, menu_style_requested: null };
const byKey = (state: DesignCheckState, dates: PortalDates | null) => Object.fromEntries(designChecks(state, dates).map((c) => [c.key, c]));

test('organizers · diseño: sin rellenar, faltan las cuatro y cada una lleva a su sitio', () => {
  const checks = designChecks(empty, offered);
  assert.deepEqual(checks.map((c) => [c.key, c.ok]), [['fechas', false], ['personas', false], ['regimen', false], ['menu', false]]);
  const c = byKey(empty, offered);
  assert.deepEqual(c.fechas!.target, { kind: 'tab', tab: 'fechas' });
  assert.deepEqual(c.personas!.target, { kind: 'field', field: 'd-expected_guests' });
  assert.equal(c.personas!.action.feedbackId, 'organizers.diseno.falta.personas');
  assert.equal(c.fechas!.detail, 'Marca al menos una fecha que te venga bien.');
  // Nunca promete la propuesta.
  assert.ok(checks.every((x) => !/propuesta/i.test(`${x.text} ${x.detail}`)));
});

test('organizers · diseño: fechas marcadas o fija, personas, régimen y menú', () => {
  const marked: PortalDates = { ...offered, options: [option('a', { organizer_ok: true }), option('b'), option('c', { proposed_by: 'organizer' })] };
  const full: DesignCheckState = { expected_guests: 20, requires_meals: true, meal_plan_requested: 'pension_completa', menu_style_requested: 'mixto' };
  const c = byKey(full, marked);
  assert.equal(c.fechas!.ok, true);
  assert.equal(c.fechas!.detail, 'Has marcado 2 fechas posibles.');
  assert.equal(c.personas!.detail, '20 personas previstas.');
  assert.equal(c.regimen!.ok, true);
  assert.equal(c.menu!.ok, true);
  const named = designChecks(full, marked, { mealPlan: () => 'Pensión completa', menuStyle: () => 'Omnívoro' });
  assert.deepEqual(named.slice(2).map((x) => x.detail), ['Pensión completa', 'Omnívoro']);
  const fixed: PortalDates = { mode: 'fixed', definitive: { start: '2027-03-12', end: '2027-03-14', arrival_time: null, departure_time: null }, options: [] };
  assert.equal(byKey(full, fixed).fechas!.detail, 'Fecha fijada por Ikisai.');
  assert.equal(byKey(full, { ...offered, options: [option('a', { organizer_ok: true })] }).fechas!.detail, 'Has marcado 1 fecha posible.');
  assert.equal(byKey(empty, null).fechas!.ok, false);
});

test('organizers · diseño: sin comidas, régimen y menú están bien', () => {
  const c = byKey({ ...empty, expected_guests: 12, requires_meals: false }, offered);
  assert.equal(c.regimen!.ok, true);
  assert.equal(c.menu!.ok, true);
  assert.equal(c.regimen!.detail, 'Sin comidas en Ikisai.');
});

test('organizers · diseño: cuántas faltan del formulario, para el Resumen del retiro (las fechas tienen su paso)', () => {
  assert.equal(designPending({ expected_guests: null, requires_meals: true, meal_plan: null, menu_style: null }, offered), 3);
  assert.equal(designPending({ expected_guests: 20, requires_meals: true, meal_plan: 'media_pension', menu_style: null }, offered), 1);
  assert.equal(designPending({ expected_guests: 20, requires_meals: false, meal_plan: null, menu_style: null }, { ...offered, options: [option('a', { organizer_ok: true })] }), 0);
  assert.equal(designPending({ expected_guests: 20, requires_meals: false, meal_plan: null, menu_style: null }, offered), 0, 'sin fechas marcadas, el formulario sigue completo');
});

test('organizers · veredicto: lo que falta para pedir la propuesta, con la primera como «Siguiente»', () => {
  const v = readyVerdict(designChecks(empty, offered), null);
  assert.equal(v.ok, false);
  assert.equal(v.pending, 4);
  assert.equal(v.text, 'Te faltan 4 cosas para pedir la propuesta');
  assert.equal(v.next?.kind, 'check');
  assert.equal(v.next?.title, 'Fechas posibles');
  assert.equal(v.next?.action, 'Ir a Fechas');
  const one = readyVerdict(designChecks({ ...empty, expected_guests: 8, requires_meals: false }, offered), null);
  assert.equal(one.text, 'Te falta 1 cosa para pedir la propuesta');
  assert.equal(one.next?.kind === 'check' && one.next.check.key, 'fechas');
  const noDates = readyVerdict(designChecks({ ...empty, requires_meals: false }, { ...offered, options: [option('a', { organizer_ok: true })] }), null);
  assert.equal(noDates.next?.kind === 'check' && noDates.next.check.key, 'personas');
});

test('organizers · veredicto: con todo, pedir la propuesta o revisarla; nunca promete plazos', () => {
  const full: DesignCheckState = { expected_guests: 20, requires_meals: false, meal_plan_requested: null, menu_style_requested: null };
  const marked: PortalDates = { ...offered, options: [option('a', { organizer_ok: true })] };
  const ask = readyVerdict(designChecks(full, marked), null);
  assert.equal(ask.ok, true);
  assert.equal(ask.text, 'Lo tienes todo para pedir la propuesta');
  assert.deepEqual([ask.next?.kind, ask.next?.title, ask.next?.action], ['proposal', 'Pedir la propuesta a Ikisai', 'Ir a Propuesta']);
  const review = readyVerdict(designChecks(full, marked), { status: 'enviada' });
  assert.deepEqual([review.next?.kind, review.next?.action], ['proposal', 'Ver la propuesta']);
  // Una caducada no cuenta como propuesta vigente.
  assert.equal(readyVerdict(designChecks(full, marked), { status: 'caducada' }).next?.title, 'Pedir la propuesta a Ikisai');
  for (const x of [ask, review]) assert.ok(!/\b(horas?|días?|semanas?|plazo|pronto|en breve)\b/i.test(`${x.text} ${x.next?.title} ${x.next?.detail}`), 'sin plazos de Ikisai');
});

test('organizers · veredicto: ya prerreservada (sin Diseño), solo cuentan las fechas', () => {
  const fixed: PortalDates = { mode: 'fixed', definitive: { start: '2027-03-12', end: '2027-03-14', arrival_time: null, departure_time: null }, options: [] };
  const v = readyVerdict(designChecks(empty, fixed), null, { draft: false });
  assert.deepEqual([v.ok, v.text, v.next], [true, 'Fecha fijada por Ikisai.', null]);
  const open = readyVerdict(designChecks(empty, offered), null, { draft: false });
  assert.deepEqual([open.ok, open.pending, open.text], [false, 1, 'Te falta marcar alguna fecha posible']);
  assert.equal(open.next?.kind === 'check' && open.next.check.key, 'fechas');
});
