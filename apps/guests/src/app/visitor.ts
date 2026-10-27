/**
 * Visitantes por QR (API.md §9.19, contrato C11 de Core): una identidad anónima del núcleo, sin sesión ni pertenencias. El
 * token vive en `localStorage` de este móvil y viaja en `X-Visitor`; no se pide ningún dato al entrar. Las lecturas son
 * públicas por código de evento (`GET public/<nombre>` del kit en guests-api); las escrituras, en la API de su dueño
 * (`/api/booking/v1/public/join`, que el worker lleva a booking-api); «lo suyo», con la lectura pública
 * `booking_visitor_requests` y su `X-Visitor`. Un visitante nunca ve a otros.
 */
import { cache } from './cache.ts';
import type { PortalPlans } from './portal-types.ts';

const TOKEN_KEY = 'ikisai-visitor';
const EVENTS_KEY = 'ikisai-visitor-events';
/** Marca de «tu acceso de visitante se renovó» (el anterior ya no valía), para decirlo una vez en la pantalla. */
const RENEWED_KEY = 'ikisai-visitor-renewed';
/** Eventos cuyo «Alójate aquí» está abierto en este móvil: se abre al entrar por su QR o por el enlace de la carta de Flow. */
const LODGING_KEY = 'ikisai-visitor-lodging';
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
  /** Id de la petición (Booking): para «Tu ficha está lista». */
  id?: string;
  event_code: string; kind: 'join' | 'contact' | 'stay'; name: string | null; status: 'pendiente' | 'aceptada' | 'atendida' | 'descartada' | string;
  created_at: string; decided_at: string | null;
  /** Solo en `stay` (Booking 0499): noches, personas, total y cómo se paga; con `hold`, hasta cuándo se guarda la plaza. */
  from?: string; to?: string; persons?: number; total_cents?: number | null; pay?: 'hold' | 'pay_first' | string; hold_until?: string | null; hold_expired?: boolean;
}
/** Cómo se paga el alojamiento del evento: `hold` guarda la plaza unas horas y se paga en recepción; `pay_first` no la guarda hasta pagar. */
export type PayMode = 'hold' | 'pay_first';
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

/** Eventos ya anotados en el núcleo en esta visita de la página (para no repetir la llamada al volver a la pantalla). */
const visited = new Set<string>();

export function rememberEvent(code: string): void {
  const next = [code.toUpperCase(), ...myEventCodes().filter((c) => c !== code.toUpperCase())].slice(0, 50);
  try { store()?.setItem(EVENTS_KEY, JSON.stringify(next)); } catch { /* solo en memoria */ }
  // Con identidad, también en el núcleo (0107): así «Mis eventos» se rehace en otro móvil al recuperar el acceso.
  void recordVisit(code);
}

/** Anota en el núcleo que este visitante entró en el evento (una vez por visita de la página); se puede esperar. */
export async function recordVisit(code: string): Promise<void> {
  const upper = code.toUpperCase();
  if (!visitorToken() || visited.has(upper)) return;
  visited.add(upper);
  await call('/api/v1/public/visitor/visit', { json: { eventCode: upper } }).catch(() => { visited.delete(upper); });
}

/**
 * El plano de la casa para el visitante que se aloja (`GET public/plans`, guests-api): sin identidad, nunca. Crea la
 * identidad si aún no la hay (abrir el plano es un gesto) y anota la visita, que la Edge comprueba.
 */
export async function visitorPlans(code: string): Promise<PortalPlans> {
  await ensureVisitor(code);
  await recordVisit(code);
  const raw = await withVisitor(code, () => call<PortalPlans>(`/api/v1/public/plans?event_code=${encodeURIComponent(code.toUpperCase())}`));
  return { plans: raw?.plans ?? [], spaces: raw?.spaces ?? [], icons: raw?.icons ?? [], decor: raw?.decor ?? [], images: raw?.images ?? [] };
}

/** Abre «Alójate aquí» de ese evento en este móvil (QR o enlace de Flow). */
export function unlockLodging(code: string): void {
  const next = [code.toUpperCase(), ...lodgingCodes().filter((c) => c !== code.toUpperCase())].slice(0, 50);
  try { store()?.setItem(LODGING_KEY, JSON.stringify(next)); } catch { /* solo en esta visita */ }
}

