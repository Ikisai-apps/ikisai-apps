/**
 * Personas y retiros de la cuenta (O4a, RECURSOS.md §17; preparación de O4 §2.3 y §5). Cada entrada del ámbito es una
 * persona en un retiro (una ficha de Booking). Aquí se agrupan:
 * - por **retiro** (`reservation_id`), para las pestañas y el calendario;
 * - por **persona**, para el selector «Todos · Marta · Nico».
 * Hasta que Booking publique una clave de persona (O2: la persona de Central o una `person_key`), la misma persona en dos
 * retiros se reconoce por su nombre y primer apellido (sin mayúsculas ni tildes). Sin nombre, cada ficha es su persona.
 */
import type { Grant, GuestApi, MyGuest } from './api.ts';

export interface RosterEntry { grant: Grant; guest: MyGuest | null; person: string }
export interface Person { key: string; name: string; initials: string }
export interface Retreat {
  reservation_id: string;
  title: string | null;
  start: string | null;
  end: string | null;
  /** Una por persona de la cuenta en este retiro, en el orden de las personas. */
  entries: RosterEntry[];
}
export interface Roster { entries: RosterEntry[]; persons: Person[]; retreats: Retreat[] }

/** «Todos» o la clave de una persona. */
export type Selection = 'all' | string;

const fold = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

function personKey(entry: { grant: Grant; guest: MyGuest | null }): string {
  const first = fold(entry.guest?.fields.first_name);
  if (!first) return `ficha:${entry.grant.guest_id}`;
  return `nombre:${first}|${fold(entry.guest?.fields.last_name_1)}`;
}

export function buildRoster(loaded: Array<{ grant: Grant; guest: MyGuest | null }>): Roster {
  const entries: RosterEntry[] = loaded.map((item) => ({ ...item, person: personKey(item) }));
  const persons: Person[] = [];
  for (const entry of entries) {
    if (persons.some((p) => p.key === entry.person)) continue;
    persons.push({ key: entry.person, name: String(entry.guest?.fields.first_name ?? '').trim(), initials: '' });
  }
  // Mismo nombre de pila en dos personas: se añade el apellido para distinguirlas.
  for (const person of persons) {
    if (persons.filter((p) => p.name === person.name).length > 1) {
      const surname = String(entries.find((e) => e.person === person.key)?.guest?.fields.last_name_1 ?? '').trim();
      if (surname) person.name = `${person.name} ${surname}`;
    }
    person.initials = person.name.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('').slice(0, 2);
  }
  // Por nombre, para que el selector salga siempre igual (sin nombre, al final).
  persons.sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.name.localeCompare(b.name, 'es'));
  const order = new Map(persons.map((p, i) => [p.key, i]));
  const byReservation = new Map<string, Retreat>();
  for (const entry of entries) {
    const r = entry.guest?.reservation;
    const retreat = byReservation.get(entry.grant.reservation_id)
      ?? { reservation_id: entry.grant.reservation_id, title: r?.title ?? null, start: r?.start_date ?? null, end: r?.end_date ?? r?.start_date ?? null, entries: [] };
    if (!retreat.title && r) Object.assign(retreat, { title: r.title, start: r.start_date, end: r.end_date ?? r.start_date });
    retreat.entries.push(entry);
    byReservation.set(entry.grant.reservation_id, retreat);
  }
  const retreats = [...byReservation.values()];
  for (const retreat of retreats) retreat.entries.sort((a, b) => order.get(a.person)! - order.get(b.person)!);
  // Por fecha de inicio; los que no tienen fecha (sin red), al final.
  retreats.sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999'));
  return { entries, persons, retreats };
}

export async function loadRoster(api: GuestApi): Promise<Roster> {
  const grants = api.grants();
  const loaded = await Promise.all(grants.map(async (grant) => {
    try { return { grant, guest: (await api.myGuest(grant.guest_id)).value }; } catch { return { grant, guest: null }; }
  }));
  return buildRoster(loaded);
}

/** Retiros que se ven con la selección: todos con «Todos», o los de esa persona. */
export function retreatsFor(roster: Roster, selection: Selection): Retreat[] {
  return selection === 'all' ? roster.retreats : roster.retreats.filter((r) => r.entries.some((e) => e.person === selection));
}

/** Entradas del retiro que se ven con la selección. */
export function entriesFor(retreat: Retreat, selection: Selection): RosterEntry[] {
  return selection === 'all' ? retreat.entries : retreat.entries.filter((e) => e.person === selection);
}

export type When = 'before' | 'during' | 'after';
export function whenOf(retreat: Pick<Retreat, 'start' | 'end'>, today: string): When {
  if (retreat.start && today < retreat.start) return 'before';
  if (retreat.end && today > retreat.end) return 'after';
  return retreat.start ? 'during' : 'before';
}

/**
 * Retiro de entrada (decisión del usuario, 13-10-2026): el del enlace; si no, el que está en curso; si no, el próximo. Sin
 * ninguno, null (y se abre el calendario; la pestaña Outsider llega con O4b). Con una sola ficha, esa es la del enlace.
 */
export function entryRetreat(roster: Roster, selection: Selection, today: string, linkedGuestId?: string | null): Retreat | null {
  const list = retreatsFor(roster, selection);
  if (roster.entries.length === 1) return roster.retreats[0] ?? null;
  const linked = linkedGuestId ? list.find((r) => r.entries.some((e) => e.grant.guest_id === linkedGuestId)) : null;
  if (linked) return linked;
  return list.find((r) => whenOf(r, today) === 'during')
    ?? list.filter((r) => r.start && whenOf(r, today) === 'before').sort((a, b) => a.start!.localeCompare(b.start!))[0]
    ?? null;
}

/** Retiro que abre «Retiros» si aún no se ha elegido ninguno: el de entrada o, si no hay, el último que pasó. */
export function defaultRetreat(roster: Roster, selection: Selection, today: string): Retreat | null {
  const list = retreatsFor(roster, selection);
  return entryRetreat(roster, selection, today) ?? [...list].reverse().find((r) => whenOf(r, today) === 'after') ?? list[0] ?? null;
}
