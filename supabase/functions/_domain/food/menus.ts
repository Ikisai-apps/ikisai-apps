/** Ikisai Food · eventos leídos de Booking y menú por evento (docs/food/API.md §2.2, §2.4, §7.1). */
import type { SyncedColumns } from './catalog.ts';

export const MENU_STATUSES = ['borrador', 'revisar', 'validado', 'cerrado'] as const;
export const SERVICE_TYPES = ['desayuno', 'comida', 'cena', 'picnic', 'merienda', 'otro'] as const;
export type MenuStatus = (typeof MENU_STATUSES)[number];
export type ServiceType = (typeof SERVICE_TYPES)[number];

/** Con el menú validado o cerrado no se editan servicios ni platos. */
export const LOCKED_MENU_STATUSES: readonly MenuStatus[] = ['validado', 'cerrado'];

/** Restricción alimentaria agregada y sin identificar, tal como la publica Booking. */
export interface DietaryRestriction {
  type: 'alergia' | 'intolerancia' | 'vegetariano' | 'vegano' | 'sin_gluten' | 'sin_lactosa' | 'preferencia' | 'otra' | string;
  subject?: string | null;
  severity?: string | null;
  servings?: number | null;
  kitchen_notes?: string | null;
}

/** Fila de `booking.food_event_projection`. Las cuatro últimas columnas son la ampliación propuesta por Booking. */
export interface FoodEvent {
  event_id: string;
  event_code: string | null;
  reservation_code: string | null;
  title: string;
  event_type: string | null;
  start_date: string;
  end_date: string;
  arrival_time: string | null;
  departure_time: string | null;
  guest_count: number | null;
  minors_count: number | null;
  meal_plan: string | null;
  menu_style: string | null;
  dietary_restrictions: DietaryRestriction[];
  event_revision: number;
  reservation_status?: string | null;
  /** Id de la reserva en Booking (migración 0404), para enlazar a su ficha. */
  reservation_id?: string | null;
  guest_count_is_final?: boolean | null;
  requires_meals?: boolean | null;
  meal_notes?: string | null;
}

/** Lo que el usuario tenía delante al crear, revisar o validar el menú. No es fuente de verdad: solo permite decir qué cambió. */
export interface EventSnapshot {
  guest_count: number | null;
  start_date: string;
  end_date: string;
  meal_plan: string | null;
  menu_style: string | null;
  restrictions: DietaryRestriction[];
}

export interface Menu extends SyncedColumns {
  event_id: string;
  source_event_revision: number;
  source_event_snapshot: EventSnapshot | null;
  status: MenuStatus;
  validated_at: string | null;
  validated_by: string | null;
  validated_warnings: Array<{ key: string; kind: string; text: string }> | null;
  preparation_generated_at: string | null;
  preparation_source_revisions: Record<string, number> | null;
  notes: string | null;
  closing_notes: string | null;
}

export interface MenuService extends SyncedColumns {
  menu_id: string;
  service_date: string;
  service_type: ServiceType;
  service_time: string | null;
  position: number;
  notes: string | null;
}

export interface MenuItem extends SyncedColumns {
  service_id: string;
  recipe_id: string;
  servings: number;
  position: number;
  notes: string | null;
}

export function eventSnapshot(event: FoodEvent): EventSnapshot {
  return {
    guest_count: event.guest_count,
    start_date: event.start_date,
    end_date: event.end_date,
    meal_plan: event.meal_plan,
    menu_style: event.menu_style,
    restrictions: normalizeRestrictions(event.dietary_restrictions),
  };
}

function normalizeRestrictions(list: DietaryRestriction[] | null | undefined): DietaryRestriction[] {
  return (list ?? [])
    .map((r) => ({ type: r.type, subject: r.subject ?? null, severity: r.severity ?? null, servings: r.servings ?? 1, kitchen_notes: r.kitchen_notes ?? null }))
    .sort((a, b) => restrictionKey(a).localeCompare(restrictionKey(b)));
}

