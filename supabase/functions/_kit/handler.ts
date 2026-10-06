/** Handler HTTP común: CORS por dominio, autenticación, rutas del núcleo y rutas propias de la app. */
import { Fault, fail, messageFor } from './errors.ts';
import { createSupabase, type SupabaseConfig } from './supabase.ts';
import { createAuth } from './auth.ts';
import { createSync, integer, type AppHooks, type RequestContext } from './sync.ts';
import { createUploads, type UploadsConfig } from './uploads.ts';

export interface AppConfig extends SupabaseConfig {
  /** Identificador de la app en core.apps (tasks, invoices, booking, food). */
  app: string;
  /** Slug de la función, para recortar el prefijo de la ruta. */
  slug: string;
  release?: string;
  stage?: string;
  origins: string[];
  uploads?: UploadsConfig;
  hooks?: AppHooks;
  /** Rutas propias de la app, evaluadas después de las del núcleo. */
  routes?: AppRoute[];
  maxBodyBytes?: number;
}

export interface RouteRequest {
  request: Request;
  url: URL;
  path: string;
  method: string;
  params: Record<string, string>;
  ctx: RequestContext;
  json(): Promise<any>;
}

export interface AppRoute {
  method: string;
  /** Patrón con segmentos `:nombre`, relativo a `/api/v1/`, por ejemplo `invoices/:id/import`. */
  pattern: string;
  handler: (req: RouteRequest) => Promise<unknown | Response>;
}

export interface AppHandler {
  (request: Request): Promise<Response>;
}

