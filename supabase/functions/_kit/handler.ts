/** Handler HTTP común: CORS por dominio, autenticación, rutas del núcleo y rutas propias de la app. */
import { Fault, fail, messageFor } from './errors.ts';
import { createSupabase, type SupabaseConfig } from './supabase.ts';
import { createAuth } from './auth.ts';
import { createSync, integer, type AppHooks, type RequestContext } from './sync.ts';
import { createUploads, type UploadsConfig } from './uploads.ts';
import { createAgents } from './agents.ts';
import { createMcp, type McpCore, type McpTool } from './mcp.ts';
import { createSso, passCookie, passFrom } from './sso.ts';
import { createAdmin } from './admin.ts';
import { createPortalLinks, resolvePortalLink } from './portal.ts';
import { createFeedback, createFeedbackWorker } from './feedback.ts';
import { createUsage } from './usage.ts';
import { createFilesGc } from './files-gc.ts';
import { createStorage, r2ConfigFromEnv, type ProviderName, type R2Config } from './storage.ts';

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
  /** Clave compartida para `POST /api/v1/worker/...` (secreto de la Edge). Sin ella, las rutas de worker no existen. */
  workerKey?: string;
  /** Rutas de sistema con lógica TypeScript (planificador externo): `/api/v1/worker/<pattern>`, autenticadas con `X-Ikisai-Worker-Key`, sin usuario. */
  workerRoutes?: WorkerRoute[];
  /** Herramientas MCP de dominio (contrato §3.2), además de las genéricas `<app>_snapshot`, `<app>_commit`… */
  mcpTools?: McpTool[];
  /** Solo la función de Central: monta las rutas `admin/*` de administración común (contrato §3.5). */
  admin?: boolean;
  /** Recuperación de contraseña por correo; sin indicarlo, IKISAI_PASSWORD_RECOVERY=1. */
  passwordRecovery?: boolean;
  /** Almacenamiento: R2 y proveedor por defecto. Sin indicarlo, se lee de los secretos R2_* e IKISAI_STORAGE_PROVIDER. */
  storage?: { r2?: R2Config | null; defaultProvider?: ProviderName };
  /** Solo central-api: worker del feedback (`worker/feedback/tick`), que envía a Tasks lo operativo y copia el estado de las tareas. */
  feedbackWorker?: boolean;
  /** Booking y Organizers: montan `portal-links` para emitir y gestionar enlaces de los portales (contrato §3.6). */
  portalIssuer?: boolean;
}

export interface WorkerRequest {
  request: Request;
  url: URL;
  params: Record<string, string>;
  json(): Promise<any>;
  /** Ejecuta una acción registrada (`kind 'action'`) como sistema (actor null). */
  invoke(name: string, args?: unknown): Promise<unknown>;
  /** Acceso a Supabase con service key, para lo que la acción no cubra. */
  supabase: ReturnType<typeof createSupabase>;
}