export function restrictionKey(r: DietaryRestriction): string {
  return [r.type, (r.subject ?? '').trim().toLowerCase(), r.severity ?? '', r.kitchen_notes ?? ''].join('|');
}

/** El menú está desactualizado cuando el evento ha avanzado respecto a la revisión contra la que se revisó. */
export function isMenuStale(menu: Pick<Menu, 'source_event_revision'>, event: Pick<FoodEvent, 'event_revision'>): boolean {
  return event.event_revision > menu.source_event_revision;
}

export interface EventChange {
  field: 'guest_count' | 'dates' | 'meal_plan' | 'menu_style' | 'restrictions';
  before: unknown;
  after: unknown;
}

/** Qué cambió en el evento desde lo que se revisó («Personas: 22 → 25»). */
export function eventChanges(snapshot: EventSnapshot | null, event: FoodEvent): EventChange[] {
  if (!snapshot) return [];
  const now = eventSnapshot(event);
  const changes: EventChange[] = [];
  if (snapshot.guest_count !== now.guest_count) changes.push({ field: 'guest_count', before: snapshot.guest_count, after: now.guest_count });
  if (snapshot.start_date !== now.start_date || snapshot.end_date !== now.end_date) {
    changes.push({ field: 'dates', before: [snapshot.start_date, snapshot.end_date], after: [now.start_date, now.end_date] });
  }
  if (snapshot.meal_plan !== now.meal_plan) changes.push({ field: 'meal_plan', before: snapshot.meal_plan, after: now.meal_plan });
  if (snapshot.menu_style !== now.menu_style) changes.push({ field: 'menu_style', before: snapshot.menu_style, after: now.menu_style });
  const before = normalizeRestrictions(snapshot.restrictions);
  if (JSON.stringify(before) !== JSON.stringify(now.restrictions)) changes.push({ field: 'restrictions', before, after: now.restrictions });
  return changes;
}

export interface ProposedService {
  service_date: string;
  service_type: ServiceType;
  service_time: string;
  position: number;
}

const DEFAULT_TIMES: Record<'desayuno' | 'comida' | 'cena', string> = { desayuno: '09:00', comida: '14:00', cena: '20:30' };

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  const last = Date.parse(end + 'T00:00:00Z');
  for (let t = Date.parse(start + 'T00:00:00Z'); t <= last && out.length < 60; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Propuesta de servicios según el régimen. Es solo una propuesta: la interfaz la enseña y el usuario la acepta o la edita.
 * Pensión completa: cena el día de llegada (y comida si se llega antes de las 14:00), todo los días intermedios,
 * desayuno el día de salida (y comida si se sale a partir de las 15:00). Media pensión: desayuno y cena. «Según programa»: nada.
 */
export function proposeServices(event: Pick<FoodEvent, 'start_date' | 'end_date' | 'arrival_time' | 'departure_time' | 'meal_plan'>): ProposedService[] {
  const days = eachDate(event.start_date, event.end_date);
  const out: ProposedService[] = [];
  const add = (date: string, type: 'desayuno' | 'comida' | 'cena') => {
    out.push({ service_date: date, service_type: type, service_time: DEFAULT_TIMES[type], position: out.length + 1 });
  };
  days.forEach((date, index) => {
    const first = index === 0;
    const last = index === days.length - 1;
    const single = days.length === 1;
    switch (event.meal_plan) {
      case 'pension_completa':
        if (single) { add(date, 'comida'); break; }
        if (!first) add(date, 'desayuno');
        if ((!first && !last) || (first && !!event.arrival_time && event.arrival_time < '14:00') || (last && !!event.departure_time && event.departure_time >= '15:00')) add(date, 'comida');
        if (!last) add(date, 'cena');
        break;
      case 'media_pension':
        if (!first) add(date, 'desayuno');
        if (!last) add(date, 'cena');
        break;
      case 'desayuno':
        if (!first) add(date, 'desayuno');
        break;
      default:
        break;
    }
  });
  return out;
}