export function createApp(config: AppConfig): AppHandler {
  const supabase = createSupabase(config);
  const auth = createAuth(supabase);
  const sync = createSync(supabase, config.app, config.hooks ?? {});
  const uploads = config.uploads ? createUploads(supabase, config.app, config.uploads) : null;
  const origins = new Set(config.origins);
  const maxBody = config.maxBodyBytes ?? 8 * 1024 * 1024;
  const prefix = new RegExp(`^(?:/functions/v1)?/${config.slug.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?:-qa)?(?=/|$)`);

  const routes: AppRoute[] = [
    { method: 'GET', pattern: 'bootstrap', handler: async ({ ctx }) => ({ ...ctx.bootstrap, release: config.release ?? 'development' }) },
    { method: 'GET', pattern: 'snapshot', handler: ({ ctx, url }) => sync.snapshot(ctx, url.searchParams) },
    { method: 'GET', pattern: 'changes', handler: ({ ctx, url }) => sync.changes(ctx, url.searchParams) },
    { method: 'POST', pattern: 'commands', handler: async ({ ctx, json }) => sync.commit(ctx, await json()) },
    { method: 'GET', pattern: 'history', handler: ({ ctx, url }) => sync.history(ctx, url.searchParams) },
    { method: 'POST', pattern: 'history/:cursor/undo-plan', handler: ({ ctx, params }) => sync.undoPlan(ctx, integer(params.cursor ?? null, 0)) },
    { method: 'POST', pattern: 'history/:cursor/undo', handler: async ({ ctx, params, json }) => sync.undo(ctx, integer(params.cursor ?? null, 0), await json()) },
    { method: 'POST', pattern: 'trash/purge', handler: async ({ ctx, json }) => sync.purgeDeleted(ctx, await json()) },
    { method: 'GET', pattern: 'members', handler: ({ ctx }) => sync.members(ctx) },
    { method: 'POST', pattern: 'members', handler: async ({ ctx, json }) => sync.setMember(ctx, await json()) },
    { method: 'POST', pattern: 'members/invite', handler: async ({ ctx, json }) => sync.invite(ctx, await json()) },
    { method: 'GET', pattern: 'read/:name', handler: ({ ctx, params, url }) => sync.read(ctx, params.name ?? '', readArgs(url.searchParams)) },
    { method: 'POST', pattern: 'read/:name', handler: async ({ ctx, params, json }) => sync.read(ctx, params.name ?? '', await json()) },
    { method: 'POST', pattern: 'auth/logout', handler: async ({ request }) => { await auth.logout(bearer(request)!); return { loggedOut: true }; } },
    { method: 'POST', pattern: 'auth/password', handler: async ({ request, ctx, json }) => auth.changePassword(bearer(request)!, ctx.user, await json()) },
    { method: 'GET', pattern: 'me', handler: async ({ ctx }) => ({ userId: ctx.user.id, email: ctx.user.email, role: ctx.membership.role, scopes: ctx.membership.scopes }) },
  ];
  if (uploads) {
    routes.push(
      { method: 'POST', pattern: 'uploads', handler: async ({ ctx, json }) => uploads.create(ctx, await json()) },
      { method: 'POST', pattern: 'uploads/:id/verify', handler: ({ ctx, params }) => uploads.verify(ctx, params.id ?? '') },
      { method: 'GET', pattern: 'files/:id', handler: ({ ctx, params }) => uploads.readUrl(ctx, params.id ?? '') },
    );
  }
  routes.push(...(config.routes ?? []));
  const compiled = routes.map((route) => ({ ...route, matcher: compile(route.pattern) }));

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,apikey,content-type',
    };
    if (origin && origins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const json = (out: unknown, status = 200) => new Response(JSON.stringify(out), { status, headers });
    try {
      if (origin && !origins.has(origin)) fail(403, 'ORIGIN_REJECTED', messageFor('ORIGIN_REJECTED'));
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      const url = new URL(request.url);
      const path = url.pathname.replace(prefix, '');
      if ((path === '/health' || path === '/api/v1/health') && request.method === 'GET') {
        return json({ status: 'ok', app: config.app, stage: config.stage ?? 'beta', release: config.release ?? 'development' });
      }
      const readJson = async () => {
        if (Number(request.headers.get('content-length') ?? 0) > maxBody) fail(413, 'PAYLOAD_TOO_LARGE', messageFor('PAYLOAD_TOO_LARGE'));
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > maxBody) fail(413, 'PAYLOAD_TOO_LARGE', messageFor('PAYLOAD_TOO_LARGE'));
        let body: unknown;
        try { body = JSON.parse(raw); } catch { fail(400, 'INVALID_JSON', messageFor('INVALID_JSON')); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON', 'Se necesita un objeto JSON.');
        return body;
      };
      if (path === '/api/v1/auth/login' && request.method === 'POST') return json(await auth.login(await readJson()));
      if (path === '/api/v1/auth/refresh' && request.method === 'POST') return json(await auth.refresh(await readJson()));
      if (!path.startsWith('/api/v1/')) fail(404, 'NOT_FOUND', 'Ruta desconocida.');
      const token = bearer(request);
      const user = await auth.identity(token);
      const ctx = await sync.context(user, token!);
      const relative = path.slice('/api/v1/'.length);
      for (const route of compiled) {
        if (route.method !== request.method) continue;
        const params = route.matcher(relative);
        if (!params) continue;
        const result = await route.handler({ request, url, path, method: request.method, params, ctx, json: readJson });
        return result instanceof Response ? result : json(result);
      }
      fail(404, 'NOT_FOUND', 'Ruta desconocida.');
    } catch (error) {
      if (error instanceof Fault) return json(error.toJSON(), error.status);
      console.error('[ikisai]', (error as Error)?.message);
      return json({ error: { code: 'INTERNAL_ERROR', message: 'Error interno.', details: null } }, 500);
    }
  };
}

/** `?where[col]=valor&limit=&offset=` → `{ where: {col: valor}, limit, offset }` */
function readArgs(params: URLSearchParams): Record<string, unknown> {
  const where: Record<string, string> = {};
  const args: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const m = key.match(/^where\[([a-z0-9_]+)\]$/);
    if (m) where[m[1]!] = value;
    else if (key === 'limit' || key === 'offset') args[key] = integer(value, 0, key);
  }
  if (Object.keys(where).length) args.where = where;
  return args;
}

function bearer(request: Request): string | null {
  return request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1] ?? null;
}

function compile(pattern: string): (path: string) => Record<string, string> | null {
  const parts = pattern.split('/');
  return (path: string) => {
    const segments = path.split('/').filter((s, i, arr) => !(s === '' && i === arr.length - 1));
    if (segments.length !== parts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const segment = segments[i]!;
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segment);
      else if (part !== segment) return null;
    }
    return params;
  };
}
