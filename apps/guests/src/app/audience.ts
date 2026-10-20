/**
 * Para quién es cada actividad del programa (MUELA-065, Booking §23 `audience`). Funciones puras.
 * - `todos` (o sin el dato): todas las personas.
 * - `adultos` y `menores`: lo decide la app con `is_minor` de cada persona.
 * - `personas`: solo los huéspedes de `audience_guest_ids`; Booking ya solo manda los del ámbito de quien lee, así que
 *   nunca se ve nada de otra familia.
 */
import type { ProgramItem } from './portal-types.ts';

export interface AudiencePerson { guestId: string; minor: boolean }

/** Las personas (de las que ve la app) a las que toca la actividad, en el orden de `persons`. */
export function audienceOf<P extends AudiencePerson>(item: Pick<ProgramItem, 'audience' | 'audience_guest_ids'>, persons: P[]): P[] {
  switch (item.audience ?? 'todos') {
    case 'adultos': return persons.filter((p) => !p.minor);
    case 'menores': return persons.filter((p) => p.minor);
    case 'personas': {
      const ids = new Set(item.audience_guest_ids ?? []);
      return persons.filter((p) => ids.has(p.guestId));
    }
    default: return persons;
  }
}

/** Las actividades que tocan a alguna de esas personas (con una sola, las suyas). */
export function itemsFor<T extends Pick<ProgramItem, 'audience' | 'audience_guest_ids'>>(items: T[], persons: AudiencePerson[]): T[] {
  return items.filter((i) => audienceOf(i, persons).length > 0);
}
