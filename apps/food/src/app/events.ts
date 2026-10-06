/**
 * Eventos de Booking para cocina (docs/food/API.md §7.1 y §10.2).
 * La proyección no es una tabla sincronizable: se pide a `GET /api/v1/events` y la última respuesta se guarda en una
 * base propia, `ikisai-food-cache-v1`, para poder verla sin red con su fecha. Food nunca recibe datos de huéspedes.
 */
import type { SyncClient } from '@ikisai/sync-client';
import type { DietaryRestriction, FoodEvent } from '@ikisai/domain-food';
import { relativeDayLabel } from '@ikisai/ui-kit';

const DATABASE = 'ikisai-food-cache-v1';
const STORE = 'kv';
const KEY = 'events';
const MIN_REFRESH_MS = 20_000;

export interface EventsSnapshot {
  events: FoodEvent[];
  /** Cuándo se leyeron del servidor; `null` si todavía no se ha podido. */
  fetchedAt: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function read(): Promise<EventsSnapshot | null> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(KEY);
      request.onsuccess = () => { db.close(); resolve((request.result as EventsSnapshot | undefined) ?? null); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  } catch {
    return null;
  }
}

async function write(snapshot: EventsSnapshot): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snapshot, KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  } catch {
    // sin IndexedDB la app sigue funcionando con lo que tenga en memoria
  }
}

let current: EventsSnapshot = { events: [], fetchedAt: null };
let loaded = false;
let lastAttempt = 0;
let inFlight: Promise<EventsSnapshot> | null = null;
const listeners = new Set<(snapshot: EventsSnapshot) => void>();

function emit(): void {
  for (const listener of listeners) listener(current);
}

/** Lo último que se sabe de los eventos, sin tocar la red. */
export async function cachedEvents(): Promise<EventsSnapshot> {
  if (!loaded) {
    current = (await read()) ?? current;
    loaded = true;
  }
  return current;
}

