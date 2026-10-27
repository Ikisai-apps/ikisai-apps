/**
 * Visitantes por QR (API.md §9.19, contrato C11 de Core): una identidad anónima del núcleo, sin sesión ni pertenencias. El
 * token vive en `localStorage` de este móvil y viaja en `X-Visitor`; no se pide ningún dato al entrar. Las lecturas son
 * públicas por código de evento (`GET public/<nombre>` del kit en guests-api); las escrituras, en la API de su dueño
 * (`/api/booking/v1/public/join`, que el worker lleva a booking-api); «lo suyo», con la lectura pública
 * `booking_visitor_requests` y su `X-Visitor`. Un visitante nunca ve a otros.
 */
import { cache } from './cache.ts';

const TOKEN_KEY = 'ikisai-visitor';
const EVENTS_KEY = 'ikisai-visitor-events';
/** Marca de «tu acceso de visitante se renovó» (el anterior ya no valía), para decirlo una vez en la pantalla. */
const RENEWED_KEY = 'ikisai-visitor-renewed';
/** Usuario de la caché sin red de lo público del visitante (no es una persona del núcleo). */
const CACHE_USER = 'visitor';
/** Código del QR (Booking BG17): 10 caracteres sin ambigüedades; vale en mayúsculas o minúsculas. */
export const EVENT_CODE = /^[A-HJKMNP-Z2-9]{10}$/i;

export interface PublicEvent {
  code: string; name: string; starts_on: string | null; ends_on: string | null;
  kind: 'retiro' | 'jornadas_abiertas' | 'familiar' | string; status: 'abierto' | 'cerrado' | string; joinable: boolean; summary: string | null;
  /** Ofrece noches (alojamiento a la carta). */
  lodging?: boolean;
}
export interface VisitorRequest {
  event_code: string; kind: 'join' | 'contact'; name: string | null; status: 'pendiente' | 'aceptada' | 'atendida' | 'descartada' | string;
  created_at: string; decided_at: string | null;
}
export interface Loaded<T> { value: T; at: string; stale: boolean }
/** «Mi pedido» (Flow FL2): su número, el enlace de un solo uso a la carta, si tiene cuenta y sus pedidos. */
export interface VisitorCustomer {
  number: string | null; carta_url: string | null; account_open: boolean;
  orders: Array<{ number: string | null; status: 'open' | 'paid' | 'delivered' | string; summary: string; preparing: boolean }>;
}

function store(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function visitorToken(): string | null {
  try { return store()?.getItem(TOKEN_KEY) ?? null; } catch { return null; }
}

/** Los códigos de los eventos en los que se entró desde este móvil, el último primero. */
export function myEventCodes(): string[] {
  try {
    const list = JSON.parse(store()?.getItem(EVENTS_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string' && EVENT_CODE.test(c)) : [];
  } catch { return []; }
}

export function rememberEvent(code: string): void {
  const next = [code.toUpperCase(), ...myEventCodes().filter((c) => c !== code.toUpperCase())].slice(0, 50);
  try { store()?.setItem(EVENTS_KEY, JSON.stringify(next)); } catch { /* solo en memoria */ }
}

/** «Salir de este móvil»: el token, la lista de eventos y la caché del visitante. */
export async function forgetVisitor(): Promise<void> {
  try { store()?.removeItem(TOKEN_KEY); store()?.removeItem(EVENTS_KEY); store()?.removeItem(RENEWED_KEY); } catch { /* nada guardado */ }
  await cache.clearUser(CACHE_USER);
}

class PublicError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: unknown = null) { super(message); }
}

async function call<T>(path: string, init: { method?: string; json?: unknown; visitor?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  const token = init.visitor === false ? null : visitorToken();
  if (token) headers['X-Visitor'] = token;
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? (init.json === undefined ? 'GET' : 'POST'), headers, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });
  } catch {
    throw new PublicError(0, 'NETWORK', 'Sin conexión');
  }
  const body = await res.json().catch(() => null) as ({ error?: { code?: string; message?: string; details?: unknown } } & Record<string, unknown>) | null;
  if (!res.ok) throw new PublicError(res.status, body?.error?.code ?? 'HTTP_' + res.status, body?.error?.message ?? '', body?.error?.details ?? null);
  return body as T;
}

