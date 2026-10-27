/**
 * Dirección en Guests (API.md §9.17 c; Booking §29.5): con «todos» (`{all: true}`), `portal_open_retreats` devuelve
 * `direction: true` y todos los retiros, pasados y futuros, con `joinable` en los vivos; `portal_join_direction` la apunta
 * sin aprobación. «Todos» nunca vale por la ficha de otro huésped: aquí no se pide nada con `guest_id`.
 */
import type { SyncClient } from '@ikisai/sync-client';
import type { Loaded } from './api.ts';
import { cache } from './cache.ts';
import { isNetworkError } from './client.ts';
import { personLink, type JoinPerson } from './outsider.ts';

export interface DirectionRetreat {
  reservation_id: string; title: string | null; start_date: string | null; end_date: string | null;
  status: string | null; joinable: boolean; joined: boolean;
}

const READ = 'booking.portal_open_retreats';
const ARGS = { direction: true };

/** Todos los retiros para dirección, con copia sin red; null si la cuenta no es de dirección o no hay lectura. */
export async function allRetreats(client: SyncClient): Promise<Loaded<DirectionRetreat[]> | null> {
  const user = client.bootstrap()?.profile.userId ?? 'anon';
  try {
    const out = await client.api<{ direction?: boolean; items?: Array<Partial<DirectionRetreat> & { reservation_id: string }> }>(`/read/${READ}`, { method: 'POST', json: {} });
    if (out.direction !== true) return null;
    const items = (out.items ?? []).map((i) => ({
      reservation_id: i.reservation_id, title: i.title ?? null, start_date: i.start_date ?? null, end_date: i.end_date ?? null,
      status: i.status ?? null, joinable: i.joinable === true, joined: i.joined === true,
    }));
    void cache.saveRead(user, READ, ARGS, items);
    return { value: items, at: new Date().toISOString(), stale: false };
  } catch (error) {
    if (isNetworkError(error)) {
      const copy = await cache.read<DirectionRetreat[]>(user, READ, ARGS);
      return copy ? { value: copy.value, at: copy.at, stale: true } : null;
    }
    return null;
  }
}

/**
 * Apuntarse como dirección a un retiro vivo. Sin `people`, ella misma con su nombre; con la familia, cada persona con su
 * clave de Booking (la de sus fichas, que se une con `portal_person_link` si aún no la tiene). Devuelve las fichas nuevas.
 */
export async function joinDirection(client: SyncClient, reservationId: string, people?: JoinPerson[]): Promise<{ guest_ids: string[] }> {
  const persons = people?.length ? await Promise.all(people.map(async (p) => {
    const key = p.personKey ?? (p.guestIds.length ? (await personLink(client, p.guestIds)).person_key : null);
    return { ...(key ? { person_key: key } : {}), name: p.name };
  })) : null;
  return client.api('/invoke/booking.portal_join_direction', { method: 'POST', json: { reservation_id: reservationId, ...(persons ? { persons } : {}) } });
}
