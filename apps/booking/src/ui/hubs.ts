/**
 * Entradas del menú a lo que vivía dentro de otras pantallas (VG, 28-10: «toda página con alguna funcionalidad debería poder
 * abrirse desde el menú»):
 * - «Dormitorios» (`#/dormitorios`, en La casa): cada habitación con camas y su «Monta el dormitorio», desplegable.
 * - «Personal» (`#/personal`, en Reservas): los turnos de los eventos en curso y próximos, con «Anotar turno» en cada uno.
 * Son las mismas piezas que la ficha del espacio y la de la reserva; cambian solo la entrada.
 */
import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import { el, formatDate, replace, toast } from '@ikisai/ui-kit';
import { ASSIGNMENTS, BEDS, EVENTS, RESERVATIONS, SPACES, STAFF, canRead, canWrite, describeError } from '../app/client.ts';
import { createDormitorio } from './dormitorio.ts';
import { occupiedTonight } from './spaceCard.ts';
import { spacesSource } from './spacesResources.ts';
import { createStaffBlock, loadStaff } from './staff.ts';
import type { ViewMount } from './shell.ts';

type Row = SyncedRow & Record<string, any>;
const localToday = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const byPosition = (a: Row, b: Row) => (Number(a.position) || 0) - (Number(b.position) || 0) || String(a.name ?? a.label).localeCompare(String(b.name ?? b.label), 'es');

export const mountDormitories: ViewMount = ({ main, client }) => {
  const owner = client.bootstrap()?.membership.role === 'owner';
  const host = el('div', { id: 'dormList' }, el('p', { class: 'hint' }, 'Cargando…'));
  const open = new Set<string>();
  const dorms = new Map<string, ReturnType<typeof createDormitorio>>();
  replace(main, el('section', { class: 'view', 'data-feedback-id': 'booking.espacios.dormitorios', 'data-feedback-label': 'Dormitorios' },
    el('h2', null, 'Dormitorios'), el('p', { class: 'hint' }, 'Cada habitación con sus camas. Ábrela para colocarlas, añadirlas, quitarlas o cambiar sus plazas.'), host));

  async function paint(): Promise<void> {
    if (dorms.size && [...dorms.values()].some((d) => d.editing())) return;
    const fromResources = (await spacesSource(client)) === 'resources';
    const [spaces, beds, assignments, events, reservations] = await Promise.all([client.list(SPACES), client.list(BEDS),
      canRead(client, ASSIGNMENTS) ? client.list(ASSIGNMENTS) : Promise.resolve([]), canRead(client, EVENTS) ? client.list(EVENTS) : Promise.resolve([]),
      canRead(client, RESERVATIONS) ? client.list(RESERVATIONS) : Promise.resolve([])]) as [Row[], Row[], Row[], Row[], Row[]];
    const live = (r: Row) => r.deleted_at === null || r.deleted_at === undefined;
    const liveBeds = beds.filter(live).sort(byPosition);
    const liveAssign = assignments.filter(live);
    const occupied = occupiedTonight(liveAssign, events, reservations, localToday());
    const rooms = spaces.filter((s) => live(s) && s.active !== false && (s.kind === 'habitacion' || liveBeds.some((b) => b.space_id === s.id))).sort(byPosition);
    dorms.forEach((d) => d.destroy()); dorms.clear();
    if (!rooms.length) return void replace(host, el('p', { class: 'hint' }, 'No hay habitaciones con camas.'));
    replace(host, ...rooms.map((s) => {
      const own = liveBeds.filter((b) => b.space_id === s.id);
      const body = el('div');
      const details = el('details', { class: 'card', dataset: { space: s.id }, open: open.has(s.id), 'data-feedback-id': 'booking.espacios.dormitorios.habitacion', 'data-feedback-label': 'Habitación',
        ontoggle: () => {
          if (!details.open) { open.delete(s.id); return; }
          open.add(s.id);
          if (!dorms.has(s.id)) {
            const d = createDormitorio({ client, space: s, beds: own, assignments: liveAssign, occupied, canEdit: owner && s.kind !== 'zona_exterior', fromResources });
            dorms.set(s.id, d); replace(body, d.element);
          }
        } },
        el('summary', null, el('strong', null, s.name), ` · ${own.filter((b) => b.active !== false).length} camas${s.zone ? ` · ${s.zone}` : ''}`), body) as HTMLDetailsElement;
      if (open.has(s.id)) { const d = createDormitorio({ client, space: s, beds: own, assignments: liveAssign, occupied, canEdit: owner && s.kind !== 'zona_exterior', fromResources }); dorms.set(s.id, d); body.append(d.element); }
      return details;
    }));
  }
  const offs = [SPACES, BEDS, ASSIGNMENTS].map((t) => client.onTable(t, () => void paint()));
  void paint();
  return () => { offs.forEach((off) => off()); dorms.forEach((d) => d.destroy()); };
};