/** Crea la identidad de visitante si este móvil aún no la tiene (sin pedir nada). */
export async function ensureVisitor(code: string | null): Promise<void> {
  if (visitorToken()) return;
  const out = await call<{ visitorId?: string; token?: string }>('/api/v1/public/visitor', { json: code ? { eventCode: code.toUpperCase() } : {}, visitor: false });
  if (!out.token) throw new PublicError(500, 'VISITOR_FAILED', '');
  try { store()?.setItem(TOKEN_KEY, out.token); } catch { /* sin almacenamiento: dura lo que la pestaña */ }
}

/** Una llamada con visitante; si su token ya no vale (revocado o malo), se borra, se crea otro y se repite una vez. */
async function withVisitor<T>(code: string, run: () => Promise<T>): Promise<T> {
  await ensureVisitor(code);
  try {
    return await run();
  } catch (error) {
    if ((error as PublicError).code !== 'VISITOR_INVALID') throw error;
    try { store()?.removeItem(TOKEN_KEY); store()?.setItem(RENEWED_KEY, '1'); } catch { /* nada */ }
    await ensureVisitor(code);
    return run();
  }
}

/** Lectura pública con copia sin red. */
async function readPublic<T>(name: string, args: Record<string, string>, map: (raw: unknown) => T): Promise<Loaded<T>> {
  const query = new URLSearchParams(args).toString();
  try {
    const value = map(await call<unknown>(`/api/v1/public/${name}?${query}`, { visitor: false }));
    void cache.saveRead(CACHE_USER, name, args, value);
    return { value, at: new Date().toISOString(), stale: false };
  } catch (error) {
    if ((error as PublicError).code === 'NETWORK') {
      const copy = await cache.read<T>(CACHE_USER, name, args);
      if (copy) return { value: copy.value, at: copy.at, stale: true };
    }
    throw error;
  }
}

function asEvent(raw: unknown): PublicEvent | null {
  const e = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!e || typeof e.code !== 'string' || typeof e.name !== 'string') return null;
  const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  return { code: e.code, name: e.name, starts_on: day(e.starts_on), ends_on: day(e.ends_on), kind: String(e.kind ?? 'retiro'),
    status: String(e.status ?? 'cerrado'), joinable: e.joinable === true, summary: typeof e.summary === 'string' && e.summary.trim() ? e.summary : null,
    lodging: e.lodging === true };
}

/** El evento del QR (Booking BG19, lectura pública `booking_event`); null si el código no es de ningún evento. */
export function publicEvent(code: string): Promise<Loaded<PublicEvent | null>> {
  return readPublic('booking_event', { code: code.toUpperCase() }, asEvent);
}

/** Los eventos abiertos al público (Booking, `booking_public_events`): la raíz de ven.ikisai.com sin QR ni invitación. */
export function publicEvents(): Promise<Loaded<PublicEvent[]>> {
  return readPublic('booking_public_events', {}, (raw) => {
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown[] } | null)?.items) ? (raw as { items: unknown[] }).items : [];
    return list.map(asEvent).filter((e): e is PublicEvent => Boolean(e));
  });
}

/** Precios y plazas de un intervalo (Booking 0498, `booking_public_lodging`): calculado para todas las noches `[from, to)`. */
export interface PublicLodging {
  from: string; to: string; nights: number; persons: number;
  /** Plazas libres todas esas noches (con tope). */
  available: number;
  modes: Array<{ id: string; name: string; includes: string | null; price_night_cents: number | null; total_cents: number | null; max_persons: number | null; available: number | null; fits: boolean }>;
  rules_text: string | null;
}