/** Pide los eventos al servidor y actualiza la caché. Sin red devuelve lo que hubiera. `force` salta el intervalo mínimo. */
export function refreshEvents(client: SyncClient, force = false): Promise<EventsSnapshot> {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastAttempt < MIN_REFRESH_MS) return cachedEvents();
  lastAttempt = Date.now();
  inFlight = (async () => {
    await cachedEvents();
    if (!navigator.onLine || !client.session()) return current;
    try {
      const response = await client.api<{ events: FoodEvent[]; serverTime: string }>('/events?scope=all');
      current = { events: response.events, fetchedAt: response.serverTime };
      await write(current);
      emit();
    } catch {
      // se conserva la caché; la vista enseña de cuándo es
    }
    return current;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Avisa con la caché y con cada actualización. Devuelve cómo dejar de escuchar. */
export function watchEvents(client: SyncClient, listener: (snapshot: EventsSnapshot) => void): () => void {
  listeners.add(listener);
  void cachedEvents().then(listener).then(() => refreshEvents(client));
  return () => { listeners.delete(listener); };
}

export async function clearEventsCache(): Promise<void> {
  current = { events: [], fetchedAt: null };
  loaded = true;
  lastAttempt = 0;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

// --- Presentación ------------------------------------------------------------------------

const DAY = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const WEEKDAY = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

export const todayKey = () => new Date().toLocaleDateString('sv-SE');
export const shortDay = (day: string) => DAY.format(asDate(day)).replace('.', '');
export const longDay = (day: string) => WEEKDAY.format(asDate(day));
export const dateRange = (event: Pick<FoodEvent, 'start_date' | 'end_date'>) =>
  event.start_date === event.end_date ? shortDay(event.start_date) : `${shortDay(event.start_date)} → ${shortDay(event.end_date)}`;
export const shortTime = (time: string | null) => (time ? time.slice(0, 5) : '');

export function eventDays(event: Pick<FoodEvent, 'start_date' | 'end_date'>): string[] {
  const days: string[] = [];
  const last = asDate(event.end_date).getTime();
  for (let t = asDate(event.start_date).getTime(); t <= last && days.length < 60; t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

export const MEAL_PLAN_LABELS: Record<string, string> = {
  no_aplica: 'Sin comidas', desayuno: 'Solo desayuno', media_pension: 'Media pensión', pension_completa: 'Pensión completa', segun_programa: 'Según programa',
};
export const mealPlanLabel = (plan: string | null) => (plan ? MEAL_PLAN_LABELS[plan] ?? plan : 'Régimen sin definir');

export function guestsLabel(event: Pick<FoodEvent, 'guest_count' | 'guest_count_is_final'>): string {
  if (event.guest_count === null) return 'Personas sin definir';
  return `${event.guest_count} ${event.guest_count === 1 ? 'persona' : 'personas'}${event.guest_count_is_final === false ? ' previstas' : ''}`;
}

const CANCELLED = ['cancelada', 'perdida'];
/** Un evento cancelado o sin comidas no pide menú. */
export const isCancelled = (event: Pick<FoodEvent, 'reservation_status'>) => CANCELLED.includes(event.reservation_status ?? '');
/** Booking dice expresamente que la reserva no lleva comidas. */
export const noMealsInBooking = (event: FoodEvent) => event.requires_meals === false || event.meal_plan === 'no_aplica';

/**
 * Por qué Booking no deja claro qué comidas hay, o `null` si está claro. La cocina puede crear el menú igualmente;
 * esto solo explica por qué no hay propuesta de servicios y qué cambiar en Booking.
 */
export function mealsGap(event: FoodEvent): string | null {
  if (noMealsInBooking(event)) return 'En Booking esta reserva figura sin comidas.';
  if (!event.meal_plan) return 'En Booking no está definido el régimen de comidas.';
  return null;
}

export const BOOKING_URL = 'https://booking.ikisai.com/#/reservas';

/** Ficha de la reserva en Booking si la proyección trae su id; si no, la lista de reservas. */
export const bookingReservationUrl = (event: Pick<FoodEvent, 'reservation_id'>) =>
  event.reservation_id ? `${BOOKING_URL}/${encodeURIComponent(event.reservation_id)}` : BOOKING_URL;

export const needsMenu = (event: FoodEvent) => !isCancelled(event) && event.requires_meals !== false && event.meal_plan !== 'no_aplica';

const RESTRICTION_PLURAL: Record<string, [string, string]> = {
  vegano: ['vegano', 'veganos'], vegetariano: ['vegetariano', 'vegetarianos'], sin_gluten: ['sin gluten', 'sin gluten'], sin_lactosa: ['sin lactosa', 'sin lactosa'],
  alergia: ['alergia', 'alergias'], intolerancia: ['intolerancia', 'intolerancias'], preferencia: ['preferencia', 'preferencias'], otra: ['otra restricción', 'otras restricciones'],
};

/** «1 alergia a pistacho», «2 veganos»: como lo lee la cocina. */
export function restrictionLabel(r: DietaryRestriction): string {
  const count = r.servings && r.servings > 0 ? r.servings : 1;
  const [one, many] = RESTRICTION_PLURAL[r.type] ?? [r.type, r.type];
  const noun = count === 1 ? one : many;
  const subject = r.subject ? (r.type === 'alergia' || r.type === 'intolerancia' ? ` a ${r.subject}` : `: ${r.subject}`) : '';
  return `${count} ${noun}${subject}${r.severity ? ` (${r.severity})` : ''}`;
}

/** Cuándo es: «en 10 días», «Mañana», «En curso» o «hace 2 semanas». */
export function whenLabel(event: Pick<FoodEvent, 'start_date' | 'end_date'>): string {
  const today = todayKey();
  if (event.start_date <= today && today <= event.end_date) return 'En curso';
  return relativeDayLabel(event.end_date < today ? event.end_date : event.start_date);
}

/** Personas con alergia o intolerancia: lo primero que cocina tiene que ver. */
export function allergyCount(list: DietaryRestriction[] | null | undefined): number {
  return (list ?? []).filter((r) => r.type === 'alergia' || r.type === 'intolerancia').reduce((sum, r) => sum + (r.servings && r.servings > 0 ? r.servings : 1), 0);
}

/** Las alergias e intolerancias, primero. */
export function sortedRestrictions(list: DietaryRestriction[] | null | undefined): DietaryRestriction[] {
  const weight = (r: DietaryRestriction) => (r.type === 'alergia' ? 0 : r.type === 'intolerancia' ? 1 : r.type === 'preferencia' || r.type === 'otra' ? 3 : 2);
  return [...(list ?? [])].sort((a, b) => weight(a) - weight(b));
}
