/**
 * Lo del outsider en Guests (O4b; Booking §26, Food §2.6 y contrato §3.10). El nivel de casa sale de
 * `bootstrap.profile.houseLevel`; en Guests el outsider es `editor` y sus lecturas van por su propia cuenta (sin
 * `guest_id`). Las lecturas guardan su última respuesta en la caché para verlas sin red; las acciones y las sugerencias
 * necesitan red.
 */
import type { Suggestion, SyncClient } from '@ikisai/sync-client';
import { houseDishSuggestionOperations, HOUSE_DISH_SUGGESTION_KIND, type ServiceType } from '@ikisai/domain-food';
import type { Loaded } from './api.ts';
import { cache } from './cache.ts';
import { isNetworkError } from './client.ts';

export interface StayPerson { person_key: string; name: string }
export interface Stay {
  id: string; revision: number; from: string; to: string; source: 'guest' | 'staff';
  persons: StayPerson[]; space_name: string | null; zone: string | null; bed_label: string | null; clash: boolean;
  /** Su pareja en Recursos (Booking #680), para el mapa; null si no la hay. */
  resource_space_id?: string | null; resource_bed_id?: string | null;
}
export interface MyStays { items: Stay[]; default_bed: { space_name: string; bed_label: string | null; resource_space_id?: string | null; resource_bed_id?: string | null } | null }
export interface StayNote { id: string; revision: number; at: string; text: string; mine: boolean; by: 'outsider' | 'staff' }
export interface Range { from: string; to: string }
/** Plato del menú de casa (Food §7.6): nombre público y los alérgenos declarados, siempre, con `allergens_checked` (#597). */
export interface HouseDish { name: string; quick?: boolean; allergens: string[]; allergens_checked: boolean }
/** El menú de casa (`food.portal_house_menu`, FD2): desde hoy y como mucho 60 días. */
export interface HouseMenu { from: string; to: string; services: Array<{ date: string; type: string; time: string | null; dishes: HouseDish[] }> }
/**
 * Retiro abierto a huéspedes (Booking §26.1): visible, vivo y sin precio. `joined`: ya tiene una entrada en él. `request`:
 * su «Apuntarme» una vez que el personal lo pasó al organizador (§26.3); lo pendiente con Ikisai es la propia sugerencia.
 */
export interface OpenRetreat {
  reservation_id: string; title: string; start_date: string | null; end_date: string | null; summary: string | null; joined: boolean;
  request?: { status: 'con_el_organizador' | 'aceptada' | 'descartada'; comment: string | null } | null;
}

export function isOutsider(client: SyncClient): boolean {
  return client.bootstrap()?.profile.houseLevel === 'outsider';
}

export interface OutsiderApi {
  stays(range?: Range): Promise<Loaded<MyStays>>;
  /** El menú de casa de Food (FD2); con copia para verlo sin red. */
  houseMenu(range?: Partial<Range>): Promise<Loaded<HouseMenu>>;
  presence(range: Range): Promise<Loaded<{ items: Array<{ date: string; present: boolean }> }>>;
  notes(range: Range): Promise<Loaded<{ items: StayNote[] }>>;
  saveStay(input: { id: string; from: string; to: string; expectedRevision?: number; persons?: StayPerson[] }): Promise<{ id: string; revision: number; clash: boolean }>;
  /** Separa a unas personas de una estancia, con sus fechas (la misma cama). */
  splitStay(input: { id: string; person_keys: string[]; from: string; to: string }): Promise<Stay>;
  /** Une las fichas de una persona (de retiros distintos) bajo una clave y la devuelve. */
  personLink(guestIds: string[]): Promise<{ person_key: string }>;
  removeStay(id: string, expectedRevision?: number): Promise<unknown>;
  saveNote(input: { id: string; at: string; text: string; expectedRevision?: number }): Promise<{ id: string; revision: number }>;
  removeNote(id: string, expectedRevision?: number): Promise<unknown>;
  /** «Sugerir un plato» para el menú de casa (Food, `plato_casa`): una sugerencia que aprueba cocina. */
  suggestDish(input: { name: string; date: string; service: ServiceType }, summary: string): Promise<Suggestion>;
}

