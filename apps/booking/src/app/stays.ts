/** Booking · estancias de outsider y del staff (O2, API.md §26): filas del espejo, nombres y título. */
import type { SyncClient, SyncedRow } from '@ikisai/sync-client';
import { stayCalendarTitle, type StayLike } from '@ikisai/domain-booking';
import { STAYS, STAY_PERSONS, canRead } from './client.ts';

export type StayRow = SyncedRow & StayLike & { source: 'guest' | 'staff'; _pending?: boolean };
export type StayPersonRow = SyncedRow & { stay_id: string; person_key: string; name: string };
export interface HousePerson { account_id: string; name: string; level: 'outsider' | 'staff' | 'direccion' }

export const STAY_KIND_LABELS: Record<string, string> = { outsider: 'Outsider', staff: 'Staff' };

/** Estancias vivas del espejo (vacío si el rol no las lee). */
export async function liveStays(client: SyncClient): Promise<StayRow[]> {
  if (!canRead(client, STAYS)) return [];
  return ((await client.list(STAYS)) as StayRow[]).filter((s) => s.deleted_at === null);
}

export async function personsByStay(client: SyncClient): Promise<Map<string, StayPersonRow[]>> {
  const out = new Map<string, StayPersonRow[]>();
  if (!canRead(client, STAY_PERSONS)) return out;
  for (const p of (await client.list(STAY_PERSONS)) as StayPersonRow[]) {
    if (p.deleted_at !== null) continue;
    out.set(p.stay_id, [...(out.get(p.stay_id) ?? []), p]);
  }
  for (const list of out.values()) list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name));
  return out;
}

// Los nombres de las cuentas vienen de la API (no del espejo) y solo se guardan en memoria: no quedan en el dispositivo.
let peopleCache: HousePerson[] | null = null;
export async function housePeople(client: SyncClient): Promise<HousePerson[]> {
  if (peopleCache) return peopleCache;
  if (!navigator.onLine) return [];
  try {
    const out = await client.api<{ items: HousePerson[] }>('/read/booking.house_people', { method: 'POST', json: {} });
    peopleCache = out.items;
  } catch {
    return [];
  }
  return peopleCache;
}
export function forgetHousePeople(): void { peopleCache = null; }

/** «Marta (+1)», como en Google: la primera persona y cuántos más; si no hay, el nombre de la cuenta. */
export function stayTitle(stay: StayRow, persons: readonly StayPersonRow[] | undefined, people: readonly HousePerson[]): string {
  const account = people.find((p) => p.account_id === stay.account_id)?.name ?? null;
  const first = persons?.[0]?.name ?? account;
  return stayCalendarTitle({ kind: stay.kind, first: first ? first.trim().split(/\s+/)[0] : null, count: persons?.length ?? 0 });
}
