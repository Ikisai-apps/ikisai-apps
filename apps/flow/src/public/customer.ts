/**
 * Cliente anónimo de la carta (FLOW-DIR-001 §1): su número («Soy el 142») y el token que solo vive en este navegador
 * (`localStorage`), para enviar pedidos y ver los suyos. Otro navegador, el modo incógnito o borrar los datos dan otro
 * número: VG acepta esa limitación. Con el número no se ve nada; con el token, solo lo propio.
 */
const KEY = 'ikisai-flow-cliente';
const HEADER = 'X-Flow-Customer';

export interface CustomerId { token: string; number: number | null }

export interface MyOrder {
  id: string; createdAt: string; status: 'open' | 'paid' | 'delivered'; paySeq: number | null; totalCents: number | null; preparing: boolean;
  /** Pedido de un miembro (0952): su nombre; `testExcluded`, de prueba (fuera del horario del evento: no cuenta en caja). */
  testName?: string | null; testExcluded?: boolean;
  lines: Array<{ name: string; scope: string; code: string; quantity: number; deliveredQty: number; prepared: boolean; preparedQty: number }>;
}

export class PublicApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function readCustomer(): CustomerId | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as CustomerId | null;
    return value && /^[0-9a-f]{64}$/.test(value.token) ? value : null;
  } catch { return null; }
}

function saveCustomer(value: CustomerId | null): void {
  try { if (value) localStorage.setItem(KEY, JSON.stringify(value)); else localStorage.removeItem(KEY); } catch { /* sin almacenamiento: dura lo que la página */ }
}

async function call<T>(path: string, init: RequestInit & { customer?: CustomerId | null; visitor?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (init.customer) headers[HEADER] = init.customer.token;
  if (init.visitor) headers['X-Visitor'] = init.visitor;
  let res: Response;
  try { res = await fetch(`/api/v1/public/${path}`, { ...init, headers }); } catch { throw new PublicApiError(0, 'NETWORK', 'No hay conexión.'); }
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) throw new PublicApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? 'No se ha podido completar.');
  return data as T;
}

/** El número de este navegador; si no tiene, lo pide al servidor (que lo asigna sin colisiones). */
export async function ensureCustomer(): Promise<CustomerId> {
  const known = readCustomer();
  if (known) return known;
  const out = await call<{ token: string; number: number | null }>('customer', { method: 'POST', body: '{}' });
  const value = { token: out.token, number: out.number };
  saveCustomer(value);
  return value;
}

/** Envía la cesta como pedido. Solo con la respuesta del servidor se dice que el pedido está en barra. */
export async function submitOrder(lines: Array<{ productId: string; quantity: number }>): Promise<{ orderId: string; number: number | null }> {
  let customer = await ensureCustomer();
  try {
    return await call('orders', { method: 'POST', body: JSON.stringify({ lines }), customer });
  } catch (error) {
    // El servidor ya no conoce este número (otro servicio o datos borrados): se pide uno nuevo una vez.
    if (error instanceof PublicApiError && error.code === 'CUSTOMER_UNKNOWN') {
      saveCustomer(null);
      customer = await ensureCustomer();
      return call('orders', { method: 'POST', body: JSON.stringify({ lines }), customer });
    }
    throw error;
  }
}

/**
 * Canje del enlace de Guests (`?invitacion=…`, 0910): este navegador pasa a ser el cliente del huésped, con su número.
 * El enlace caduca a los 10 minutos y cada canje deja sin valor el token anterior.
 */
export async function redeemInvitation(invitation: string): Promise<CustomerId> {
  const out = await call<{ token: string; number: number | null }>('invitation', { method: 'POST', body: JSON.stringify({ invitation }) });
  const value = { token: out.token, number: out.number };
  saveCustomer(value);
  return value;
}

export async function myOrders(): Promise<{ number: number | null; orders: MyOrder[] } | null> {
  const customer = readCustomer();
  if (!customer) return null;
  try {
    const out = await call<{ number: number | null; orders: MyOrder[] }>('mine', { customer });
    if (out.number !== customer.number) saveCustomer({ ...customer, number: out.number });
    return out;
  } catch (error) {
    if (error instanceof PublicApiError && error.code === 'CUSTOMER_UNKNOWN') { saveCustomer(null); return null; }
    throw error;
  }
}

/**
 * «Alójate aquí» (0936): pasa a este móvil a ven.ikisai.com, pestaña de alojamiento, sin pedir datos.
 * 1. Un visitante del kit para este navegador (si no lo tiene ya).
 * 2. Su cliente web de la carta se liga a ese visitante, para que «Mi pedido» siga a la misma persona allí.
 * 3. Un código de traspaso de un solo uso (5 min, misma IP), que ven.ikisai.com canjea.
 */
const VISITOR_KEY = 'ikisai-flow-visitante';

function readVisitor(): string | null {
  try { const v = localStorage.getItem(VISITOR_KEY); return v && /^[0-9a-f]{64}$/.test(v) ? v : null; } catch { return null; }
}

/** Liga el cliente web de esta carta al visitante de este navegador (una vez; si no se puede, se sigue sin ligar). */
async function linkVisitor(visitor: string): Promise<void> {
  const customer = readCustomer();
  if (customer) await call('customer_visitor', { method: 'POST', body: '{}', customer, visitor }).catch(() => undefined);
}

/**
 * Traspaso desde ven.ikisai.com (`?v=<código>`, núcleo 0106; URLS_ENTRADA, 27-10): canjea el código de un solo uso y guarda
 * su visitante como el de este navegador. Solo si aún no tiene uno: un enlace con el código de otra persona no sustituye
 * la identidad ya guardada (como hace Guests).
 */
export async function redeemVisitorHandoff(code: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(code) || readVisitor()) return false;
  const out = await call<{ token?: string }>('visitor/handoff/redeem', { method: 'POST', body: JSON.stringify({ code }) });
  if (!out.token || !/^[0-9a-f]{64}$/.test(out.token)) return false;
  try { localStorage.setItem(VISITOR_KEY, out.token); } catch { /* sin almacenamiento: vale para esta página */ }
  await linkVisitor(out.token);
  return true;
}

/** Tras pedir: el cliente web nuevo queda ligado al visitante que llegó de ven, si lo hay. */
export async function linkCustomerToVisitor(): Promise<void> {
  const visitor = readVisitor();
  if (visitor) await linkVisitor(visitor);
}

/**
 * El siguiente recorrido en ven.ikisai.com (`datos` o `alojate`), con este móvil: visitante del kit (si no lo tiene, uno nuevo),
 * su cliente web ligado y un código de traspaso de un uso. `alojate` lleva también el parámetro de antes (`?alojate`).
 */
export async function venLink(eventCode: string, next: 'datos' | 'alojate'): Promise<string> {
  let visitor = readVisitor();
  if (!visitor) {
    const out = await call<{ token: string }>('visitor', { method: 'POST', body: JSON.stringify({ eventCode }) });
    visitor = out.token;
    try { localStorage.setItem(VISITOR_KEY, visitor); } catch { /* sin almacenamiento: vale para este traspaso */ }
  }
  await linkVisitor(visitor);
  const { code } = await call<{ code: string }>('visitor/handoff', { method: 'POST', body: '{}', visitor });
  return `https://ven.ikisai.com/e/${encodeURIComponent(eventCode)}?${next === 'alojate' ? 'alojate&' : ''}siguiente=${next}&v=${encodeURIComponent(code)}`;
}

/** «Alójate aquí» (0936). */
export const lodgingLink = (eventCode: string) => venLink(eventCode, 'alojate');
