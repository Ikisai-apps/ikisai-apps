/**
 * Alojamiento delegable (fase 5, API.md §16.1; Booking B17 en #328). Las camas y las asignaciones son de Booking:
 * - qué pueden hacer los asistentes: ver, además dar su preferencia, elegir o pedir cama. Se guarda en los dos lados: en
 *   la experiencia de Organizers (lo que lee Guests) y en los ajustes de Booking (lo que aplica su reserva atómica);
 * - qué habitaciones con baño (ya contratadas) se pueden elegir y cómo se llaman para ellos, con su nota de precio;
 * - reparto de camas, plazas pendientes de aprobar y preferencias de compañeros.
 */
import { el, icon, openSheet, replace, toast } from '@ikisai/ui-kit';
import { describeError, errorCode, online } from '../app/client.ts';
import { L, t } from '../app/i18n.ts';
import type { Row } from '../app/own.ts';
import { failure, fbIgnore, loading, section, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

interface Bed { bed_id: string; label: string; kind: string; free: boolean; assignment_id?: string; guest_id?: string | null; group_label?: string | null; status?: string; source?: string }
interface Room { space_id: string; name: string; zone: string | null; capacity: number | null; en_suite: boolean; small_en_suite: boolean; option_key: string | null; open: boolean; supplement: boolean; beds: Bed[] }
interface PortalRooms {
  settings: { revision: number | null; choice: 'off' | 'choose' | 'request'; choose_until: string | null; preferences: boolean; open: boolean };
  rooms: Room[];
  pending: Array<{ assignment_id: string; revision: number; guest_id: string; space_id: string; bed_id: string }>;
  preferences: Array<{ guest_id: string; text: string | null; ground_floor: boolean }>;
}
interface LodgingOption { key: string; label: string; guest_note?: string | null }

const CAPABILITIES: Array<[string, string]> = [
  ['view', L('Ven la habitación que les asignes')],
  ['prefer', L('Además, dicen con quién quieren compartir')],
  ['choose', L('Eligen su cama entre las habitaciones que abras')],
  ['request', L('Piden su cama y tú la apruebas')],
];
const slug = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'opcion';

/** Ajustes de Booking que corresponden a cada capacidad de la experiencia. */
export function bookingSettingsFor(capability: string): { choice: 'off' | 'choose' | 'request'; preferences: boolean } {
  if (capability === 'choose') return { choice: 'choose', preferences: true };
  if (capability === 'request') return { choice: 'request', preferences: true };
  return { choice: 'off', preferences: capability === 'prefer' };
}

export function renderLodging(ctx: ViewContext, reservationId: string, experience: () => Row | null, setExperience: (fields: Record<string, unknown>) => Promise<void>): HTMLElement {
  const host = el('div', { id: 'lodging' }, loading());
  let alive = true;
  let data: PortalRooms | null = null;
  let names = new Map<string, string>();
  let guestIds: string[] = [];

  async function load(): Promise<void> {
    try {
      const [rooms, guests] = await Promise.all([
        ctx.api.readAny<PortalRooms>('booking.portal_rooms', { reservation_id: reservationId }),
        ctx.api.guests(reservationId).then((g) => g.value.items).catch(() => []),
      ]);
      if (!alive) return;
      data = rooms.value;
      names = new Map(guests.map((g) => [g.id, g.display_name]));
      guestIds = guests.map((g) => g.id);
      paint(rooms.stale ? rooms.at : null);
    } catch (error) {
      if (!alive) return;
      replace(host, errorCode(error) === 'EVENT_REQUIRED'
        ? el('p', { class: 'muted', id: 'lodgingPending' }, t('Podrás organizar el alojamiento cuando la reserva esté confirmada.'))
        : failure(error, () => void load()));
    }
  }

  const nameOf = (id: string | null | undefined) => (id ? names.get(id) ?? t('Asistente') : '');

  async function act(featureRun: () => Promise<unknown>): Promise<boolean> {
    if (!online()) { toast(describeError({ code: 'OFFLINE' })); return false; }
    try {
      await featureRun();
      await load();
      return true;
    } catch (e) {
      const code = errorCode(e);
      toast(code === 'BED_TAKEN' ? t('Esa cama acaba de ocuparse. Elige otra.') : code === 'NOT_OFFERED' ? t('Esa habitación no se puede abrir: solo las de tu retiro con baño.') : describeError(e));
      await load();
      return false;
    }
  }

  function paint(staleAt: string | null): void {
    const d = data!;
    const exp = experience();
    const capability = String(exp?.lodging_capability ?? (d.settings.choice === 'off' ? (d.settings.preferences ? 'prefer' : 'view') : d.settings.choice));
    const chooseUntil = String(exp?.lodging_choose_until ?? d.settings.choose_until ?? '');
    const options = ((exp?.lodging_options as LodgingOption[] | undefined) ?? []).map((o) => ({ ...o }));
    const choosing = capability === 'choose' || capability === 'request';

    // --- Qué pueden hacer ---
    const capabilitySel = el('select', { id: 'lodging-capability', onchange: (e: Event) => void changeCapability((e.target as HTMLSelectElement).value) },
      ...CAPABILITIES.map(([v, l]) => el('option', { value: v, selected: v === capability ? '' : null }, t(l))));
    async function changeCapability(value: string): Promise<void> {
      await setExperience({ lodging_capability: value });
      await act(() => ctx.usage.run('organizers.alojamiento.ajustes', () => ctx.api.invokeAny('booking.portal_room_settings', { reservation_id: reservationId, ...bookingSettingsFor(value) })));
    }
    const untilInput = el('input', { type: 'date', id: 'lodging-until', value: chooseUntil, onchange: (e: Event) => void (async () => {
      const v = (e.target as HTMLInputElement).value || null;
      await setExperience({ lodging_choose_until: v });
      await act(() => ctx.api.invokeAny('booking.portal_room_settings', { reservation_id: reservationId, choose_until: v ?? '' }));
    })() });

    // --- Tipos de habitación (nota de precio para el huésped) ---
    const optionRows = el('div', { class: 'orgoptions', id: 'lodgingOptions' });
    let list = options;
    const commitOptions = () => void setExperience({ lodging_options: list.filter((o) => o.label.trim()).map((o) => ({ key: o.key || slug(o.label), label: o.label.trim(), guest_note: o.guest_note?.trim() || null })) });
    function paintOptions(): void {
      replace(optionRows, ...list.map((o, i) => el('div', { class: 'orgoption' },
        el('input', { type: 'text', maxlength: '120', value: o.label, placeholder: t('Habitación doble con baño'), 'aria-label': t('Tipo de habitación'),
          onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; list[i] = { ...list[i]!, label: v, key: list[i]!.key || slug(v) }; commitOptions(); } }),
        el('input', { type: 'text', maxlength: '200', value: o.guest_note ?? '', placeholder: t('+60 € a pagar a tu organizador'), 'aria-label': t('Lo que ve tu asistente del precio'),
          onchange: (e: Event) => { list[i] = { ...list[i]!, guest_note: (e.target as HTMLInputElement).value }; commitOptions(); } }),
        el('button', { type: 'button', class: 'ghost icon', 'aria-label': t('Quitar'), onclick: () => { list = list.filter((_, j) => j !== i); paintOptions(); commitOptions(); } }, icon('trash', 16)))));
    }
    paintOptions();

    // --- Habitaciones con baño que se pueden elegir ---
    const enSuite = d.rooms.filter((r) => r.en_suite);
    const saveRooms = (next: Room[]) => act(() => ctx.usage.run('organizers.alojamiento.habitaciones', () => ctx.api.invokeAny('booking.portal_room_settings', {
      reservation_id: reservationId, rooms: next.filter((r) => r.open).map((r) => ({ space_id: r.space_id, option_key: r.option_key, supplement: r.small_en_suite })),
    })));
    const openRows = enSuite.map((r) => el('div', { class: 'orgitem', 'data-room': r.space_id },
      el('label', { class: 'field check orgitem-main' },
        el('input', { type: 'checkbox', checked: r.open ? '' : null, onchange: (e: Event) => void saveRooms(enSuite.map((x) => (x.space_id === r.space_id ? { ...x, open: (e.target as HTMLInputElement).checked } : x))) }),
        el('span', null, el('strong', null, r.name), el('span', { class: 'muted small' }, ` · ${t('{n} camas', { n: r.beds.length })}${r.zone ? ` · ${r.zone}` : ''}`))),
      list.length ? el('select', { 'aria-label': t('Tipo de habitación'), disabled: r.open ? null : '',
        onchange: (e: Event) => void saveRooms(enSuite.map((x) => (x.space_id === r.space_id ? { ...x, option_key: (e.target as HTMLSelectElement).value || null } : x))) },
        el('option', { value: '' }, '—'), ...list.map((o) => el('option', { value: o.key, selected: o.key === r.option_key ? '' : null }, o.label))) : null));

    // --- Reparto de camas ---
    const bedButton = (room: Room, bed: Bed) => el('button', { type: 'button', class: `orgbed${bed.guest_id || bed.group_label ? ' taken' : ''}${bed.status === 'requested' ? ' pending' : ''}`, 'data-bed': bed.bed_id,
      onclick: () => assign(room, bed) },
      el('span', { class: 'orgbed-label' }, bed.label),
      fbIgnore(el('span', { class: 'small' }, bed.guest_id ? nameOf(bed.guest_id) : bed.group_label ?? t('Libre'))),
      bed.status === 'requested' ? el('span', { class: 'chip small warn' }, t('Pendiente')) : null);
    const roomsBlock = d.rooms.length
      ? el('div', { class: 'orgrooms' }, ...d.rooms.map((room) => el('div', { class: 'orgroom', 'data-space': room.space_id },
        el('h5', null, room.name, room.en_suite ? el('span', { class: 'muted small' }, ` · ${t('con baño')}`) : null),
        el('div', { class: 'orgbeds' }, ...room.beds.map((b) => bedButton(room, b))))))
      : el('p', { class: 'muted', id: 'lodgingNoRooms' }, t('Ikisai aún no ha asignado habitaciones a tu retiro.'));

    const pending = d.pending.map((p) => {
      const room = d.rooms.find((r) => r.space_id === p.space_id);
      const bed = room?.beds.find((b) => b.bed_id === p.bed_id);
      return el('div', { class: 'orgitem', 'data-pending': p.assignment_id },
        fbIgnore(el('span', { class: 'orgitem-main' }, el('strong', null, nameOf(p.guest_id)), ` · ${room?.name ?? ''} · ${bed?.label ?? ''}`)),
        el('button', { type: 'button', class: 'ghost small', 'data-action': 'reject', onclick: () => void act(() => ctx.usage.run('organizers.alojamiento.aprobar', () => ctx.api.invokeAny('booking.portal_approve_bed', { reservation_id: reservationId, assignment_id: p.assignment_id, approve: false }))) }, t('Rechazar')),
        el('button', { type: 'button', class: 'primary small', 'data-action': 'approve', onclick: () => void act(() => ctx.usage.run('organizers.alojamiento.aprobar', () => ctx.api.invokeAny('booking.portal_approve_bed', { reservation_id: reservationId, assignment_id: p.assignment_id, approve: true }))) }, t('Aprobar')));
    });

    replace(host,
      staleAt ? staleNote(staleAt) : null,
      section(t('Qué pueden hacer tus asistentes'), { id: 'lodgingSettings' },
        el('label', { class: 'field' }, el('span', null, t('Qué pueden hacer')), capabilitySel),
        choosing ? el('label', { class: 'field' }, el('span', null, t('Pueden elegir hasta el')), untilInput) : null,
        el('p', { class: 'muted small' }, t('Solo eligen entre las camas que ya has contratado con Ikisai; elegir no cambia lo que te factura.'))),
      choosing ? section(t('Habitaciones que pueden elegir'), { id: 'lodgingOpen' },
        el('p', { class: 'muted small' }, t('Tipos de habitación que ofreces y lo que les dices del precio. Nunca ven lo que te cobra Ikisai.')),
        optionRows,
        el('button', { type: 'button', class: 'ghost', id: 'lodgingAddOption', onclick: () => { list.push({ key: '', label: '', guest_note: '' }); paintOptions(); optionRows.querySelector<HTMLInputElement>('.orgoption:last-child input')?.focus(); } }, icon('plus', 16), ' ', t('Añadir tipo de habitación')),
        enSuite.length ? el('div', { class: 'orgitems' }, ...openRows) : el('p', { class: 'muted small' }, t('Tu retiro no tiene habitaciones con baño para abrir.'))) : null,
      pending.length ? section(t('Pendientes de aprobar'), { id: 'lodgingPendingList' }, el('div', { class: 'orgitems' }, ...pending)) : null,
      section(t('Reparto de camas'), { id: 'lodgingRooms' },
        el('p', { class: 'muted small' }, t('Toca una cama para asignarla a un asistente o dejarla libre.')),
        roomsBlock),
      d.preferences.length ? section(t('Preferencias de tus asistentes'), { id: 'lodgingPreferences' },
        fbIgnore(el('ul', { class: 'plainlist' }, ...d.preferences.map((p) => el('li', null, el('strong', null, nameOf(p.guest_id)),
          p.text ? ` · ${p.text}` : '', p.ground_floor ? ` · ${t('Necesita planta baja o accesible')}` : ''))))) : null);
  }

  function assign(room: Room, bed: Bed): void {
    const assigned = new Set(data!.rooms.flatMap((r) => r.beds.map((b) => b.guest_id).filter(Boolean)) as string[]);
    const select = el('select', { id: 'bed-guest' },
      el('option', { value: '' }, bed.guest_id ? t('Dejarla libre') : '—'),
      ...guestIds.map((id) => el('option', { value: id, selected: id === bed.guest_id ? '' : null }, `${nameOf(id)}${assigned.has(id) && id !== bed.guest_id ? ` (${t('ya tiene cama')})` : ''}`))) as HTMLSelectElement;
    const sheet = openSheet({
      title: `${room.name} · ${bed.label}`,
      panelAttrs: { id: 'bedSheet' },
      body: el('div', null,
        bed.group_label && !bed.guest_id ? el('p', { class: 'muted small' }, t('Ikisai la tiene reservada para tu grupo.')) : null,
        el('label', { class: 'field' }, el('span', null, t('Asistente')), select),
        el('p', { class: 'muted small' }, t('Si ya tenía otra cama, se la cambiamos a esta.'))),
      foot: el('div', { class: 'choices' }, el('button', { type: 'button', class: 'primary', id: 'bed-save', onclick: () => void save() }, t('Guardar'))),
    });
    async function save(): Promise<void> {
      const guest = select.value;
      const ok = guest
        ? await act(() => ctx.usage.run('organizers.alojamiento.asignar', () => ctx.api.invokeAny('booking.portal_assign_bed', { reservation_id: reservationId, guest_id: guest, bed_id: bed.bed_id })))
        : bed.guest_id ? await act(() => ctx.usage.run('organizers.alojamiento.asignar', () => ctx.api.invokeAny('booking.portal_assign_bed', { reservation_id: reservationId, guest_id: bed.guest_id, bed_id: null }))) : true;
      if (ok) await sheet.close(true);
    }
  }

  void load();
  (host as HTMLElement & { destroy?: () => void; refresh?: () => void }).destroy = () => { alive = false; };
  return host;
}
