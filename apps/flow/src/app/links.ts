import type { SyncClient } from '@ikisai/sync-client';
import { el, openSheet, toast } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from './actions.ts';
import { describeError } from './client.ts';
import type { Project, Unit } from './data.ts';

/**
 * Enlaces del flujo con Booking y Tasks (encargo de VG del 26-10):
 * - Evento de Booking (owner): `booking.event_projection`, abierta a Flow; se guardan el evento y sus fechas.
 * - Proyecto de Tasks (owner, una vez): la lista la da Tasks a través de flow-api, con la sesión de la persona.
 * - «Pedir a Tasks» desde una tarea: tarea o compra, una vez por tarea; el enlace queda en la tarea.
 */
export interface BookingEvent { event_id: string; event_code: string; name: string; kind: string; status: string; starts_on: string; ends_on: string; expected_attendance: number | null }

const fmt = (d: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00`));

function pick<T>(title: string, items: T[], label: (item: T) => string, empty: string): Promise<T | null> {
  return new Promise((resolve) => {
    let chosen: T | null = null;
    const sheet = openSheet({ title, onClose: () => resolve(chosen),
      body: items.length
        ? el('div', { class: 'flow-pick' }, ...items.map((item) => el('button', { type: 'button', class: 'secondary', onclick: () => { chosen = item; sheet.close(); } }, label(item))))
        : el('p', { class: 'muted' }, empty) });
  });
}

/** Elegir un evento de Booking (`booking.event_projection`). `null` si se cancela. */
export async function pickBookingEvent(client: SyncClient): Promise<BookingEvent | null> {
  const out = await client.api<{ rows: BookingEvent[] }>('/read/booking.event_projection?limit=200');
  const events = (out.rows ?? []).sort((a, b) => (a.starts_on ?? '').localeCompare(b.starts_on ?? ''));
  return pick('Evento de Booking', events, (e) => `${e.name} · ${fmt(e.starts_on)} – ${fmt(e.ends_on)} · ${e.status.replace('_', ' ')}`,
    'Booking no tiene eventos que Flow pueda ver (una reserva sin confirmar aún no tiene evento).');
}

export async function chooseBookingEvent(client: SyncClient, project: Project): Promise<void> {
  if (!isOnline(client)) { toast('Necesita conexión.'); return; }
  try {
    const event = await pickBookingEvent(client);
    if (!event) return;
    await client.commit([{ op: 'update', table: TABLES.projects, id: project.id, expectedRevision: project.revision,
      fields: { booking_event_id: event.event_id, starts_on: event.starts_on, ends_on: event.ends_on } }]);
    toast(`Flujo ligado a «${event.name}».`);
  } catch (error) { toast(describeError(error)); }
}

export async function chooseTasksProject(client: SyncClient, project: Project): Promise<void> {
  if (!isOnline(client)) { toast('Necesita conexión.'); return; }
  try {
    const out = await client.api<{ items: Array<{ id: string; title: string; area: string }> }>('/tasks/projects', { method: 'POST', json: {} });
    const chosen = await pick('Proyecto de Tasks', out.items, (p) => `${p.title} · ${p.area}`, 'No ves ningún proyecto abierto en Tasks.');
    if (!chosen) return;
    await client.commit([{ op: 'update', table: TABLES.projects, id: project.id, expectedRevision: project.revision, fields: { tasks_project_id: chosen.id } }]);
    toast(`«Pedir a Tasks» irá a «${chosen.title}».`);
  } catch (error) { toast(describeError(error)); }
}

/**
 * «Dar número a los huéspedes» (owner, 0910): lee los huéspedes del evento en Booking (`booking.flow_guests_of`,
 * solo nombre corto) y les da número de cliente en este flujo. Idempotente: quien ya tenía número lo conserva.
 */
export async function assignGuestNumbers(client: SyncClient, project: Project): Promise<void> {
  if (!isOnline(client)) { toast('Necesita conexión.'); return; }
  if (!project.booking_event_id) { toast('Liga antes el flujo a su evento de Booking.'); return; }
  try {
    const out = await client.api<{ items: Array<{ guest_id: string; display_name: string | null }> }>('/read/booking.flow_guests_of', {
      method: 'POST', json: { event_id: project.booking_event_id } });
    const guests = (out.items ?? []).map((g) => ({ guest_id: g.guest_id, display_name: g.display_name }));
    if (!guests.length) { toast('Booking no tiene huéspedes en ese evento.'); return; }
    const res = await callProcedure<{ created: number; updated: number }>(client, PROCEDURES.assignGuestNumbers, { project_id: project.id, guests });
    toast(res.created ? `${res.created} huéspedes con número nuevo (${guests.length} en total).` : `Los ${guests.length} huéspedes ya tenían número.`);
  } catch (error) { toast(describeError(error)); }
}

/** «Nuevo flujo de llegadas» (owner, 0911): de la plantilla `checkin`, ligado a un evento de Booking. Devuelve su id. */
export async function createCheckinFlow(client: SyncClient): Promise<string | null> {
  if (!isOnline(client)) { toast('Necesita conexión.'); return null; }
  try {
    const event = await pickBookingEvent(client);
    if (!event) return null;
    const out = await callProcedure<{ project_id: string; name: string }>(client, PROCEDURES.createFlow, { template_key: 'checkin', project_id: crypto.randomUUID(),
      name: `Llegadas · ${event.name}`.slice(0, 120), booking_event_id: event.event_id, starts_on: event.starts_on, ends_on: event.ends_on });
    await client.sync();
    toast(`Creado «${out.name}». Da acceso al personal en Central.`);
    return out.project_id;
  } catch (error) { toast(describeError(error)); return null; }
}

/** «Comprar X»: la compra a Tasks de un toque, con su cantidad y unidad. */
export async function quickPurchase(client: SyncClient, unit: Unit): Promise<void> {
  if (!isOnline(client)) { toast('Pedir a Tasks necesita conexión.'); return; }
  try {
    const out = await client.api<{ link: { app: string; kind: string; id: string; status?: string } }>(`/units/${unit.id}/tasks`, {
      // En unidades de compra si Food da el rendimiento (0918): «Comprar 3 unidad».
      method: 'POST', json: { type: 'purchase', quantity: unit.payload?.purchase_qty ?? unit.payload?.qty, unit: unit.payload?.purchase_unit ?? unit.payload?.unit } });
    toast('Compra pedida en Tasks.');
    void client.sync(); // el enlace lo anota flow-api (FL6)
  } catch (error) { toast(describeError(error)); }
}

/** «Pedir a Tasks» desde una tarea: tarea, o compra con cantidad. */
export function askTasks(client: SyncClient, unit: Unit): void {
  const qty = el('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: unit.payload?.qty !== undefined ? String(unit.payload.qty) : '', 'aria-label': 'Cantidad' });
  const measure = el('input', { type: 'text', maxlength: '20', value: unit.payload?.unit ?? '', 'aria-label': 'Unidad', placeholder: 'kg, ud…' });
  const send = async (type: 'task' | 'purchase') => {
    if (!isOnline(client)) { toast('Pedir a Tasks necesita conexión.'); return; }
    try {
      const out = await client.api<{ created: boolean; link: { app: string; kind: string; id: string; status?: string } }>(`/units/${unit.id}/tasks`, {
        method: 'POST', json: type === 'purchase' ? { type, quantity: Number(qty.value) || undefined, unit: measure.value || undefined } : { type } });
      toast(type === 'purchase' ? 'Compra pedida en Tasks.' : 'Tarea creada en Tasks.');
      void client.sync();
      sheet.close();
    } catch (error) { toast(describeError(error)); }
  };
  const sheet = openSheet({
    title: 'Pedir a Tasks',
    meta: unit.label ?? undefined,
    body: el('div', { class: 'flow-tasks-ask' },
      el('p', { class: 'muted small' }, 'Como tarea para quien la lleve en Tasks, o como solicitud de compra (la aprueba quien aprueba compras).'),
      el('div', { class: 'flow-tasks-qty' }, qty, measure)),
    foot: el('div', { class: 'flow-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: () => void send('task') }, 'Crear tarea'),
      el('button', { type: 'button', class: 'primary', onclick: () => void send('purchase') }, 'Pedir compra')),
  });
}