export const mountStaffHub: ViewMount = ({ main, client, navigate }) => {
  const editable = canWrite(client);
  const host = el('div', { id: 'staffHub' }, el('p', { class: 'hint' }, 'Cargando…'));
  const blocks = new Map<string, ReturnType<typeof createStaffBlock>>();
  replace(main, el('section', { class: 'view', 'data-feedback-id': 'booking.reservas.personal', 'data-feedback-label': 'Personal' },
    el('h2', null, 'Personal'), el('p', { class: 'hint' }, 'Los turnos de los eventos en curso y de los próximos. Solo nombres: sin teléfono ni documento.'), host));

  async function run(operations: RowOperation[], message: string): Promise<boolean> {
    try { await client.commit(operations); toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`); return true; }
    catch (error) { toast(describeError(error)); return false; }
  }

  async function paint(): Promise<void> {
    if (!canRead(client, STAFF)) return void replace(host, el('p', { class: 'hint' }, 'Tu cuenta no ve el personal de los eventos.'));
    const today = localToday();
    const [events, reservations] = await Promise.all([client.list(EVENTS), client.list(RESERVATIONS)]) as [Row[], Row[]];
    const resOf = new Map(reservations.filter((r) => !r.deleted_at).map((r) => [r.id, r]));
    const upcoming = events.filter((e) => !e.deleted_at && resOf.has(e.reservation_id))
      .map((e) => ({ event: e, reservation: resOf.get(e.reservation_id)! }))
      .filter((x) => !['cancelada', 'perdida'].includes(x.reservation.status) && String(x.reservation.end_date ?? x.reservation.start_date ?? '') >= today)
      .sort((a, b) => String(a.reservation.start_date).localeCompare(String(b.reservation.start_date)));
    if (!upcoming.length) return void replace(host, el('p', { class: 'hint' }, 'No hay eventos en curso ni próximos.'));
    const sections: HTMLElement[] = [];
    for (const { event, reservation } of upcoming) {
      const data = await loadStaff(client, event.id);
      if (!data) continue;
      let block = blocks.get(event.id);
      if (!block) { block = createStaffBlock(); blocks.set(event.id, block); }
      sections.push(el('section', { class: 'staff-hub-event', dataset: { event: event.id }, 'data-feedback-id': 'booking.reservas.personal.evento', 'data-feedback-label': 'Evento' },
        el('h3', null, el('a', { href: `#/reservas/${reservation.id}`, onclick: (e: Event) => { e.preventDefault(); navigate(`#/reservas/${reservation.id}`); } }, reservation.title),
          el('span', { class: 'hint' }, ` · ${formatDate(reservation.start_date)}${reservation.end_date ? ` – ${formatDate(reservation.end_date)}` : ''}`)),
        block.render({ client, reservation, event, data, editable, run })));
    }
    replace(host, ...sections);
  }
  const offs = [STAFF, EVENTS, RESERVATIONS].map((t) => client.onTable(t, () => void paint()));
  void paint();
  return () => { offs.forEach((off) => off()); blocks.forEach((b) => b.destroy()); };
};