export function publicLodging(code: string, from: string, to: string, persons: number): Promise<Loaded<PublicLodging>> {
  return readPublic('booking_public_lodging', { event_code: code.toUpperCase(), from, to, persons: String(persons) }, (raw) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const modes = (Array.isArray(r.modes) ? r.modes : []).flatMap((m) => {
      const x = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
      if (typeof x.id !== 'string' || typeof x.name !== 'string') return [];
      return [{ id: x.id, name: x.name, includes: typeof x.includes === 'string' && x.includes.trim() ? x.includes : null,
        price_night_cents: num(x.price_night_cents), total_cents: num(x.total_cents), max_persons: num(x.max_persons), available: num(x.available), fits: x.fits === true }];
    });
    return { from: String(r.from ?? from), to: String(r.to ?? to), nights: num(r.nights) ?? 0, persons: num(r.persons) ?? persons,
      available: num(r.available) ?? 0, modes, rules_text: typeof r.rules_text === 'string' && r.rules_text.trim() ? r.rules_text : null };
  });
}

/** Sus ofertas públicas (Food FD5, `food_visitor_offers`), sin cruzar: la forma de `food.portal_offers`. */
export function visitorOffers(code: string): Promise<Loaded<unknown>> {
  return readPublic('food_visitor_offers', { event_code: code.toUpperCase() }, (raw) => raw);
}

/** Sus peticiones a ese evento («Apuntarme» y «Déjanos un dato», Booking #770); sin visitante, ninguna. */
export async function myRequests(code: string): Promise<VisitorRequest[]> {
  if (!visitorToken()) return [];
  // Lectura pública de Booking con el visitante resuelto por el kit (`publicReadWithVisitor`): solo las suyas.
  const out = await withVisitor(code, () => call<{ items?: VisitorRequest[] } | VisitorRequest[] | null>(`/api/v1/public/booking_visitor_requests?event_code=${encodeURIComponent(code.toUpperCase())}`));
  return Array.isArray(out) ? out : Array.isArray(out?.items) ? out.items : [];
}

/** «Apuntarme» (`kind: 'join'`) o «Déjanos un dato» (`kind: 'contact'`): una petición a Booking, firmada por el visitante. */
export function sendRequest(code: string, input: { kind: 'join' | 'contact'; name?: string | null; contact?: string | null; note?: string | null }): Promise<VisitorRequest> {
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : undefined);
  return withVisitor(code, () => call<VisitorRequest>('/api/booking/v1/public/join', {
    json: { event_code: code.toUpperCase(), kind: input.kind, name: clean(input.name), contact: clean(input.contact), note: clean(input.note) },
  }));
}

/** ¿Se renovó el acceso de visitante desde la última vez que se dijo? Se dice una vez. */
export function takeRenewed(): boolean {
  try {
    if (store()?.getItem(RENEWED_KEY) !== '1') return false;
    store()?.removeItem(RENEWED_KEY);
    return true;
  } catch { return false; }
}

export function errorCodeOf(error: unknown): string {
  return error instanceof PublicError ? error.code : '';
}

function asCustomer(raw: unknown): VisitorCustomer {
  const c = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const orders = Array.isArray(c.orders) ? c.orders.filter((o): o is Record<string, unknown> => Boolean(o && typeof o === 'object')) : [];
  return {
    number: c.number === null || c.number === undefined ? null : String(c.number),
    carta_url: typeof c.carta_url === 'string' ? c.carta_url : null,
    account_open: c.account_open === true,
    orders: orders.map((o) => ({ number: o.number === null || o.number === undefined ? null : String(o.number), status: String(o.status ?? 'open'),
      summary: typeof o.summary === 'string' ? o.summary : '', preparing: o.preparing === true })),
  };
}

/** Su cliente de Flow en este evento (lectura `flow_visitor_customer` con su `visitor_id`); sin visitante, nada. */
export async function visitorCustomer(code: string): Promise<VisitorCustomer | null> {
  if (!visitorToken()) return null;
  return asCustomer(await withVisitor(code, () => call<unknown>(`/api/v1/public/flow_visitor_customer?event_code=${encodeURIComponent(code.toUpperCase())}`)));
}

/** Unirse a la carta del evento (acción de Flow, idempotente): le da número, sin cuenta, y un enlace de un solo uso. */
export async function visitorJoin(code: string): Promise<VisitorCustomer> {
  return asCustomer(await withVisitor(code, () => call<unknown>('/api/flow/v1/public/visitor_join', { json: { event_code: code.toUpperCase() } })));
}
