/**
 * Ikisai Flow · API (docs/flow/API.md). El núcleo del kit (sesión, bootstrap, sincronización con `core.commit` y los
 * procedimientos `flow.*`, feedback y uso) y las rutas públicas sin sesión de la carta (§6 y §14, FLOW-DIR-001 §1), que se
 * atienden aquí antes de pasar la petición al kit:
 * - `GET public/menu`: la carta (cacheable 30 s).
 * - `POST public/customer`: crea el cliente anónimo; devuelve su token (solo para el navegador) y su número.
 * - `POST public/orders`: envía la cesta como pedido abierto del cliente de la cabecera `X-Flow-Customer`.
 * - `GET public/mine`: los pedidos de ese cliente, y nada más.
 * El token nunca llega a la base de datos: aquí se resume con SHA-256 y solo viaja el resumen. Las escrituras van por la
 * escritura pública del núcleo (actor «Flow (sistema)», lote público que limita `flow.guard`).
 */
import { createApp, createSupabase, isFault, sha256Hex, type AppConfig, type Supabase } from '../_kit/mod.ts';
import { APP, TABLES } from '../_domain/flow/mod.ts';

export const FLOW_ORIGINS = ['https://flow.ikisai.com', 'https://ikisai-flow.pages.dev'];

/** Lecturas públicas registradas por las migraciones 0900 y 0901. */
export const PUBLIC_MENU = 'flow_menu';
export const PUBLIC_MINE = 'flow_mine';
export const CUSTOMER_HEADER = 'x-flow-customer';
export const MAX_PUBLIC_LINES = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;

/** Escritura pública del núcleo (helper `applyPublicOperations` del kit, migración core 0094). */
export type PublicWriter = (supabase: Supabase, app: string, operations: unknown[]) => Promise<{ cursor: number; results: unknown[] }>;

type FlowBase = Omit<AppConfig, 'app' | 'slug' | 'origins' | 'routes'> & Partial<Pick<AppConfig, 'origins'>>;

interface Mine { number: number | null; customerId: string | null; projectId: string | null; orders: unknown[] }

export function createFlowApp(base: FlowBase, options: { publicWrite?: PublicWriter } = {}) {
  const origins = base.origins ?? FLOW_ORIGINS;
  const supabase = createSupabase(base);
  const kit = createApp({ ...base, app: APP, slug: 'flow-api', origins, routes: [] });
  const publicWrite: PublicWriter = options.publicWrite ?? (async () => {
    // Hasta que el núcleo publique la escritura pública (0094), enviar pedidos desde la carta no está disponible.
    throw Object.assign(new Error('PUBLIC_WRITE_UNAVAILABLE'), { status: 503, code: 'PUBLIC_WRITE_UNAVAILABLE' });
  });

  async function handlePublic(request: Request, route: string): Promise<Response> {
    const origin = request.headers.get('origin');
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin', 'Cache-Control': 'no-store' };
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    const error = (status: number, code: string, message: string) => reply({ error: { code, message, details: null } }, status);
    if (origin && !origins.includes(origin)) return error(403, 'ORIGIN_REJECTED', 'Origen no autorizado.');

    const mine = async (tokenHash: string) => supabase.rpc<Mine>('core_public_read', { p_name: PUBLIC_MINE, p_args: { token_hash: tokenHash } });
    const customerHash = async (): Promise<string | null> => {
      const token = (request.headers.get(CUSTOMER_HEADER) ?? '').trim().toLowerCase();
      return TOKEN.test(token) ? sha256Hex(token) : null;
    };

    try {
      if (route === 'menu' && request.method === 'GET') {
        const out = await supabase.rpc<{ project: string | null; products: unknown[] } | null>('core_public_read', { p_name: PUBLIC_MENU, p_args: {} });
        return reply({ project: out?.project ?? null, products: Array.isArray(out?.products) ? out.products : [] }, 200, { 'Cache-Control': 'public, max-age=30' });
      }
      if (route === 'mine' && request.method === 'GET') {
        const hash = await customerHash();
        if (!hash) return error(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
        const out = await mine(hash);
        if (!out?.customerId) return error(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
        return reply({ number: out.number, orders: out.orders ?? [] });
      }
      if (route === 'customer' && request.method === 'POST') {
        const menu = await supabase.rpc<{ projectId?: string | null } | null>('core_public_read', { p_name: PUBLIC_MENU, p_args: {} });
        const projectId = menu?.projectId ?? null;
        if (!projectId) return error(409, 'MENU_CLOSED', 'La barra no está abierta ahora mismo.');
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        const hash = await sha256Hex(token);
        await publicWrite(supabase, APP, [{ op: 'insert', table: TABLES.customers, id: crypto.randomUUID(), fields: { project_id: projectId, token_hash: hash } }]);
        const out = await mine(hash);
        return reply({ token, number: out?.number ?? null });
      }
      if (route === 'orders' && request.method === 'POST') {
        const hash = await customerHash();
        const me = hash ? await mine(hash) : null;
        if (!me?.customerId || !me.projectId) return error(401, 'CUSTOMER_UNKNOWN', 'Este dispositivo aún no tiene número.');
        const body = await request.json().catch(() => null) as { lines?: Array<{ productId?: unknown; quantity?: unknown }> } | null;
        const lines = Array.isArray(body?.lines) ? body!.lines : [];
        if (!lines.length || lines.length > MAX_PUBLIC_LINES) return error(422, 'INVALID_ORDER', `El pedido debe tener entre 1 y ${MAX_PUBLIC_LINES} productos.`);
        for (const l of lines) {
          if (typeof l.productId !== 'string' || !UUID.test(l.productId) || !Number.isInteger(l.quantity) || (l.quantity as number) < 1 || (l.quantity as number) > 99) {
            return error(422, 'INVALID_ORDER', 'Hay un producto o una cantidad que no vale.');
          }
        }
        const orderId = crypto.randomUUID();
        await publicWrite(supabase, APP, [
          { op: 'insert', table: TABLES.orders, id: orderId, fields: { project_id: me.projectId, origin: 'public', customer_id: me.customerId } },
          ...lines.map((l, i) => ({ op: 'insert', table: TABLES.orderLines, id: crypto.randomUUID(), fields: { order_id: orderId, product_id: l.productId, quantity: l.quantity, position: i + 1 } })),
        ]);
        return reply({ orderId, number: me.number });
      }
      return error(404, 'NOT_FOUND', 'Ruta no encontrada.');
    } catch (caught) {
      const fault = caught as { status?: number; code?: string };
      if (isFault(caught) && caught.status < 500) return error(caught.status, caught.code, caught.message);
      if (fault?.code === 'PUBLIC_WRITE_UNAVAILABLE') return error(503, 'PUBLIC_WRITE_UNAVAILABLE', 'Enviar el pedido aún no está disponible: enséñalo en la barra.');
      return error(503, 'BACKEND_UNAVAILABLE', 'No disponible ahora mismo. Inténtalo de nuevo.');
    }
  }

  return async (request: Request): Promise<Response> => {
    const match = new URL(request.url).pathname.match(/\/api\/v1\/public\/(menu|customer|orders|mine)\/?$/);
    if (match && ['GET', 'POST', 'OPTIONS'].includes(request.method)) {
      if (request.method === 'OPTIONS') return kit(request);
      return handlePublic(request, match[1]!);
    }
    return kit(request);
  };
}
