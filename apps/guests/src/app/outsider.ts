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
}
export interface MyStays { items: Stay[]; default_bed: { space_name: string; bed_label: string | null } | null }
export interface StayNote { id: string; revision: number; at: string; text: string; mine: boolean; by: 'outsider' | 'staff' }
export interface Range { from: string; to: string }

export function isOutsider(client: SyncClient): boolean {
  return client.bootstrap()?.profile.houseLevel === 'outsider';
}

export interface OutsiderApi {
  stays(range?: Range): Promise<Loaded<MyStays>>;
  presence(range: Range): Promise<Loaded<{ items: Array<{ date: string; present: boolean }> }>>;
  notes(range: Range): Promise<Loaded<{ items: StayNote[] }>>;
  saveStay(input: { id: string; from: string; to: string; expectedRevision?: number }): Promise<{ id: string; revision: number; clash: boolean }>;
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
    presence: (range) => read('booking.portal_staff_presence', { ...range }),
    notes: (range) => read('booking.portal_stay_notes', { ...range }),
    saveStay: (input) => invoke('booking.portal_stay_save', { ...input }),
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