export interface WorkerRoute {
  method: string;
  /** Patrón relativo a `/api/v1/worker/`, por ejemplo `calendar/tick`. */
  pattern: string;
  handler: (req: WorkerRequest) => Promise<unknown | Response>;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

/** Resultado de ruta con cabeceras extra (Set-Cookie del pase de sesión única); el despachador las une a las de su petición. */
export class WithHeaders {
  constructor(readonly body: unknown, readonly extra: Record<string, string>, readonly status = 200) {}
}
const withHeaders = (body: unknown, extra: Record<string, string>, status = 200) => new WithHeaders(body, extra, status);

export function createApp(config: AppConfig): AppHandler {
  const supabase = createSupabase(config);
  const auth = createAuth(supabase);
  const sync = createSync(supabase, config.app, config.hooks ?? {});
  const env = (name: string) => (globalThis as any).Deno?.env?.get?.(name) as string | undefined;
  const storage = createStorage(supabase, {
    r2: config.storage?.r2 !== undefined ? config.storage.r2 : r2ConfigFromEnv(env),
    defaultProvider: config.storage?.defaultProvider ?? (env('IKISAI_STORAGE_PROVIDER') === 'r2' ? 'r2' : 'supabase'),
    fetch: config.fetch,
  });
  const uploads = config.uploads ? createUploads(supabase, config.app, config.uploads, storage) : null;
  const agents = createAgents(supabase, config.app, config.hooks ?? {}, sync.validateOperations);
  const sso = createSso(supabase, config.app);
  const mcp = createMcp(config.app, config.release ?? 'development', config.mcpTools ?? []);
  const mcpCore = (ctx: RequestContext): McpCore => ({
    commit: (body) => sync.commit(ctx, body),
    prepare: (body) => agents.prepare(ctx, body),
    read: (name, args) => sync.read(ctx, name, args ?? {}),
    snapshot: (tables, o = {}) => sync.snapshot(ctx, new URLSearchParams({ tables: tables.join(','), ...(o.includeDeleted ? { includeDeleted: '1' } : {}), ...(o.limit ? { limit: String(o.limit) } : {}), ...(o.offset ? { offset: String(o.offset) } : {}) })),
    changes: (after, limit) => sync.changes(ctx, new URLSearchParams({ after: String(after), ...(limit ? { limit: String(limit) } : {}) })),
    history: (before, limit) => sync.history(ctx, new URLSearchParams({ ...(before !== null ? { before: String(before) } : {}), ...(limit ? { limit: String(limit) } : {}) })),
    proposals: (status) => agents.list(ctx, new URLSearchParams(status ? { status } : {})),
    proposal: (id) => agents.get(ctx, id),
    undoPlan: (cursor) => sync.undoPlan(ctx, cursor),
    undo: (cursor, body) => sync.undo(ctx, cursor, body),
    invoke: (name, args) => { if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN')); return sync.invoke(ctx.user.id, name, args ?? {}); },
  });
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
    { method: 'POST', pattern: 'invoke/:name', handler: async ({ ctx, params, json }) => { if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN')); return sync.invoke(ctx.user.id, params.name ?? '', await json()); } },
    // Cerrar sesión: esta app y el pase de sesión única del dispositivo; `{everywhere: true}` cierra todas las sesiones y pases.
    { method: 'POST', pattern: 'auth/logout', handler: async ({ request }) => {
      let everywhere = false;
      try { const raw = await request.text(); everywhere = raw ? JSON.parse(raw)?.everywhere === true : false; } catch { /* sin cuerpo */ }
      await auth.logout(bearer(request)!, everywhere);
      await sso.revoke(passFrom(request), everywhere).catch(() => undefined);
      return withHeaders({ loggedOut: true, everywhere }, { 'Set-Cookie': passCookie(null, request.headers.get('origin')) });
    } },
    // Cambiar la contraseña revoca los pases de la cuenta y emite uno nuevo para este dispositivo.
    { method: 'POST', pattern: 'auth/password', handler: async ({ request, ctx, json }) => {
      const out = await auth.changePassword(bearer(request)!, ctx.user, await json());
      await sso.revokeUser(ctx.user.id);
      const pass = await sso.issueForUser(ctx.user.id);
      return withHeaders(out, { 'Set-Cookie': passCookie(pass, request.headers.get('origin')) });
    } },
    // Catálogo para el lanzador común: apps a las que tiene acceso la cuenta.
    { method: 'GET', pattern: 'apps', handler: async ({ ctx }) => ({ items: await supabase.rpc('core_my_apps', { p_user: ctx.user.id }), current: config.app }) },
    { method: 'GET', pattern: 'me', handler: async ({ ctx }) => ({ userId: ctx.user.id, email: ctx.user.email, role: ctx.membership.role, scopes: ctx.membership.scopes, kind: ctx.user.kind, name: ctx.user.name ?? ctx.bootstrap.profile.displayName }) },
    // Agentes (contrato §3): propuestas con aprobación humana, claves y registro de accesos.
    { method: 'POST', pattern: 'proposals', handler: async ({ ctx, json }) => agents.prepare(ctx, await json()) },
    { method: 'GET', pattern: 'proposals', handler: ({ ctx, url }) => agents.list(ctx, url.searchParams) },
    { method: 'GET', pattern: 'proposals/:id', handler: ({ ctx, params }) => agents.get(ctx, params.id ?? '') },
    { method: 'POST', pattern: 'proposals/:id/approve', handler: ({ ctx, params }) => agents.decide(ctx, params.id ?? '', 'approve') },
    { method: 'POST', pattern: 'proposals/:id/reject', handler: ({ ctx, params }) => agents.decide(ctx, params.id ?? '', 'reject') },
    { method: 'GET', pattern: 'agents', handler: ({ ctx }) => agents.listKeys(ctx) },
    { method: 'POST', pattern: 'agents', handler: async ({ ctx, json }) => agents.issue(ctx, await json()) },
    { method: 'DELETE', pattern: 'agents/:keyId', handler: ({ ctx, params, url }) => agents.revoke(ctx, params.keyId ?? '', ['1', 'true'].includes(url.searchParams.get('onlyMembership') ?? '')) },
    { method: 'GET', pattern: 'access-log', handler: ({ ctx, url }) => agents.accessLog(ctx, url.searchParams) },
  ];
  if (uploads) {
    routes.push(
      { method: 'POST', pattern: 'uploads', handler: async ({ ctx, json }) => uploads.create(ctx, await json()) },
      { method: 'POST', pattern: 'uploads/:id/verify', handler: ({ ctx, params }) => uploads.verify(ctx, params.id ?? '') },
      { method: 'GET', pattern: 'files/:id', handler: ({ ctx, params }) => uploads.readUrl(ctx, params.id ?? '') },
    );
  }
  // Feedback y QA (contrato §3.7): en todas las apps y portales.
  const feedback = createFeedback(supabase, config.app, storage);
  routes.push(
    { method: 'POST', pattern: 'feedback/uploads', handler: async ({ ctx, json }) => feedback.uploads.create(ctx, await json()) },
    { method: 'POST', pattern: 'feedback/uploads/:id/verify', handler: ({ ctx, params }) => feedback.uploads.verify(ctx, params.id ?? '') },
    { method: 'POST', pattern: 'feedback', handler: async ({ ctx, json }) => feedback.create(ctx, await json()) },
    { method: 'GET', pattern: 'feedback', handler: ({ ctx, url }) => feedback.list(ctx, url.searchParams) },
    { method: 'GET', pattern: 'feedback/tree', handler: ({ ctx, url }) => feedback.tree(ctx, url.searchParams) },
    { method: 'GET', pattern: 'feedback/:id', handler: ({ ctx, params }) => feedback.get(ctx, params.id ?? '') },
    { method: 'POST', pattern: 'feedback/:id/support', handler: ({ ctx, params }) => feedback.act(ctx, params.id ?? '', 'support', {}) },
    { method: 'POST', pattern: 'feedback/:id/verify', handler: async ({ ctx, params, json }) => feedback.act(ctx, params.id ?? '', 'verify', await json()) },
    { method: 'POST', pattern: 'feedback/:id/reopen', handler: async ({ ctx, params, json }) => feedback.act(ctx, params.id ?? '', 'reopen', await json()) },
    { method: 'POST', pattern: 'feedback/:id/dismiss', handler: async ({ ctx, params, json }) => feedback.act(ctx, params.id ?? '', 'dismiss', await json()) },
    { method: 'POST', pattern: 'feedback/:id/approve', handler: ({ ctx, params }) => feedback.act(ctx, params.id ?? '', 'approve', {}) },
    { method: 'POST', pattern: 'feedback/:id/merge', handler: async ({ ctx, params, json }) => feedback.act(ctx, params.id ?? '', 'merge', await json()) },
  );
  // Uso semántico (contrato §3.8): totales diarios y perspectiva «Uso» del Revisor.
  const usage = createUsage(supabase, config.app);
  routes.push(
    { method: 'POST', pattern: 'usage/batch', handler: async ({ ctx, json }) => usage.batch(ctx, await json()) },
    { method: 'GET', pattern: 'usage/consent', handler: ({ ctx }) => usage.consent(ctx, false) },
    { method: 'POST', pattern: 'usage/consent', handler: ({ ctx }) => usage.consent(ctx, true) },
    { method: 'GET', pattern: 'usage/review', handler: ({ ctx, url }) => usage.review(ctx, url.searchParams) },
    { method: 'GET', pattern: 'usage/features/:id', handler: ({ ctx, params }) => usage.feature(ctx, params.id ?? '') },
    { method: 'POST', pattern: 'usage/features/:id/decision', handler: async ({ ctx, params, json }) => usage.decide(ctx, params.id ?? '', await json()) },
    { method: 'POST', pattern: 'usage/features/:id/settings', handler: async ({ ctx, params, json }) => usage.decide(ctx, params.id ?? '', await json()) },
  );
  if (config.admin) {
    const admin = createAdmin(supabase);
    routes.push(
      { method: 'GET', pattern: 'admin/accounts', handler: ({ ctx }) => admin.accounts(ctx) },
      { method: 'POST', pattern: 'admin/memberships', handler: async ({ ctx, json }) => admin.setMembership(ctx, await json()) },
      { method: 'POST', pattern: 'admin/invite', handler: async ({ ctx, json }) => admin.invite(ctx, await json()) },
      { method: 'GET', pattern: 'admin/access-log', handler: ({ ctx, url }) => admin.accessLog(ctx, url.searchParams) },
      { method: 'GET', pattern: 'admin/storage', handler: ({ ctx }) => admin.storage(ctx) },
      { method: 'GET', pattern: 'admin/agents', handler: ({ ctx }) => admin.agents(ctx) },
      { method: 'DELETE', pattern: 'admin/agents/:keyId', handler: ({ ctx, params }) => admin.revokeAgent(ctx, params.keyId ?? '') },
      { method: 'POST', pattern: 'admin/accounts/:userId/password', handler: ({ ctx, params }) => admin.resetPassword(ctx, params.userId ?? '') },
      { method: 'POST', pattern: 'admin/accounts/:userId/disable', handler: ({ ctx, params }) => admin.setDisabled(ctx, params.userId ?? '', true) },
      { method: 'POST', pattern: 'admin/accounts/:userId/enable', handler: ({ ctx, params }) => admin.setDisabled(ctx, params.userId ?? '', false) },
    );
  }
  if (config.portalIssuer) {
    const links = createPortalLinks(supabase, config.app);
    routes.push(
      { method: 'POST', pattern: 'portal-links', handler: async ({ ctx, json }) => links.issue(ctx, await json()) },
      { method: 'GET', pattern: 'portal-links', handler: ({ ctx, url }) => links.list(ctx, url.searchParams) },
      { method: 'POST', pattern: 'portal-links/:id/revoke', handler: ({ ctx, params }) => links.manage(ctx, params.id ?? '', 'revoke', {}) },
      { method: 'POST', pattern: 'portal-links/:id/extend', handler: async ({ ctx, params, json }) => links.manage(ctx, params.id ?? '', 'extend', await json()) },
    );
  }
  routes.push(...(config.routes ?? []));
  const compiled = routes.map((route) => ({ ...route, matcher: compile(route.pattern) }));
  const workerRoutes = [...(config.workerRoutes ?? [])];
  if (config.feedbackWorker) {
    const feedbackWorker = createFeedbackWorker(supabase, { workerKey: config.workerKey, fetch: config.fetch });
    workerRoutes.push({ method: 'POST', pattern: 'feedback/tick', handler: () => feedbackWorker.tick() });
    // Recogida de huérfanos del almacenamiento (ALMACENAMIENTO.md fase 2), también en central-api.
    const filesGc = createFilesGc(supabase, storage);
    workerRoutes.push({ method: 'POST', pattern: 'files/gc', handler: () => filesGc.tick() });
  }
  const compiledWorkers = workerRoutes.map((route) => ({ ...route, matcher: compile(route.pattern) }));

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
    const json = (out: unknown, status = 200) => out instanceof WithHeaders
      ? new Response(JSON.stringify(out.body), { status: out.status, headers: { ...headers, ...out.extra } })
      : new Response(JSON.stringify(out), { status, headers });
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
      if (path === '/api/v1/auth/login' && request.method === 'POST') {
        const tokens = await auth.login(await readJson());
        // El pase de sesión única no debe impedir entrar: si falla su emisión, se entra sin él.
        const pass = await sso.issueFor(tokens).catch(() => null);
        return json(pass ? withHeaders(tokens, { 'Set-Cookie': passCookie(pass, origin) }) : tokens);
      }
      // Portales: canje del enlace personal por una sesión propia y el pase de sesión única (contrato §3.6).
      if (path === '/api/v1/auth/link' && request.method === 'POST') {
        const body = await readJson();
        const user = await resolvePortalLink(supabase, config.app, (body as any).token);
        const tokens = await sso.sessionFor(user);
        const pass = await sso.issueForUser(user).catch(() => null);
        return json(pass ? withHeaders(tokens, { 'Set-Cookie': passCookie(pass, origin) }) : tokens);
      }
      if (path === '/api/v1/auth/sso' && request.method === 'POST') {
        try {
          return json(await sso.login(passFrom(request)));
        } catch (error) {
          if (error instanceof Fault && error.code === 'NO_SSO') return json(withHeaders(error.toJSON(), { 'Set-Cookie': passCookie(null, origin) }, error.status));
          throw error;
        }
      }
      if (path === '/api/v1/auth/refresh' && request.method === 'POST') return json(await auth.refresh(await readJson()));
      // «¿Has olvidado tu contraseña?» (contrato §3.4): se enciende con IKISAI_PASSWORD_RECOVERY=1 cuando haya correo propio.
      const recoveryOn = config.passwordRecovery ?? ((globalThis as any).Deno?.env?.get?.('IKISAI_PASSWORD_RECOVERY') === '1');
      // permanentAccount: «Guarda tu acceso» de los portales (Google y código por correo), cuando haya Workspace.
      const permanentOn = (globalThis as any).Deno?.env?.get?.('IKISAI_PORTAL_ACCOUNTS') === '1';
      if (path === '/api/v1/auth/config' && request.method === 'GET') return json({ passwordRecovery: recoveryOn, permanentAccount: permanentOn });
      if (path === '/api/v1/auth/recover' && request.method === 'POST') {
        if (!recoveryOn) fail(503, 'RECOVERY_DISABLED', messageFor('RECOVERY_DISABLED'));
        // El correo vuelve a la propia app: https://<app>/?token_hash=…&type=recovery (plantilla de Auth).
        const target = origin && config.origins.includes(origin) ? origin : config.origins[0]!;
        return json(await auth.recover(await readJson(), target + '/'));
      }
      if (path === '/api/v1/auth/reset' && request.method === 'POST') {
        if (!recoveryOn) fail(503, 'RECOVERY_DISABLED', messageFor('RECOVERY_DISABLED'));
        const out = await auth.resetPassword(await readJson());
        await sso.revokeUser(out.userId).catch(() => undefined);
        const pass = await sso.issueForUser(out.userId).catch(() => null);
        const { userId: _ignored, ...tokens } = out;
        return json(pass ? withHeaders(tokens, { 'Set-Cookie': passCookie(pass, origin) }) : tokens);
      }
      // Rutas de sistema para workers (planificador externo): clave compartida en IKISAI_WORKER_KEY, sin sesión de usuario.
      if (path.startsWith('/api/v1/worker/')) {
        const provided = request.headers.get('x-ikisai-worker-key');
        if (!config.workerKey || !provided || !timingSafeEqual(provided, config.workerKey)) fail(401, 'UNAUTHENTICATED', 'Clave de worker inválida.');
        const relative = path.slice('/api/v1/worker/'.length);
        for (const route of compiledWorkers) {
          if (route.method !== request.method) continue;
          const params = route.matcher(relative);
          if (!params) continue;
          const result = await route.handler({ request, url, params, json: readJson, invoke: (name, args) => sync.invoke(null, name, args ?? {}), supabase });
          return result instanceof Response ? result : json(result);
        }
        // Sin ruta TypeScript: acción SQL registrada (`kind 'action'`) por su nombre `schema.fn`.
        if (request.method === 'POST' && /^[a-z_]+\.[a-z0-9_]+$/.test(relative)) return json(await sync.invoke(null, relative, await readJson()));
        fail(404, 'NOT_FOUND', 'Ruta de worker desconocida.');
      }
      if (!path.startsWith('/api/v1/')) fail(404, 'NOT_FOUND', 'Ruta desconocida.');
      const token = bearer(request);
      const user = await auth.identity(token);
      const ctx = await sync.context(user, token!);
      const relative = path.slice('/api/v1/'.length);
      // MCP (JSON-RPC 2.0 sobre HTTP): admite lotes, así que no pasa por readJson; las notificaciones responden 202 sin cuerpo.
      if (relative === 'mcp') {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > maxBody) fail(413, 'PAYLOAD_TOO_LARGE', messageFor('PAYLOAD_TOO_LARGE'));
        let message: unknown;
        try { message = JSON.parse(raw); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        const out = await mcp.handle(message, ctx, mcpCore(ctx));
        return out === null ? new Response(null, { status: 202, headers }) : json(out);
      }
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
