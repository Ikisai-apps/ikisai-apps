/**
 * Lecturas y acciones de Booking para el portal (docs/organizers/API.md §6.2) y enlaces de huésped (§7).
 * Las lecturas guardan su última respuesta en la caché local para verlas sin red; las escrituras necesitan red.
 */
import type { SyncClient } from '@ikisai/sync-client';
import type { GuestMode } from '../../../../supabase/functions/_domain/booking/mod.ts';
import type { IssuedDocument } from '../../../../supabase/functions/_domain/invoices/issued.ts';
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
  /** Booking B14 (#310): lo necesario para pintar el borrador tal como está. */
  revision?: number; event_type?: string | null; dates_definitive?: boolean; organizer_notes?: string | null;
  special_setup?: boolean; technical_support?: boolean;
  /** Lo contratado (Booking F1, #312): propuesta aceptada, señal y vencimientos. Nunca lo pagado (eso es de Finance). */
  contract?: Contract | null;
}

export interface Contract {
  proposal_version: number; total: number | string; deposit_required: number | string; prices_include_vat: boolean; vat_amount: number | string | null;
  payment_type: string | null; due: Array<{ kind: 'senal' | 'saldo'; date: string | null; amount: number | string }>;
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

/** Disponibilidad de un tramo para el portal: nunca dice quién ni por qué (Booking B6). */
export type Availability = 'libre' | 'en_opcion' | 'ocupado';

export interface DateOption {
  id: string; start: string; end: string; arrival_time: string | null; departure_time: string | null;
  proposed_by: 'ikisai' | 'organizer'; organizer_ok: boolean; availability: Availability;
}

/** Fechas del retiro (Booking B7c): fija, opciones de Ikisai o calendario libre (API.md §13.2). */
export interface PortalDates {
  mode: 'fixed' | 'ikisai_options' | 'calendar';
  definitive: { start: string; end: string; arrival_time: string | null; departure_time: string | null } | null;
  options: DateOption[];
}

export interface Weekend { start: string; end: string; status: Availability }

export type DatePreference = { option_id: string; ok: boolean } | { start: string; end: string };

/** Campos de diseño que el organizador puede cambiar (Booking B7d: solo en estudio o negociación). */
export interface DraftFields {
  expected_guests?: number | null; minors_count?: number; meal_plan_requested?: string | null; menu_style_requested?: string | null;
  uses_accommodation?: boolean; requires_meals?: boolean; uses_interpretation_center?: boolean; uses_outdoors?: boolean; uses_pool?: boolean;
  special_setup?: boolean; technical_support?: boolean; organizer_notes?: string | null;
}
export interface ExtraRequest { rate_id: string; quantity: number; note?: string | null; name?: string }

/** Tarifa visible en el portal (Booking B9/B10), con su nombre y descripción públicos. */
export interface PortalRate {
  id: string; name: string; description: string | null; layer: string; unit: string; amount: number | string; service: string | null;
  min_persons: number | null; max_persons: number | null; event_types: string[] | null; valid_from: string | null; valid_to: string | null;
  active: boolean; position?: number | string;
}
export interface PortalConditions { prices_include_vat: boolean; vat_rate: number | string; deposit_percent: number | string; deposit_minimum: number | string; minimum_total: number | string | null }
export interface PortalRates { available: boolean; rates: PortalRate[]; conditions: PortalConditions | null }

export interface ProposalLine { description: string; unit: string; quantity: number | string; unit_amount: number | string; discount_pct: number | string | null; amount: number | string | null }
export interface PortalProposal {
  id: string; version: number; status: 'enviada' | 'aceptada'; nature: 'orientativa' | 'cerrada'; start_date: string | null; end_date: string | null;
  persons: number | null; subtotal: number | string; adjustments: number | string; vat_amount: number | string; total: number | string; deposit_amount: number | string;
  valid_until: string | null; includes: string | null; excludes: string | null; sent_at: string | null; decided_at: string | null;
  conditions: {
    name: string; text: string | null; prices_include_vat: boolean; vat_rate: number | string; deposit_percent: number | string; deposit_minimum: number | string;
    deposit_days: number | null; deposit_days_short: number | null; short_notice_days: number | null;
    tiers: Array<{ min_days_before: number; deposit_refund_pct: number | string; extra_costs: boolean }>;
  } | null;
  lines: ProposalLine[];
}
/** Dinero del retiro según Finance (F1): sus facturas y lo facturado, cobrado y pendiente. Lo pagado sale solo de aquí. */
export interface PortalInvoice {
  id: string; number: string; issue_date: string; type: string; rectifies: string[] | null; base: number | string; tax: number | string;
  withholding: number | string; total: number | string; status: 'emitida' | 'rectificada' | 'registrada'; collected: boolean; collected_at: string | null; has_document: boolean;
  /** Concepto del cobro (Finance #313): señal, saldo o extras; `general` o `null`, sin rótulo. */
  purpose?: 'senal' | 'saldo' | 'extras' | 'general' | null;
}
export interface PortalMoney { reservation_id: string; currency: string; invoices: PortalInvoice[]; totals: { invoiced: number | string; collected: number | string; pending: number | string } }
/** Copia congelada de una factura (F2) o los PDF guardados de una registrada (aún sin URL firmada para el portal). */
export interface PortalInvoiceDocument {
  id: string; number: string; issue_date: string; status: string; document: IssuedDocument | null;
  files: Array<{ file_id: string; filename: string; mime: string; size: number }>;
}

export interface PortalRequest { id: string; kind: 'quiere_confirmar' | 'comentario'; proposal_id: string | null; message: string | null; status: 'enviada' | 'vista' | 'respondida'; created_at: string; mine: boolean }

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
  dates(reservationId: string): Promise<Loaded<PortalDates>>;
  availability(reservationId: string, from?: string, to?: string): Promise<Loaded<{ from: string; to: string; weekends: Weekend[] }>>;
  setDatePreferences(reservationId: string, options: DatePreference[]): Promise<unknown>;
  updateDraft(reservationId: string, change: { fields?: DraftFields; extras?: ExtraRequest[] }): Promise<{ reservation_id: string; revision: number }>;
  extraRequests(reservationId: string): Promise<Loaded<{ items: ExtraRequest[] }>>;
  rates(reservationId: string): Promise<Loaded<PortalRates>>;
  proposals(reservationId: string): Promise<Loaded<{ items: PortalProposal[] }>>;
  request(reservationId: string, request: { kind: 'quiere_confirmar' | 'comentario'; proposal_id?: string | null; message?: string | null }): Promise<{ id: string; status: string }>;
  myRequests(reservationId: string): Promise<Loaded<{ items: PortalRequest[] }>>;
  money(reservationId: string): Promise<Loaded<PortalMoney>>;
  invoiceDocument(reservationId: string, invoiceId: string): Promise<Loaded<PortalInvoiceDocument>>;
  addGuest(args: { reservation_id: string; guest_id: string; fields: Record<string, unknown>; declaration?: boolean }): Promise<unknown>;
  updateGuest(args: { guest_id: string; expectedRevision: number; fields: Record<string, unknown>; declaration?: boolean }): Promise<unknown>;
  removeGuest(args: { guest_id: string; expectedRevision: number }): Promise<unknown>;
  setRestrictions(args: { guest_id: string; items: PortalRestriction[]; declaration?: boolean }): Promise<unknown>;
  issueGuestLink(args: { reservationId: string; guestId: string; name: string; email?: string | null; replace: boolean }): Promise<IssuedLink>;
  revokeLink(linkId: string): Promise<unknown>;
  permanentAccount(): Promise<boolean>;
  /** Fases 4 y 5: lectura y acción de otra app con caché (programa y alojamiento de Booking, menú de Food, lugar de Central). */
  readAny<T>(name: string, args?: Record<string, unknown>): Promise<Loaded<T>>;
  invokeAny<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  /** Enlace de Guests de solo lectura al huésped de muestra (O6, C9): `preview: true`. */
  previewLink(reservationId: string, guestId: string, name: string): Promise<IssuedLink>;
  /** URL firmada corta de un archivo publicado a este portal por otra app (C8: fotos de Food, plano de Central). */
  portalFile(fileId: string): Promise<{ url: string; mime: string; name?: string }>;
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
    dates: (reservationId) => read('booking.portal_dates', { reservation_id: reservationId }),
    availability: (reservationId, from, to) => read('booking.portal_availability', { reservation_id: reservationId, ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    setDatePreferences: (reservationId, options) => invoke('booking.portal_set_date_preferences', { reservation_id: reservationId, options }),
    updateDraft: (reservationId, change) => invoke('booking.portal_update_draft', { reservation_id: reservationId, ...change }) as Promise<{ reservation_id: string; revision: number }>,
    extraRequests: (reservationId) => read('booking.portal_extra_requests', { reservation_id: reservationId }),
    rates: (reservationId) => read('booking.portal_rates', { reservation_id: reservationId }),
    proposals: (reservationId) => read('booking.portal_proposals', { reservation_id: reservationId }),
    request: (reservationId, request) => invoke('booking.portal_request', { reservation_id: reservationId, ...request }) as Promise<{ id: string; status: string }>,
    myRequests: (reservationId) => read('booking.portal_my_requests', { reservation_id: reservationId }),
    money: (reservationId) => read('invoices.portal_reservation_money', { reservation_id: reservationId }),
    invoiceDocument: (reservationId, invoiceId) => read('invoices.portal_invoice_document', { reservation_id: reservationId, issued_invoice_id: invoiceId }),
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
    readAny: (name, args = {}) => read(name, args),
    invokeAny: (name, args) => invoke(name, args) as Promise<never>,
    previewLink: (reservationId, guestId, name) => client.api<IssuedLink>('/portal-links', {
      method: 'POST',
      json: { app: 'guests', scope: { reservation_id: reservationId, guest_id: guestId }, person: { name }, label: name, preview: true, replace: true },
    }),
    portalFile: (fileId) => client.api(`/portal-files/${encodeURIComponent(fileId)}`),
    async permanentAccount() {
      try {
        return (await client.api<{ permanentAccount?: boolean }>('/auth/config')).permanentAccount === true;
      } catch {
        return false;
      }
    },
  };
}