export function createOutsiderApi(client: SyncClient): OutsiderApi {
  const userId = () => client.bootstrap()?.profile.userId ?? 'anon';
  async function read<T>(name: string, args: Record<string, unknown>): Promise<Loaded<T>> {
    try {
      const value = await client.api<T>(`/read/${name}`, { method: 'POST', json: args });
      void cache.saveRead(userId(), name, args, value);
      return { value, at: new Date().toISOString(), stale: false };
    } catch (error) {
      if (isNetworkError(error)) {
        const copy = await cache.read<T>(userId(), name, args);
        if (copy) return { value: copy.value, at: copy.at, stale: true };
      }
      throw error;
    }
  }
  const invoke = <T>(name: string, args: Record<string, unknown>) => client.api<T>(`/invoke/${name}`, { method: 'POST', json: args });
  return {
    stays: (range) => read('booking.portal_my_stays', range ? { ...range } : {}),
    houseMenu: (range) => read('food.portal_house_menu', range ? { ...range } : {}),
    presence: (range) => read('booking.portal_staff_presence', { ...range }),
    notes: (range) => read('booking.portal_stay_notes', { ...range }),
    saveStay: (input) => invoke('booking.portal_stay_save', { ...input }),
    splitStay: (input) => invoke('booking.portal_stay_split', { ...input }),
    personLink: (guestIds) => personLink(client, guestIds),
    removeStay: (id, expectedRevision) => invoke('booking.portal_stay_remove', { id, ...(expectedRevision ? { expectedRevision } : {}) }),
    saveNote: (input) => invoke('booking.portal_stay_note_save', { ...input }),
    removeNote: (id, expectedRevision) => invoke('booking.portal_stay_note_remove', { id, ...(expectedRevision ? { expectedRevision } : {}) }),
    suggestDish: (input, summary) => client.suggest({
      app: 'food', kind: HOUSE_DISH_SUGGESTION_KIND, summary, detail: { ...input }, operations: houseDishSuggestionOperations(input),
    }),
  };
}

/** Día y hora en Madrid de un instante (`at` de las notas, `timestamptz`). */
export function madridParts(at: string): { day: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

/** Instante de una hora de pared en Madrid (`AAAA-MM-DD`, `HH:MM`), con su desfase de ese día (verano o invierno). */
export function madridInstant(day: string, time: string): string {
  const guess = new Date(`${day}T${time}:00Z`);
  const shown = madridParts(guess.toISOString());
  const offsetMin = (Date.parse(`${shown.day}T${shown.time}:00Z`) - guess.getTime()) / 60000;
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}

/** Retiros abiertos a huéspedes en un rango (cualquier huésped, no solo outsider); sin la lectura, ninguno. */
export async function openRetreats(client: SyncClient, range: Range): Promise<OpenRetreat[]> {
  try {
    const out = await client.api<{ items?: OpenRetreat[] }>('/read/booking.portal_open_retreats', { method: 'POST', json: { ...range } });
    return out.items ?? [];
  } catch {
    return [];
  }
}

/** Une las fichas de una persona bajo una clave de Booking (cualquier huésped, `portal_person_link`) y la devuelve. */
export function personLink(client: SyncClient, guestIds: string[]): Promise<{ person_key: string }> {
  return client.api(`/invoke/booking.portal_person_link`, { method: 'POST', json: { guest_ids: guestIds } });
}

/** Tipo de sugerencia de Booking para «Apuntarme» (§26.3). */
export const JOIN_KIND = 'apuntarme';

export interface JoinPerson { name: string; personKey: string | null; guestIds: string[] }

/**
 * «Apuntarme» a un retiro abierto: una sugerencia `apuntarme` a Booking que acepta el personal (o pasa al organizador).
 * Las personas van con su clave de Booking; una sin fichas (el titular sin retiros) va solo con su nombre.
 */
export async function sendJoin(client: SyncClient, retreat: Pick<OpenRetreat, 'reservation_id' | 'title'>, people: JoinPerson[], message: string | null, summary: string): Promise<Suggestion> {
  const persons = await Promise.all(people.map(async (p) => {
    const key = p.personKey ?? (p.guestIds.length ? (await personLink(client, p.guestIds)).person_key : null);
    return { ...(key ? { person_key: key } : {}), name: p.name };
  }));
  return client.suggest({
    app: 'booking', kind: JOIN_KIND, summary,
    detail: { reservation_id: retreat.reservation_id, title: retreat.title, persons: persons.map((p) => p.name), ...(message ? { message } : {}) },
    operations: [{ op: 'call', procedure: 'booking.join_from_suggestion', args: { reservation_id: retreat.reservation_id, persons, ...(message ? { message } : {}) } }],
  });
}

/** Sus «Apuntarme» por retiro: la última sugerencia de cada uno (sin red, ninguna). */
export async function joinSuggestions(client: SyncClient): Promise<Map<string, Suggestion>> {
  try {
    const { items } = await client.suggestions({ scope: 'mine', app: 'booking' });
    const out = new Map<string, Suggestion>();
    for (const s of items.filter((x) => x.kind === JOIN_KIND).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const id = (s.detail?.reservation_id as string | undefined) ?? ((s.operations[0] as { args?: { reservation_id?: string } } | undefined)?.args?.reservation_id);
      if (id) out.set(id, s);
    }
    return out;
  } catch {
    return new Map();
  }
}