function lodgingCodes(): string[] {
  try {
    const list = JSON.parse(store()?.getItem(LODGING_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string' && EVENT_CODE.test(c)) : [];
  } catch { return []; }
}

/** ¿Tiene este móvil abierto «Alójate aquí» de ese evento? */
export function lodgingUnlocked(code: string): boolean {
  return lodgingCodes().includes(code.toUpperCase());
}

/** «Salir de este móvil»: el token, la lista de eventos y la caché del visitante. */
export async function forgetVisitor(): Promise<void> {
  // Revoca solo el token de este móvil (C11 v2); sin red o sin él, se borra igual aquí.
  if (visitorToken()) await call('/api/v1/public/visitor/logout', { json: {} }).catch(() => undefined);
  try { store()?.removeItem(TOKEN_KEY); store()?.removeItem(EVENTS_KEY); store()?.removeItem(RENEWED_KEY); store()?.removeItem(LODGING_KEY); } catch { /* nada guardado */ }
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

/**
 * Traspaso de la identidad desde otra app (núcleo 0106; la carta de Flow enlaza a `/e/<código>?alojate&v=<código>`): canjea
 * el código de un solo uso y guarda su token como el de este móvil. Solo si este móvil aún no tiene identidad: un enlace
 * con el código de otra persona no puede sustituir la suya (fijación de sesión); con una ya guardada, se ignora.
 */
export async function redeemHandoff(code: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(code) || visitorToken()) return false;
  const out = await call<{ visitorId?: string; token?: string }>('/api/v1/public/visitor/handoff/redeem', { json: { code }, visitor: false });
  if (!out.token) return false;
  try { store()?.setItem(TOKEN_KEY, out.token); } catch { /* sin almacenamiento: dura lo que la pestaña */ }
  return true;
}

// --- «Guarda tu acceso» (C11 v2, núcleo 0106): código de un solo uso al correo ------------------------------------------
/** Pide el código al correo. El núcleo responde igual exista o no. */
export async function sendEmailCode(email: string): Promise<void> {
  await call('/api/v1/public/visitor/email', { json: { email } });
}

/**
 * Canjea el código. Si el correo era nuevo, queda guardado con este visitante; si ya guardaba otro acceso, llega su token y
 * este móvil pasa a él (`recovered`).
 */
export async function verifyEmailCode(email: string, code: string): Promise<{ recovered: boolean }> {
  const out = await call<{ visitorId?: string; token?: string; recovered?: boolean; saved?: boolean }>('/api/v1/public/visitor/email/verify', { json: { email, code } });
  if (out.token) {
    try { store()?.setItem(TOKEN_KEY, out.token); } catch { /* sin almacenamiento: dura lo que la pestaña */ }
    await cache.clearUser(CACHE_USER);
    // «Mis eventos» vive en cada móvil: al recuperar, se rellena con los del acceso, si el núcleo los da.
    await visitorMe().then((me) => { for (const code of [...me.eventCodes].reverse()) rememberEvent(code); }).catch(() => undefined);
    return { recovered: true };
  }
  return { recovered: out.recovered === true };
}

/**
 * «Tu ficha está lista» (núcleo 0106 con `booking.visitor_claim`): si el personal aceptó su petición y le creó ficha, el
 * núcleo une este visitante a ella y da un enlace de un solo uso (10 minutos) para entrar en su ficha.
 */
export function claimGuest(code: string, requestId: string): Promise<{ loginToken: string }> {
  return withVisitor(code, () => call<{ loginToken: string }>('/api/v1/public/visitor/claim', { json: { requestId } }));
}

/** Quita el correo de este acceso. */
export async function forgetEmail(): Promise<void> {
  await call('/api/v1/public/visitor/email/forget', { json: {} });
}

/** Su acceso: si tiene correo guardado y su pista («v•••@g•••.com»). */
export async function visitorMe(): Promise<{ emailSaved: boolean; emailHint: string | null; eventCodes: string[] }> {
  const out = await call<{ emailSaved?: boolean; emailHint?: string | null; eventCodes?: unknown }>('/api/v1/public/visitor/me');
  return { emailSaved: out.emailSaved === true, emailHint: typeof out.emailHint === 'string' ? out.emailHint : null,
    // Los eventos de este visitante, el más reciente primero (núcleo 0107).
    eventCodes: Array.isArray(out.eventCodes) ? out.eventCodes.filter((c): c is string => typeof c === 'string' && EVENT_CODE.test(c)) : [] };
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
    // `booking_public_events` lo trae; `booking_event` (un evento por su código) aún no: entonces, el de jornadas abiertas.
    lodging: e.lodging === true || (e.lodging === undefined && e.kind === 'jornadas_abiertas') };
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
  pay: PayMode | null;
  hold_hours: number | null;
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
      available: num(r.available) ?? 0, modes, rules_text: typeof r.rules_text === 'string' && r.rules_text.trim() ? r.rules_text : null,
      pay: r.pay === 'hold' || r.pay === 'pay_first' ? r.pay : null, hold_hours: num(r.hold_hours) };
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

/** Pedir noches (Booking 0499, `POST public/stay`): crea la identidad si aún no la hay (es un gesto) y sustituye la anterior del evento. */
export function sendStay(code: string, input: { mode_id: string; from: string; to: string; persons: number; name: string; contact?: string | null; note?: string | null }): Promise<VisitorRequest & { id: string }> {
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : undefined);
  return withVisitor(code, () => call<VisitorRequest & { id: string }>('/api/booking/v1/public/stay', {
    json: { event_code: code.toUpperCase(), mode_id: input.mode_id, from: input.from, to: input.to, persons: input.persons, name: input.name.trim(), contact: clean(input.contact), note: clean(input.note) },
  }));
}

