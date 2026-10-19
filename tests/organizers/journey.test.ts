/**
 * Organizers · recorrido del retiro (pasada única, zona 1): fase y grupo de Mis retiros, cuenta atrás, «Te toca» de la
 * tarjeta y el orden de los pasos del Resumen, con «hoy» fijo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Contract, PortalDates, PortalMoney, PortalProposal, PortalRequest, PortalReservation, ReservationStatus } from '../../apps/organizers/src/app/api.ts';
import { countdownText, groupRetreats, phaseOf, stageKeyOf, summarySteps, toDoOf, todayMadrid, type SummaryInput } from '../../apps/organizers/src/app/journey.ts';

const TODAY = '2026-10-19';

const card = (over: Partial<PortalReservation> = {}): PortalReservation => ({
  id: over.id ?? 'r', code: null, title: 'Retiro', start_date: '2027-03-12', end_date: '2027-03-14', expected_guests: null,
  status: 'confirmada', confirmed: true, mode: 'ses', guests: 0, complete: 0, ...over,
});

test('organizers · recorrido: hoy es la fecha de Madrid', () => {
  // 23:30 UTC del 19 es ya el 20 en Madrid (verano: UTC+2).
  assert.equal(todayMadrid(new Date('2026-07-19T23:30:00Z')), '2026-07-20');
  assert.match(todayMadrid(), /^\d{4}-\d{2}-\d{2}$/);
});

test('organizers · recorrido: fase y etapa de cada estado', () => {
  const at = (status: ReservationStatus, start: string | null = '2027-03-12', end: string | null = '2027-03-14') => phaseOf({ status, start_date: start, end_date: end }, TODAY);
  assert.equal(at('cancelada'), 'cancelado');
  assert.equal(at('perdida'), 'cancelado');
  assert.equal(at('perdida', '2025-01-01', '2025-01-02'), 'cancelado');
  assert.equal(at('en_estudio', '2025-05-02', '2025-05-04'), 'finalizado');
  assert.equal(at('confirmada', '2026-10-01', '2026-10-18'), 'finalizado');
  assert.equal(at('cerrada'), 'finalizado');
  assert.equal(at('cerrada', null, null), 'finalizado');
  assert.equal(at('en_estudio'), 'diseno');
  assert.equal(at('negociacion', null, null), 'diseno');
  assert.equal(at('pre_reservada'), 'prerreserva');
  assert.equal(at('confirmada', '2026-10-18', '2026-10-20'), 'encurso');
  assert.equal(at('confirmada', '2026-10-19', '2026-10-19'), 'encurso');
  assert.equal(at('en_ejecucion'), 'encurso');
  assert.equal(at('confirmada'), 'confirmado');
  assert.equal(at('confirmada', null, null), 'confirmado');
  assert.equal(stageKeyOf({ status: 'cancelada', start_date: null, end_date: null }, TODAY), null);
  assert.equal(stageKeyOf({ status: 'pre_reservada', start_date: null, end_date: null }, TODAY), 'prerreserva');
});

test('organizers · recorrido: grupos de Mis retiros y su orden', () => {
  const items = [
    card({ id: 'sin-fecha', status: 'en_estudio', start_date: null, end_date: null }),
    card({ id: 'marzo', start_date: '2027-03-12', end_date: '2027-03-14' }),
    card({ id: 'perdido', status: 'perdida', start_date: null, end_date: null }),
    card({ id: 'pasado-viejo', status: 'cerrada', start_date: '2025-05-02', end_date: '2025-05-04' }),
    card({ id: 'enero', status: 'pre_reservada', start_date: '2027-01-08', end_date: '2027-01-10' }),
    card({ id: 'pasado-reciente', start_date: '2026-09-01', end_date: '2026-09-03' }),
    card({ id: 'cancelado', status: 'cancelada', start_date: '2026-01-01', end_date: '2026-01-02' }),
    card({ id: 'cerrada-futura', status: 'cerrada', start_date: '2027-06-01', end_date: '2027-06-02' }),
  ];
  const g = groupRetreats(items, TODAY);
  assert.deepEqual(g.main.map((r) => r.id), ['enero', 'marzo', 'cerrada-futura', 'sin-fecha']);
  assert.deepEqual(g.past.map((r) => r.id), ['pasado-reciente', 'pasado-viejo']);
  assert.deepEqual(g.cancelled.map((r) => r.id), ['cancelado', 'perdido']);
});

test('organizers · recorrido: cuenta atrás', () => {
  assert.equal(countdownText(null, null, TODAY), 'Fechas por concretar');
  assert.equal(countdownText('2026-10-20', '2026-10-22', TODAY), 'Empieza mañana');
  assert.equal(countdownText('2026-10-31', '2026-11-02', TODAY), 'Empieza en 12 días');
  assert.equal(countdownText('2026-10-19', '2026-10-21', TODAY), 'Empieza hoy');
  assert.equal(countdownText('2026-10-18', '2026-10-20', TODAY), 'En curso · día 2 de 3');
  assert.equal(countdownText('2026-10-16', '2026-10-18', TODAY), 'Terminó ayer');
  assert.equal(countdownText('2026-10-01', '2026-10-03', TODAY), 'Terminó hace 16 días');
  assert.equal(countdownText('2026-10-10', null, TODAY), 'Terminó hace 9 días');
});

test('organizers · recorrido: «Te toca» solo con lo que trae la tarjeta', () => {
  assert.equal(toDoOf(card({ status: 'cancelada' }), TODAY), null);
  assert.equal(toDoOf(card({ start_date: '2026-10-01', end_date: '2026-10-03' }), TODAY), 'Terminó hace 16 días');
  assert.equal(toDoOf(card({ status: 'cerrada', start_date: null, end_date: null }), TODAY), null);
  assert.equal(toDoOf(card({ status: 'en_estudio', confirmed: false }), TODAY), 'Te toca: diseñar tu retiro');
  assert.equal(toDoOf(card({ status: 'negociacion', confirmed: false }), TODAY), 'Te toca: revisar el diseño y la propuesta');
  assert.equal(toDoOf(card({ status: 'pre_reservada', confirmed: false }), TODAY), 'Te toca: revisar la señal en Pagos');
  assert.equal(toDoOf(card({ start_date: '2026-10-18', end_date: '2026-10-20', guests: 0 }), TODAY), null);
  assert.equal(toDoOf(card({ mode: 'ninguno' }), TODAY), null);
  assert.equal(toDoOf(card({ guests: 0, expected_guests: 12 }), TODAY), 'Te toca: añadir a tus asistentes');
  assert.equal(toDoOf(card({ guests: 3, complete: 2 }), TODAY), 'Te toca: completar los datos de 1 asistente');
  assert.equal(toDoOf(card({ guests: 3, complete: 1, expected_guests: 12 }), TODAY), 'Te toca: completar los datos de 11 asistentes');
  assert.equal(toDoOf(card({ guests: 3, complete: 3 }), TODAY), null);
  // Con traducción: la frase entera es una clave.
  assert.equal(toDoOf(card({ status: 'en_estudio' }), TODAY, (s) => (s === 'Te toca: diseñar tu retiro' ? 'Your turn: design your retreat' : s)), 'Your turn: design your retreat');
});

const format = { money: (n: number) => `${n} €`, day: (d: string) => d, range: (a: string | null, b: string | null) => `${a}–${b}` };
const contract = (due: Contract['due'], total = 1000): Contract => ({ proposal_version: 1, total, deposit_required: 300, prices_include_vat: true, vat_amount: null, payment_type: null, due });
const money = (collected: number): PortalMoney => ({ reservation_id: 'r', currency: 'EUR', invoices: [], totals: { invoiced: 0, collected, pending: 0 } });
const input = (over: Partial<SummaryInput> & { status?: ReservationStatus; contract?: Contract | null } = {}): SummaryInput => ({
  detail: { status: over.status ?? 'confirmada', start_date: '2027-03-12', end_date: '2027-03-14', expected_guests: 12, requires_meals: true, meal_plan: 'pension_completa', menu_style: 'vegetariano', contract: over.contract ?? null },
  guests: over.guests ?? { confirmed: true, mode: 'ses', items: [] },
  dates: over.dates ?? null,
  joins: over.joins ?? { requests: 0, persons: 0 },
});
const ids = (steps: ReturnType<typeof summarySteps>) => steps.map((s) => `${s.id}${s.done ? ':hecho' : ''}`);

test('organizers · resumen: la señal atrasada va antes que las solicitudes; el saldo, después', () => {
  const due: Contract['due'] = [{ kind: 'senal', date: '2026-10-01', amount: 300 }, { kind: 'saldo', date: '2027-03-01', amount: 700 }];
  const late = summarySteps(input({ contract: contract(due), joins: { requests: 2, persons: 3 } }), { money: money(0) }, TODAY, format);
  assert.deepEqual(ids(late), ['paso_pagos', 'ver_solicitudes', 'paso_asistentes']);
  assert.equal(late[0]!.title, 'Pagar la señal (300 €)');
  assert.equal(late[0]!.stateText, 'Atrasado · era antes del 2026-10-01');
  assert.equal(late[1]!.title, 'Decidir 2 solicitudes para apuntarse');
  assert.equal(late[1]!.stateText, '3 personas piden apuntarse a tu retiro.');

  // Señal pagada: queda el saldo, nunca atrasado, detrás de las solicitudes.
  const balance = summarySteps(input({ contract: contract(due), joins: { requests: 1, persons: 1 } }), { money: money(300) }, TODAY, format);
  assert.deepEqual(ids(balance), ['ver_solicitudes', 'paso_pagos', 'paso_asistentes']);
  assert.equal(balance[1]!.title, 'Pagar el saldo (700 €)');
  assert.equal(balance[1]!.stateText, 'Saldo de 700 € pendiente · pagado 300 €');
  assert.equal(balance[0]!.title, 'Decidir 1 solicitud para apuntarse');

  // Señal aún en plazo.
  const onTime = summarySteps(input({ contract: contract([{ kind: 'senal', date: '2026-11-01', amount: 300 }, { kind: 'saldo', date: null, amount: 700 }]) }), { money: money(0) }, TODAY, format);
  assert.equal(onTime[0]!.title, 'Pagar la señal (300 €) antes del 2026-11-01');
  assert.equal(onTime[0]!.stateText, 'Señal de 300 € antes del 2026-11-01');

  // Todo pagado: hecho.
  const paid = summarySteps(input({ contract: contract(due) }), { money: money(1000) }, TODAY, format);
  assert.deepEqual(ids(paid), ['paso_pagos:hecho', 'paso_asistentes']);
  assert.equal(paid[0]!.title, 'Todo pagado · 1000 €');

  // Sin lectura de pagos (o fallida), el paso se omite.
  assert.deepEqual(ids(summarySteps(input({ contract: contract(due) }), { money: null }, TODAY, format)), ['paso_asistentes']);
});

const proposal = (over: Partial<PortalProposal>): PortalProposal => ({
  id: 'p1', version: 2, status: 'enviada', nature: 'orientativa', start_date: null, end_date: null, persons: 20, subtotal: 0, adjustments: 0, vat_amount: 0,
  total: 4000, deposit_amount: 0, valid_until: null, includes: null, excludes: null, sent_at: null, decided_at: null, conditions: null, lines: [], ...over,
});
const request = (over: Partial<PortalRequest>): PortalRequest => ({ id: 'q', kind: 'quiere_confirmar', proposal_id: 'p1', message: null, status: 'enviada', created_at: '', mine: true, ...over });

test('organizers · resumen: en diseño, fechas, propuesta y «Diseña tu retiro» con lo que falta', () => {
  const dates: PortalDates = { mode: 'ikisai_options', definitive: null, options: [] };
  const draft = (over: Partial<SummaryInput> = {}) => input({ status: 'negociacion', guests: { confirmed: false, mode: 'ses', items: [] }, dates, ...over });
  const steps = summarySteps(draft(), { proposals: [proposal({ valid_until: '2026-11-30' })], requests: [] }, TODAY, format);
  assert.deepEqual(ids(steps), ['ver_fechas', 'paso_propuesta', 'ver_diseno:hecho']);
  assert.equal(steps[0]!.stateText, 'Marca las fechas que te vienen bien; Ikisai confirmará la definitiva.');
  assert.equal(steps[1]!.stateText, 'Versión 2 · 4000 € orientativo · válida hasta el 2026-11-30');
  // Faltan solo las fechas, que ya tienen su paso: el formulario de diseño cuenta como hecho (design-checks, designPending).
  assert.equal(steps[2]!.stateText, 'Personas, comidas, alojamiento y extras, con el precio orientativo al momento.');
  const noGuests = draft();
  noGuests.detail = { ...noGuests.detail, expected_guests: null };
  const empty = summarySteps(noGuests, { proposals: [], requests: [] }, TODAY, format);
  assert.equal(empty.find((x) => x.id === 'ver_diseno')?.stateText, 'Lo que te falta por rellenar: 1 cosa');

  // Ya pidió confirmar: el paso de la propuesta no sale. Con una fecha marcada, fechas y diseño quedan hechos.
  const marked: PortalDates = { mode: 'ikisai_options', definitive: null, options: [{ id: 'a', start: '2027-03-12', end: '2027-03-14', arrival_time: null, departure_time: null, proposed_by: 'ikisai', organizer_ok: true, availability: 'libre' }] };
  const asked = summarySteps(draft({ dates: marked }), { proposals: [proposal({})], requests: [request({})] }, TODAY, format);
  assert.deepEqual(ids(asked), ['ver_fechas:hecho', 'ver_diseno:hecho']);
  assert.equal(asked[0]!.stateText, 'Has marcado 1 fecha; Ikisai confirmará la definitiva.');

  // Aceptada: hecho. Fecha fija: «Ver fechas».
  const fixed: PortalDates = { mode: 'fixed', definitive: { start: '2027-03-12', end: '2027-03-14', arrival_time: null, departure_time: null }, options: [] };
  const accepted = summarySteps(draft({ dates: fixed }), { proposals: [proposal({ status: 'aceptada' })], requests: [] }, TODAY, format);
  assert.deepEqual(ids(accepted), ['ver_fechas:hecho', 'paso_propuesta:hecho', 'ver_diseno:hecho']);
  assert.equal(accepted[0]!.title, 'Ver fechas');
  assert.equal(accepted[1]!.title, 'Versión 2 aceptada · 4000 €');

  // Sin lectura de fechas ni de la propuesta: se omiten.
  assert.deepEqual(ids(summarySteps(draft({ dates: null }), { proposals: null, requests: null }, TODAY, format)), ['ver_diseno:hecho']);
});

test('organizers · resumen: asistentes, y nada en cancelados ni terminados', () => {
  const g = (items: Array<{ missing: string[]; signed: boolean }>, mode: 'ses' | 'operativo' | 'ninguno' = 'ses') => input({ guests: { confirmed: true, mode, items } });
  assert.equal(summarySteps(g([]), {}, TODAY, format)[0]!.title, 'Añadir a tus asistentes');
  const some = summarySteps(g([{ missing: [], signed: true }, { missing: ['email'], signed: false }]), {}, TODAY, format)[0]!;
  assert.equal(some.title, 'Completar los datos de 1 asistente');
  assert.equal(some.stateText, '1 de 2 con los datos completos · 1 sin firmar');
  assert.equal(summarySteps(g([{ missing: [], signed: true }]), {}, TODAY, format)[0]!.done, true);
  assert.deepEqual(summarySteps(g([], 'ninguno'), {}, TODAY, format), []);
  assert.deepEqual(summarySteps(input({ status: 'cancelada' }), {}, TODAY, format), []);
  const past = input();
  past.detail = { ...past.detail, start_date: '2026-09-01', end_date: '2026-09-03' };
  assert.deepEqual(summarySteps(past, {}, TODAY, format), []);
});
