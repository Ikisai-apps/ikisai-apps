/**
 * Lecturas y acciones de Booking para el portal (docs/organizers/API.md §6.2) y enlaces de huésped (§7).
 * Las lecturas guardan su última respuesta en la caché local para verlas sin red; las escrituras necesitan red.
 */
import type { SyncClient } from '@ikisai/sync-client';
import type { GuestMode } from '@ikisai/domain-booking';
import { cache } from './cache.ts';
import { declarationVersion } from './common-texts.ts';

export type ReservationStatus = 'en_estudio' | 'negociacion' | 'pre_reservada' | 'confirmada' | 'en_ejecucion' | 'cerrada' | 'cancelada' | 'perdida';

export interface PortalReservation {
  id: string; code: string | null; title: string; start_date: string | null; end_date: string | null;
  expected_guests: number | null; status: ReservationStatus; confirmed: boolean; mode: GuestMode; guests: number; complete: number;
}

export interface ReservationDetail extends Omit<PortalReservation, 'guests' | 'complete'> {
  final_guests: number | null; minors_count: number | null; arrival_time: string | null; departure_time: string | null;
  meal_plan: string | null; meal_plan_confirmed: boolean; menu_style: string | null; menu_style_confirmed: boolean; uses_accommodation: boolean; requires_meals: boolean;
  uses_interpretation_center: boolean; uses_outdoors: boolean; uses_pool: boolean;
}

export interface PortalRestriction { id?: string; restriction_type: string; subject: string | null; severity: string | null; kitchen_notes: string | null; source?: 'guest' | 'organizer' | 'staff' }

/** Un campo llega con su valor si lo escribió el organizador, `true` si lo rellenó otra persona y `null` si está vacío. */
export type FieldValue = string | boolean | null;

export interface PortalGuest {
  id: string; revision: number; display_name: string; fields: Record<string, FieldValue>; missing: string[]; signed: boolean;
  allergies_shared: boolean; restrictions: PortalRestriction[];
}

export interface GuestList { confirmed: boolean; mode: GuestMode; declared?: boolean; items: PortalGuest[] }

export interface KitchenSummary {
  totals: Array<{ restriction_type: string; subject: string | null; servings: number }>;
  named: Array<{ guest: string; restriction_type: string; subject: string | null; severity: string | null }>;
}

export interface PortalLink {
  linkId: string; app: string; label: string | null; scope: { reservation_id: string; guest_id?: string };
  createdAt: string; lastUsedAt: string | null; revokedAt: string | null; validUntil: string | null;
}

export interface Coorganizer { display_name: string; me: boolean }

export interface IssuedLink { linkId: string; url: string; validUntil: string | null }

/** Resultado de una lectura: `at` es la hora de los datos y `stale` dice si vienen de la caché por falta de red. */
export interface Loaded<T> { value: T; at: string; stale: boolean }

export interface PortalApi {
  reservations(): Promise<Loaded<{ items: PortalReservation[] }>>;
  detail(reservationId: string): Promise<Loaded<ReservationDetail>>;
  guests(reservationId: string): Promise<Loaded<GuestList>>;
  kitchen(reservationId: string): Promise<Loaded<KitchenSummary>>;
  links(reservationId: string): Promise<Loaded<{ items: PortalLink[] }>>;
  organizers(reservationId: string): Promise<Loaded<{ items: Coorganizer[] }>>;
  addGuest(args: { reservation_id: string; guest_id: string; fields: Record<string, unknown>; declaration?: boolean }): Promise<unknown>;
  updateGuest(args: { guest_id: string; expectedRevision: number; fields: Record<string, unknown>; declaration?: boolean }): Promise<unknown>;
  removeGuest(args: { guest_id: string; expectedRevision: number }): Promise<unknown>;
  setRestrictions(args: { guest_id: string; items: PortalRestriction[]; declaration?: boolean }): Promise<unknown>;
  issueGuestLink(args: { reservationId: string; guestId: string; name: string; email?: string | null; replace: boolean }): Promise<IssuedLink>;
  revokeLink(linkId: string): Promise<unknown>;
  permanentAccount(): Promise<boolean>;
}

export function createPortalApi(client: SyncClient): PortalApi {
  const userId = () => client.bootstrap()?.profile.userId ?? 'anon';

  /** Pide al servidor; si no hay red y hay copia local, la devuelve marcada como antigua. */
  async function load<T>(name: string, args: unknown, fetcher: () => Promise<T>): Promise<Loaded<T>> {
    const user = userId();
    try {
      const value = await fetcher();
      void cache.saveRead(user, name, args, value);
      return { value, at: new Date().toISOString(), stale: false };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'NETWORK' || code === 'BACKEND_UNAVAILABLE' || code === 'OFFLINE') {
        const copy = await cache.read<T>(user, name, args);
        if (copy) return { value: copy.value, at: copy.at, stale: true };
      }
      throw error;
    }
  }

  const read = <T>(name: string, args: Record<string, unknown> = {}) =>
    load<T>(name, args, () => client.api<T>(`/read/${name}`, { method: 'POST', json: args }));
  const invoke = (name: string, args: Record<string, unknown>) => client.api(`/invoke/${name}`, { method: 'POST', json: args });

  return {
    reservations: () => read('booking.portal_reservations'),
    detail: (reservationId) => read('booking.portal_reservation_detail', { reservation_id: reservationId }),
    guests: (reservationId) => read('booking.portal_guests', { reservation_id: reservationId }),
    kitchen: (reservationId) => read('booking.portal_kitchen_summary', { reservation_id: reservationId }),
    organizers: (reservationId) => read('booking.portal_organizers', { reservation_id: reservationId }),
    links: (reservationId) => load('portal-links', { reservation: reservationId }, () => client.api(`/portal-links?reservation=${encodeURIComponent(reservationId)}`)),
    addGuest: (args) => invoke('booking.portal_add_guest', { ...args, declaration_version: declarationVersion() }),
    updateGuest: (args) => invoke('booking.portal_update_guest', { ...args, declaration_version: declarationVersion() }),
    removeGuest: (args) => invoke('booking.portal_remove_guest', args),
    setRestrictions: (args) => invoke('booking.portal_set_restrictions', { ...args, declaration_version: declarationVersion() }),
    issueGuestLink: ({ reservationId, guestId, name, email, replace }) => client.api<IssuedLink>('/portal-links', {
      method: 'POST',
      json: { app: 'guests', scope: { reservation_id: reservationId, guest_id: guestId }, person: { name, ...(email ? { email } : {}) }, label: name, replace },
    }),
    revokeLink: (linkId) => client.api(`/portal-links/${encodeURIComponent(linkId)}/revoke`, { method: 'POST', json: {} }),
    async permanentAccount() {
      try {
        return (await client.api<{ permanentAccount?: boolean }>('/auth/config')).permanentAccount === true;
      } catch {
        return false;
      }
    },
  };
}