// --- «Alójate aquí» (VG, por Core: como la barra) -------------------------------------------------------------------
/** Camas libres **todas** las noches `[from, to)` (Booking, `booking_public_beds`): nombres públicos, nunca huéspedes. */
export interface PublicBeds {
  rooms: Array<{ id: string; name: string; beds: Array<{ id: string; label: string; kind: string | null; free: boolean; resource_bed_id: string | null }> }>;
  price_night_cents: number | null;
  nights: number;
}

export function publicBeds(code: string, from: string, to: string): Promise<Loaded<PublicBeds>> {
  return readPublic('booking_public_beds', { event_code: code.toUpperCase(), from, to }, (raw) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const rooms = (Array.isArray(r.rooms) ? r.rooms : []).flatMap((x) => {
      const room = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      if (!str(room.id) || !str(room.name)) return [];
      const beds = (Array.isArray(room.beds) ? room.beds : []).flatMap((y) => {
        const b = (y && typeof y === 'object' ? y : {}) as Record<string, unknown>;
        return str(b.id) && str(b.label) ? [{ id: b.id as string, label: b.label as string, kind: str(b.kind), free: b.free === true, resource_bed_id: str(b.resource_bed_id) }] : [];
      });
      return [{ id: room.id as string, name: room.name as string, beds }];
    });
    return { rooms, price_night_cents: typeof r.price_night_cents === 'number' ? r.price_night_cents : null, nights: typeof r.nights === 'number' ? r.nights : 0 };
  });
}

/** Datos del viajero en borrador (los nombres de `booking.guests`); ninguno obligatorio para guardar. */
export type TravelerFields = Partial<Record<'first_name' | 'last_name_1' | 'last_name_2' | 'document_type' | 'document_number' | 'birth_date' | 'phone' | 'email', string>>;

/** Su estancia en este evento (`booking_visitor_stay`, con el visitante que pone el kit), o null si no tiene. */
export interface VisitorStay {
  id: string; number: string | null; status: 'por_pagar' | 'pagada' | 'alojado' | 'salida' | 'caducada' | string;
  from: string | null; to: string | null; bed: { room: string; label: string } | null; total_cents: number | null; paid_at: string | null; missing: string[];
  hold_until: string | null;
}

export async function myStay(code: string): Promise<VisitorStay | null> {
  if (!visitorToken()) return null;
  const out = await withVisitor(code, () => call<Record<string, unknown> | null>(`/api/v1/public/booking_visitor_stay?event_code=${encodeURIComponent(code.toUpperCase())}`));
  if (!out || typeof out.id !== 'string') return null;
  // `bed` (la primera) o, si no viene, la primera de `beds`.
  const first = out.bed ?? (Array.isArray(out.beds) ? out.beds[0] : null);
  const bed = first && typeof first === 'object' ? first as { room?: unknown; label?: unknown } : null;
  return {
    // `stay_status` (Booking): por_pagar · caducada · pagada · alojado · salida · descartada.
    id: out.id, number: out.number == null ? null : String(out.number), status: String(out.stay_status ?? out.status ?? ''),
    hold_until: typeof out.hold_until === 'string' ? out.hold_until : null,
    from: typeof out.from === 'string' ? out.from : null, to: typeof out.to === 'string' ? out.to : null,
    bed: bed && typeof bed.room === 'string' && typeof bed.label === 'string' ? { room: bed.room, label: bed.label } : null,
    total_cents: typeof out.total_cents === 'number' ? out.total_cents : null, paid_at: typeof out.paid_at === 'string' ? out.paid_at : null,
    // Por persona (`[[campo…]]`) o plano: aquí, una persona.
    missing: (Array.isArray(out.missing) ? (Array.isArray(out.missing[0]) ? out.missing[0] as unknown[] : out.missing) : []).filter((m): m is string => typeof m === 'string'),
  };
}

/** «Ir a pagar»: la estancia `por_pagar` con su número; la cama elegida o «asignadme una». Crea la identidad (es un gesto). */
export function startStay(code: string, input: { from: string; to: string; bed_id: string | null; traveler: TravelerFields }): Promise<{ id: string; number: string | null; status: string; total_cents: number | null; bed: { room: string; label: string } | null }> {
  const traveler = Object.fromEntries(Object.entries(input.traveler).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v!.trim()]));
  return withVisitor(code, () => call('/api/booking/v1/public/stay', {
    json: { event_code: code.toUpperCase(), from: input.from, to: input.to, persons: 1, name: traveler.first_name ?? '',
      ...(input.bed_id ? { bed_id: input.bed_id } : { assign: true }), traveler },
  }));
}

/** Completa el borrador del viajero (sin perder la cama); devuelve lo que aún faltará para dormir. */
export function saveTraveler(code: string, stayId: string, fields: TravelerFields): Promise<{ missing: string[] }> {
  return withVisitor(code, () => call<{ missing?: unknown[] }>('/api/booking/v1/public/stay/traveler', { json: { stay_id: stayId, fields } }))
    .then((out) => ({ missing: (Array.isArray(out?.missing) ? (Array.isArray(out.missing[0]) ? out.missing[0] as unknown[] : out.missing) : []).filter((m): m is string => typeof m === 'string') }));
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
