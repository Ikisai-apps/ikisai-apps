/**
 * Ikisai Flow · API (docs/flow/API.md). El núcleo del kit (sesión, bootstrap, sincronización con `core.commit` y los
 * procedimientos `flow.*`, feedback y uso) y una ruta propia sin sesión: `GET public/menu`, la carta pública (§6), que se
 * atiende aquí antes de pasar la petición al kit (P-1, aprobado por Core). Sin subidas en V1.
 */
import { createApp, createSupabase, isFault, type AppConfig } from '../_kit/mod.ts';
import { APP } from '../_domain/flow/mod.ts';

export const FLOW_ORIGINS = ['https://flow.ikisai.com', 'https://ikisai-flow.pages.dev'];

/** Lectura pública registrada por la migración 0900 (`core.allow_public_read('flow_menu', 'flow.public_menu')`). */
export const PUBLIC_MENU = 'flow_menu';
const MENU_PATH = /\/api\/v1\/public\/menu\/?$/;

type FlowBase = Omit<AppConfig, 'app' | 'slug' | 'origins' | 'routes'> & Partial<Pick<AppConfig, 'origins'>>;

export function createFlowApp(base: FlowBase) {
  const origins = base.origins ?? FLOW_ORIGINS;
  const supabase = createSupabase(base);
  const kit = createApp({ ...base, app: APP, slug: 'flow-api', origins, routes: [] });

  /** Carta pública: sin sesión, solo productos activos, cacheable 30 s. Un origen ajeno se rechaza igual que en el kit. */
  async function publicMenu(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    const error = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message, details: null } }), { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
    if (origin && !origins.includes(origin)) return error(403, 'ORIGIN_REJECTED', 'Origen no autorizado.');
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    try {
      const out = await supabase.rpc<{ project: string | null; products: unknown[] } | null>('core_public_read', { p_name: PUBLIC_MENU, p_args: {} });
      return new Response(JSON.stringify({ project: out?.project ?? null, products: Array.isArray(out?.products) ? out.products : [] }),
        { status: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=30' } });
    } catch (caught) {
      if (isFault(caught) && caught.status < 500) return error(caught.status, caught.code, 'La carta no está disponible ahora mismo.');
      return error(503, 'BACKEND_UNAVAILABLE', 'La carta no está disponible ahora mismo.');
    }
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === 'GET' && MENU_PATH.test(new URL(request.url).pathname)) return publicMenu(request);
    return kit(request);
  };
}
