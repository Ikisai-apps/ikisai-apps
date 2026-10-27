/**
 * Ikisai Food · ofertas de comida por evento (encargo de VG por Core, 27-10-2026; docs/food/API.md §2.12, migración 1111).
 *
 * Un evento tiene N ofertas; cada una es un menú cerrado o una carta, con cuándo (días × servicios), para qué grupos de
 * comensales (etiquetas `meal_group` de Booking; nunca personas), dónde, quién paga (organizador o huésped) y, si paga el
 * huésped, cuándo se cobra (en barra o a la cuenta). Las internas (equipo, outsiders, familia) no las ven ni el organizador
 * ni los huéspedes. El menú de casa es la oferta interna global.
 */
import type { SyncedColumns } from './catalog.ts';
import { SERVICE_TYPES, type ServiceType } from './menus.ts';

export const OFFER_AUDIENCES = ['huespedes', 'interna'] as const;
export type OfferAudience = (typeof OFFER_AUDIENCES)[number];
export const OFFER_PAYERS = ['organizador', 'huesped'] as const;
export type OfferPayer = (typeof OFFER_PAYERS)[number];
export const OFFER_CHARGES = ['barra', 'cuenta'] as const;
export type OfferCharge = (typeof OFFER_CHARGES)[number];
/** Sugerencias de grupo de comensales (Booking ofrece las mismas en la ficha del huésped). */
export const MEAL_GROUP_SUGGESTIONS = ['Huéspedes', 'Ponentes', 'Niños', 'Familia', 'VIP', 'Equipo'] as const;

export interface EventOffer extends SyncedColumns {
  event_id: string | null;
  menu_id: string;
  name: string;
  audience: OfferAudience;
  meal_groups: string[];
  days: string[] | null;
  services: ServiceType[] | null;
  place: string | null;
  space_id: string | null;
  payer: OfferPayer | null;
  charge_when: OfferCharge | null;
  position: number;
  notes: string | null;
  /** Visible para los visitantes por QR, sin ficha (Guests FD5); solo en las de huéspedes. */
  public?: boolean;
}

/** Quién paga, como lo lee la cocina. */
export function offerPayerText(offer: Pick<EventOffer, 'audience' | 'payer' | 'charge_when'>): string {
  if (offer.audience === 'interna') return 'Interna';
  if (offer.payer === 'organizador') return 'Incluido: paga el organizador';
  return offer.charge_when === 'cuenta' ? 'Paga el huésped, a su cuenta' : 'Paga el huésped, en barra';
}

/** Para quién: «Todos los huéspedes», «VIP, Ponentes», «Equipo (interna)». */
export function offerGroupsText(offer: Pick<EventOffer, 'audience' | 'meal_groups'>): string {
  const groups = offer.meal_groups.length ? offer.meal_groups.join(', ') : offer.audience === 'interna' ? 'Todo el equipo' : 'Todos los huéspedes';
  return offer.audience === 'interna' ? `${groups} (interna)` : groups;
}

/** Qué tiene de malo una oferta nueva o cambiada, o null. Las mismas reglas que la base (`event_offers_payer`). */
export function offerProblem(fields: Partial<Pick<EventOffer, 'audience' | 'payer' | 'charge_when' | 'event_id' | 'meal_groups' | 'days' | 'services' | 'public'>>): { field: string; message: string } | null {
  const audience = fields.audience ?? 'huespedes';
  if (audience === 'interna') {
    if (fields.public) return { field: 'public', message: 'Una oferta interna no se enseña a los visitantes.' };
    if (fields.payer) return { field: 'payer', message: 'Una oferta interna no lleva quién paga.' };
    if (fields.charge_when) return { field: 'charge_when', message: 'Una oferta interna no se cobra.' };
  } else {
    if (fields.event_id === null) return { field: 'event_id', message: 'Una oferta para huéspedes es de un evento.' };
    if (!fields.payer) return { field: 'payer', message: 'Elige quién paga.' };
    if (fields.payer === 'huesped' && !fields.charge_when) return { field: 'charge_when', message: 'Elige cuándo se cobra: en barra o a la cuenta.' };
    if (fields.payer === 'organizador' && fields.charge_when) return { field: 'charge_when', message: 'Si paga el organizador, no se cobra al huésped.' };
  }
  if (fields.meal_groups !== undefined) {
    if (!Array.isArray(fields.meal_groups) || fields.meal_groups.length > 30 || fields.meal_groups.some((g) => typeof g !== 'string' || !g.trim() || g.trim().length > 40)) {
      return { field: 'meal_groups', message: 'Cada grupo, de 1 a 40 caracteres (30 como mucho).' };
    }
  }
  if (fields.days !== undefined && fields.days !== null) {
    if (!Array.isArray(fields.days) || !fields.days.length || fields.days.length > 62 || fields.days.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
      return { field: 'days', message: 'Elige al menos un día (o todos).' };
    }
  }
  if (fields.services !== undefined && fields.services !== null) {
    if (!Array.isArray(fields.services) || !fields.services.length || fields.services.some((s) => !(SERVICE_TYPES as readonly string[]).includes(s))) {
      return { field: 'services', message: 'Elige al menos un servicio (o todos).' };
    }
  }
  return null;
}

/** La oferta de siempre al crear un menú de retiro o una carta para un evento (lo de hoy: un evento, un menú = una oferta). */
export function defaultOfferFields(menu: { id: string; kind: 'retiro' | 'carta'; name?: string | null }, eventId: string): Record<string, unknown> {
  return menu.kind === 'carta'
    ? { event_id: eventId, menu_id: menu.id, name: menu.name || 'Carta', audience: 'huespedes', meal_groups: [], payer: 'huesped', charge_when: 'barra', position: 2 }
    : { event_id: eventId, menu_id: menu.id, name: 'Menú', audience: 'huespedes', meal_groups: [], payer: 'organizador', position: 1 };
}

/** Fila de `food.event_needs`: lo que piden todas las ofertas de un evento, por ingrediente. */
export interface EventNeed { ingredient_id: string; name: string; item_id: string | null; quantity: number; unit: string; menus: number }
