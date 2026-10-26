/** Booking · tanda 27 (MUELA-009, 020 y 067): la capa pura de la experiencia de cada reserva. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { experienceOf, foldText, nextText, peopleText, type ExperienceInput } from '../../supabase/functions/_domain/booking/mod.ts';

const TODAY = '2026-10-15';
const base = (over: Partial<ExperienceInput['reservation']> = {}): ExperienceInput['reservation'] => ({
  id: 'r1', status: 'confirmada', start_date: '2026-10-16', end_date: '2026-10-18', expected_guests: 24, priority: 'media', briefing_received: true, uses_accommodation: true, ...over,
});
const fullGuest = { first_name: 'A', last_name_1: 'B', last_name_2: 'C', birth_date: '1990-01-01', residence_address: 'x', residence_postal_code: '1', residence_city: 'x', residence_country: 'ESP', phone: '600', document_type: 'PAS', document_number: 'X1', signed_at: '2026-10-01T00:00:00Z' };

test('experiencia · fase y etapa comercial por propuestas o, sin permiso, por estado', () => {
  assert.equal(experienceOf({ reservation: base({ status: 'en_estudio' }) }, TODAY).commercial, 'contacto');
  assert.equal(experienceOf({ reservation: base({ status: 'negociacion' }) }, TODAY).commercial, 'propuesta', 'sin propuestas legibles, por el estado');
  assert.equal(experienceOf({ reservation: base({ status: 'negociacion' }), proposals: [] }, TODAY).commercial, 'contacto');
  assert.equal(experienceOf({ reservation: base({ status: 'negociacion' }), proposals: [{ status: 'enviada', version: 1 }] }, TODAY).commercial, 'propuesta');
  const accepted = experienceOf({ reservation: base({ status: 'negociacion' }), proposals: [{ status: 'aceptada', version: 2 }] }, TODAY);
  assert.equal(accepted.commercial, 'senal');
  assert.equal(accepted.journey, 'senal');
  assert.equal(experienceOf({ reservation: base({ status: 'en_ejecucion' }) }, TODAY).journey, 'estancia');
  assert.equal(experienceOf({ reservation: base({ status: 'cancelada' }) }, TODAY).journey, null);
  assert.equal(experienceOf({ reservation: base({ status: 'cerrada' }) }, TODAY).phase, 'cierre');
});

test('experiencia · preparación por áreas y «Siguiente» en orden: señal, finales, huéspedes, camas, personal, tareas', () => {
  const x = experienceOf({
    reservation: base(), event: { id: 'e1', final_guests: 24, closed_at: null },
    finance: { deposit_required: 2304, deposit_paid: 0 }, proposals: [{ status: 'aceptada', version: 3 }],
    guests: [fullGuest, { ...fullGuest, signed_at: null }], checklist: [{ status: 'hecho' }, { status: 'pendiente' }], uncoveredNeeds: 1, bedsAssigned: 20, sesPending: false,
  }, TODAY);
  assert.deepEqual(x.areas.map((a) => [a.key, a.ok, a.text]), [
    ['propuesta', true, 'Propuesta'], ['senal', false, 'Señal pendiente'], ['huespedes', false, 'Huéspedes · 1/24'],
    ['camas', false, 'Camas · 20/24'], ['personal', false, 'Personal · 1 refuerzo'], ['tareas', false, 'Tareas · 1/2'], ['ses', true, 'SES'],
  ]);
  assert.deepEqual(x.steps.map((s) => s.key), ['senal', 'huespedes', 'camas', 'personal', 'tareas']);
  assert.equal(nextText(x, true), 'Siguiente: Cobrar la señal');
  assert.equal(x.rush, 'Mañana · Cobrar la señal');
  assert.equal(x.next?.block, 'blockFinance');
});

test('experiencia · SES y el portal van primero y pesan más en «Lo primero»', () => {
  const ses = experienceOf({ reservation: base({ start_date: '2026-12-01', end_date: '2026-12-03' }), sesPending: true }, TODAY);
  assert.equal(ses.next?.key, 'ses');
  assert.equal(ses.rush, 'Faltan 47 días · Comunicar la reserva a SES', 'el plazo legal corre aunque falte mucho');
  const portal = experienceOf({ reservation: base({ start_date: '2026-12-01', end_date: '2026-12-03' }), unseenRequests: 2 }, TODAY);
  assert.equal(portal.next?.text, 'Ver 2 peticiones del organizador');
  const calm = experienceOf({ reservation: base({ start_date: '2026-12-01', end_date: '2026-12-03' }) }, TODAY);
  assert.ok(ses.score > portal.score && portal.score > calm.score);
  // SES desactivado: no hay nada que comunicar
  assert.ok(!experienceOf({ reservation: base({ ses_enabled: false }), sesPending: true }, TODAY).steps.some((s) => s.key === 'ses'));
});

test('experiencia · el lector no decide con lo que no ve', () => {
  const x = experienceOf({ reservation: base(), event: { id: 'e1', final_guests: 24 } }, TODAY);
  assert.deepEqual(x.areas, []);
  assert.equal(x.next, null);
  assert.equal(nextText(x, false), 'Nada pendiente de lo que puedes ver');
  assert.equal(x.rush, null);
});

test('experiencia · comercial: fechas, personas, propuesta, señal y confirmar', () => {
  const empty = experienceOf({ reservation: base({ status: 'en_estudio', start_date: null, end_date: null, expected_guests: null }), proposals: [] }, TODAY);
  assert.deepEqual(empty.steps.map((s) => s.text), ['Fijar las fechas', 'Indicar las personas previstas', 'Preparar la propuesta']);
  const draft = experienceOf({ reservation: base({ status: 'negociacion' }), proposals: [{ status: 'borrador', version: 2 }, { status: 'sustituida', version: 1 }] }, TODAY);
  assert.equal(draft.next?.text, 'Enviar la propuesta v2');
  const pre = experienceOf({ reservation: base({ status: 'pre_reservada', start_date: '2026-10-25', end_date: '2026-10-27' }), proposals: [{ status: 'aceptada', version: 1 }], finance: { deposit_required: 100, deposit_paid: 0 } }, TODAY);
  assert.deepEqual(pre.steps.map((s) => s.key), ['senal', 'confirmar']);
  assert.equal(pre.rush, 'Faltan 10 días · Cobrar la señal');
});

test('experiencia · en curso y cierre piden anotar el cierre; personas con su nombre; búsqueda sin tildes', () => {
  assert.equal(experienceOf({ reservation: base({ status: 'en_ejecucion', start_date: '2026-10-13', end_date: '2026-10-15' }) }, TODAY).next?.key, 'cierre');
  assert.equal(experienceOf({ reservation: base({ status: 'cerrada' }), event: { id: 'e', closed_at: null } }, TODAY).next?.text, 'Anotar el cierre operativo');
  assert.equal(experienceOf({ reservation: base({ status: 'cerrada' }), event: { id: 'e', closed_at: '2026-10-19T00:00:00Z' } }, TODAY).next, null);
  assert.equal(peopleText(24, 24), '24 personas');
  assert.equal(peopleText(24, null), '24 personas');
  assert.equal(peopleText(24, 22), '22 finales · 24 previstas');
  assert.equal(foldText('Yoga de OTOÑO'), 'yoga de otono');
});

// Jornadas abiertas y familiar (0482, VG 26-10-2026): se confirman sin propuesta ni señal.
test('experiencia · jornadas abiertas y familiar: sin propuesta ni señal; «Confirmar» es lo siguiente', () => {
  for (const type of ['jornadas_abiertas', 'familiar']) {
    const x = experienceOf({
      reservation: base({ status: 'pre_reservada', event_type: type }), proposals: [], finance: { deposit_required: 600, deposit_paid: 0 },
    }, TODAY);
    assert.deepEqual(x.steps.map((s) => s.key), ['confirmar'], type);
    assert.ok(!x.areas.some((a) => a.key === 'propuesta' || a.key === 'senal'), type);
    const live = experienceOf({ reservation: base({ event_type: type }), event: { id: 'e1', final_guests: 24, closed_at: null }, finance: { deposit_required: 600, deposit_paid: 0 }, proposals: [] }, TODAY);
    assert.ok(!live.areas.some((a) => a.key === 'propuesta' || a.key === 'senal'), `${type} en preparación`);
  }
  const retiro = experienceOf({ reservation: base({ status: 'pre_reservada', event_type: 'retiro' }), proposals: [], finance: { deposit_required: 600, deposit_paid: 0 } }, TODAY);
  assert.ok(retiro.steps.some((s) => s.key === 'propuesta'), 'el retiro sigue igual');
});
