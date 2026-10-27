/** Handler HTTP común: CORS por dominio, autenticación, rutas del núcleo y rutas propias de la app. */
import { Fault, fail, messageFor } from './errors.ts';
import { createSupabase, type SupabaseConfig } from './supabase.ts';
import { createAuth } from './auth.ts';
import { createSync, integer, type AppHooks, type RequestContext } from './sync.ts';
import { createUploads, type UploadsConfig } from './uploads.ts';
import { createSuggestions } from './suggestions.ts';
import { createAgents } from './agents.ts';
import { createMcp, type McpCore, type McpTool } from './mcp.ts';
import { createSso, passCookie, passFrom } from './sso.ts';
import { createAdmin } from './admin.ts';
import { createFeedback, createFeedbackWorker } from './feedback.ts';
import { createUsage } from './usage.ts';
import { createFilesGc } from './files-gc.ts';
import { createStorage, r2ConfigFromEnv, type ProviderName, type R2Config } from './storage.ts';
import { applyPublicOperations, type PublicOperation } from './public-write.ts';
import { isPublicOrigin, issueVisitor, publicReadWithVisitor, resolveVisitor, type Visitor } from './visitors.ts';
import { claimVisitor, clientIp, createVisitorHandoff, forgetVisitorEmail, linkVisitorToGuest, logoutVisitor, redeemVisitorHandoff, requestVisitorEmail, unlinkVisitorFromGuest, verifyVisitorEmail, visitorAsMember, visitorMe, visitorVisit } from './visitors-v2.ts';
import { createPortalLinks, resolvePortalLink, PORTAL_DOMAINS, portalUserFor } from './portal.ts';
import { createCapabilities, type CapabilitiesOptions } from './capabilities.ts';

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
  /** Entrada con código por correo de los portales (0108); si no se indica, IKISAI_EMAIL_CODE=1. */
  emailCode?: boolean;
  /** Almacenamiento: R2 y proveedor por defecto. Sin indicarlo, se lee de los secretos R2_* e IKISAI_STORAGE_PROVIDER. */
  storage?: { r2?: R2Config | null; defaultProvider?: ProviderName };
  /** Solo central-api: worker del feedback (`worker/feedback/tick`), que envía a Tasks lo operativo y copia el estado de las tareas. */
  feedbackWorker?: boolean;
  /** Booking y Organizers: montan `portal-links` para emitir y gestionar enlaces de los portales (contrato §3.6). */
  portalIssuer?: boolean;
  /**
   * Rutas públicas propias (C11): `/api/v1/public/<pattern>`, sin sesión, con el visitante de `X-Visitor` resuelto y la
   * escritura pública de la propia app a mano (`apply`). Van antes de la lectura pública genérica `GET public/<nombre>`.
   */
  publicRoutes?: PublicRoute[];
  /** Catálogo de capacidades (0097): transporte y bases de API de las apps dueñas (pruebas). */
  capabilities?: CapabilitiesOptions;
}

export interface PublicRequest {
  request: Request;
  url: URL;
  params: Record<string, string>;
  json(): Promise<any>;
  /** El visitante de la cabecera `X-Visitor`, o null si no la trae (la ruta decide si lo exige con VISITOR_REQUIRED). */
  visitor: Visitor | null;
  /** Lote público de la propia app (tablas de core.allow_public_write), firmado por el visitante si lo hay. */
  apply(operations: PublicOperation[]): Promise<{ cursor: number; results: unknown[] }>;
  /** Lectura pública registrada (core.allow_public_read), con el visitor_id del visitante si lo hay. */
  read(name: string, args?: Record<string, unknown>): Promise<unknown>;
  supabase: ReturnType<typeof createSupabase>;
}

export interface PublicRoute {
  method: string;
  /** Patrón relativo a `/api/v1/public/`, por ejemplo `join`. */
  pattern: string;
  handler: (req: PublicRequest) => Promise<unknown | Response>;
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

/** Módulos del núcleo que sirve cada Edge en `/api/v1/<módulo>/` (core.apps con kind 'module'). */
export const MODULES = ['resources'] as const;

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
  /** 0118: origen de un lote de /commands. 'server' solo con la clave de worker correcta y X-Ikisai-Caller (otra Edge con identidad de servicio). */
  const batchOrigin = (request: Request | undefined): 'server' | 'browser' => {
    const key = request?.headers.get('x-ikisai-worker-key') ?? '';
    const caller = request?.headers.get('x-ikisai-caller') ?? '';
    return config.workerKey && key && caller && timingSafeEqual(key, config.workerKey) ? 'server' : 'browser';
  };
  const sync = createSync(supabase, config.app, config.hooks ?? {});
  const env = (name: string) => (globalThis as any).Deno?.env?.get?.(name) as string | undefined;
  const storage = createStorage(supabase, {
    r2: config.storage?.r2 !== undefined ? config.storage.r2 : r2ConfigFromEnv(env),
    defaultProvider: config.storage?.defaultProvider ?? (env('IKISAI_STORAGE_PROVIDER') === 'r2' ? 'r2' : 'supabase'),
    fetch: config.fetch,
  });
  const uploads = config.uploads ? createUploads(supabase, config.app, config.uploads, storage, config.hooks?.visible) : null;
  const agents = createAgents(supabase, config.app, config.hooks ?? {}, sync.validateOperations);
  const suggestions = createSuggestions(supabase, config.app, sync.validateOperations, config.hooks ?? {});
  const sso = createSso(supabase, config.app);
  const mcp = createMcp(config.app, config.release ?? 'development', config.mcpTools ?? []);
  const capabilities = createCapabilities(supabase, config.app, config.capabilities ?? {});
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
    { method: 'POST', pattern: 'commands', handler: async ({ ctx, json, request }) => sync.commit(ctx, await json(), { origin: batchOrigin(request) }) },
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
    // Catálogo de capacidades (0097): lo que esta persona puede invocar en otras apps, la invocación con su token y sus recibos.
    { method: 'GET', pattern: 'capabilities', handler: ({ ctx }) => capabilities.list(ctx) },
    { method: 'GET', pattern: 'capabilities/receipts', handler: ({ ctx, url }) => capabilities.receipts(ctx, url.searchParams) },
    { method: 'POST', pattern: 'capabilities/:id/invoke', handler: async ({ ctx, params, json }) => capabilities.invoke(ctx, params.id ?? '', (await json()) as Record<string, unknown>) },
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
    // Sugerencias de personas (RECURSOS.md §14.1): staff o dirección aprueba o descarta; aprobar aplica el lote.
    { method: 'GET', pattern: 'suggestions', handler: ({ ctx, url }) => suggestions.list(ctx, url.searchParams) },
    { method: 'POST', pattern: 'suggestions', handler: async ({ ctx, json }) => suggestions.create(ctx, await json()) },
    { method: 'POST', pattern: 'suggestions/:id/preview', handler: async ({ ctx, params, json }) => suggestions.preview(ctx, params.id ?? '', await json()) },
    { method: 'POST', pattern: 'suggestions/:id/approve', handler: async ({ ctx, params, json }) => suggestions.decide(ctx, params.id ?? '', 'approve', await json()) },
    { method: 'POST', pattern: 'suggestions/:id/reject', handler: async ({ ctx, params, json }) => suggestions.decide(ctx, params.id ?? '', 'reject', await json()) },
    { method: 'POST', pattern: 'suggestions/:id/withdraw', handler: async ({ ctx, params, json }) => suggestions.withdraw(ctx, params.id ?? '', await json()) },
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
    { method: 'GET', pattern: 'usage/inventory', handler: ({ ctx, url }) => usage.inventory(ctx, url.searchParams) },
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
      { method: 'POST', pattern: 'admin/accounts/:userId/name', handler: async ({ ctx, params, json }) => admin.setDisplayName(ctx, params.userId ?? '', await json()) },
    );
  }
  // C11 v2: el huésped, con su sesión en el portal, une o separa el móvil de visitante (X-Visitor) de su ficha.
  routes.push(
    { method: 'POST', pattern: 'visitor-link', handler: async ({ ctx, request, json }) => linkVisitorToGuest(supabase, ctx, request, await json()) },
    { method: 'DELETE', pattern: 'visitor-link/:guestId', handler: ({ ctx, params }) => unlinkVisitorFromGuest(supabase, ctx, params.guestId ?? '') },
  );
  if (config.portalIssuer) {
    const links = createPortalLinks(supabase, config.app);
    routes.push(
      { method: 'POST', pattern: 'portal-links', handler: async ({ ctx, json }) => links.issue(ctx, await json()) },
      { method: 'GET', pattern: 'portal-links', handler: ({ ctx, url }) => links.list(ctx, url.searchParams) },
      { method: 'POST', pattern: 'portal-links/:id/revoke', handler: ({ ctx, params }) => links.manage(ctx, params.id ?? '', 'revoke', {}) },
      { method: 'POST', pattern: 'portal-links/:id/extend', handler: async ({ ctx, params, json }) => links.manage(ctx, params.id ?? '', 'extend', await json()) },
    );
  }
  // C8: archivo de otra app publicado a este portal (resolutores de `core.allow_portal_file`); URL firmada de 5 minutos.
  routes.push({ method: 'GET', pattern: 'portal-files/:fileId', handler: async ({ ctx, params }) => {
    const id = params.fileId ?? '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) fail(404, 'FILE_NOT_FOUND', messageFor('FILE_NOT_FOUND'));
    const file = await supabase.rpc<any>('core_portal_file_get', { p_portal: config.app, p_actor: ctx.user.id, p_file: id });
    const url = await storage.readUrl(file, 300);
    return { id, url, expiresAt: new Date(Date.now() + 300_000).toISOString(), filename: file.filename, mime: file.mime, size: file.size };
  } });
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
  const compiledPublic = (config.publicRoutes ?? []).map((route) => ({ ...route, matcher: compile(route.pattern) }));
  // Módulos del núcleo sin app propia (`resources`: espacios e inventario, RECURSOS.md §3): cada Edge los sirve en
  // `/api/v1/<módulo>/…` con su propia sincronización. La pertenencia la deriva el núcleo de las apps de origen.
  const modules = new Map<string, { sync: ReturnType<typeof createSync>; routes: Array<{ method: string; pattern: string; handler: (req: RouteRequest) => Promise<unknown>; matcher: (path: string) => Record<string, string> | null }> }>(MODULES.map((name) => {
    const moduleSync = createSync(supabase, name, {});
    // Recursos: los dibujos del mapa de zonas (resources.floor_plans), solo imágenes; los sube el owner (escritura de la tabla).
    const moduleUploads = name === 'resources'
      ? createUploads(supabase, name, { bucket: 'resources-plans', maxBytes: 10 * 1024 * 1024, allowedMime: ['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'] }, storage)
      : null;
    const moduleRoutes: Array<{ method: string; pattern: string; handler: (req: RouteRequest) => Promise<unknown> }> = [
      ...(moduleUploads ? [
        { method: 'POST', pattern: 'uploads', handler: async ({ ctx, json }: RouteRequest) => moduleUploads.create(ctx, await json()) },
        { method: 'POST', pattern: 'uploads/:id/verify', handler: ({ ctx, params }: RouteRequest) => moduleUploads.verify(ctx, params.id ?? '') },
        { method: 'GET', pattern: 'files/:id', handler: ({ ctx, params }: RouteRequest) => moduleUploads.readUrl(ctx, params.id ?? '') },
      ] : []),
      { method: 'GET', pattern: 'bootstrap', handler: async ({ ctx }) => ({ ...ctx.bootstrap, release: config.release ?? 'development' }) },
      { method: 'GET', pattern: 'snapshot', handler: ({ ctx, url }) => moduleSync.snapshot(ctx, url.searchParams) },
      { method: 'GET', pattern: 'changes', handler: ({ ctx, url }) => moduleSync.changes(ctx, url.searchParams) },
      { method: 'POST', pattern: 'commands', handler: async ({ ctx, json, request }) => moduleSync.commit(ctx, await json(), { origin: batchOrigin(request) }) },
      { method: 'GET', pattern: 'history', handler: ({ ctx, url }) => moduleSync.history(ctx, url.searchParams) },
      { method: 'POST', pattern: 'history/:cursor/undo-plan', handler: ({ ctx, params }) => moduleSync.undoPlan(ctx, integer(params.cursor ?? null, 0)) },
      { method: 'POST', pattern: 'history/:cursor/undo', handler: async ({ ctx, params, json }) => moduleSync.undo(ctx, integer(params.cursor ?? null, 0), await json()) },
      { method: 'POST', pattern: 'trash/purge', handler: async ({ ctx, json }) => moduleSync.purgeDeleted(ctx, await json()) },
      { method: 'GET', pattern: 'read/:name', handler: ({ ctx, params, url }) => moduleSync.read(ctx, params.name ?? '', readArgs(url.searchParams)) },
      { method: 'POST', pattern: 'read/:name', handler: async ({ ctx, params, json }) => moduleSync.read(ctx, params.name ?? '', await json()) },
      { method: 'POST', pattern: 'invoke/:name', handler: async ({ ctx, params, json }) => { if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN')); return moduleSync.invoke(ctx.user.id, params.name ?? '', await json()); } },
    ];
    return [name, { sync: moduleSync, routes: moduleRoutes.map((route) => ({ ...route, matcher: compile(route.pattern) })) }] as const;
  }));

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    // Las rutas `public/*` (lecturas y escrituras públicas, visitantes) las pide cualquier portal del proyecto, no solo la propia app.
    const isPublicPath = /\/api\/v1\/public\//.test(new URL(request.url).pathname.replace(prefix, ''));
    const originOk = !!origin && (origins.has(origin) || (isPublicPath && isPublicOrigin(origin)));
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-visitor',
    };
    if (originOk) headers['Access-Control-Allow-Origin'] = origin!;
    const json = (out: unknown, status = 200) => out instanceof WithHeaders
      ? new Response(JSON.stringify(out.body), { status: out.status, headers: { ...headers, ...out.extra } })
      : new Response(JSON.stringify(out), { status, headers });
    try {
      if (origin && !originOk) fail(403, 'ORIGIN_REJECTED', messageFor('ORIGIN_REJECTED'));
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
        const { userId: user, grant } = await resolvePortalLink(supabase, config.app, (body as any).token);
        // `grant`: el ámbito del enlace, para entrar por él cuando la cuenta tiene varios (C10 de Guests).
        const tokens = { ...(await sso.sessionFor(user)), grant };
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
      if (path === '/api/v1/auth/refresh' && request.method === 'POST') {
        const refreshed = await auth.refresh(await readJson());
        await sso.touch(passFrom(request));
        return json(refreshed);
      }
      // «¿Has olvidado tu contraseña?» (contrato §3.4): se enciende con IKISAI_PASSWORD_RECOVERY=1 cuando haya correo propio.
      const recoveryOn = config.passwordRecovery ?? ((globalThis as any).Deno?.env?.get?.('IKISAI_PASSWORD_RECOVERY') === '1');
      // permanentAccount: «Guarda tu acceso» de los portales (Google y código por correo), cuando haya Workspace.
      const permanentOn = (globalThis as any).Deno?.env?.get?.('IKISAI_PORTAL_ACCOUNTS') === '1';
      // Código por correo (0108, decisión de VG del 27-10-2026): se enciende por app con `emailCode` o con IKISAI_EMAIL_CODE=1
      // cuando Auth tenga el correo propio (el SMTP por defecto de Supabase manda muy pocos y solo al equipo del proyecto).
      const emailCodeOn = config.emailCode ?? ((globalThis as any).Deno?.env?.get?.('IKISAI_EMAIL_CODE') === '1');
      if (path === '/api/v1/auth/config' && request.method === 'GET') return json({ passwordRecovery: recoveryOn, permanentAccount: permanentOn, emailCode: emailCodeOn });
      if (path === '/api/v1/auth/email-code' && request.method === 'POST') {
        if (!emailCodeOn) fail(503, 'EMAIL_CODE_DISABLED', messageFor('EMAIL_CODE_DISABLED'));
        return json(await auth.sendEmailCode(config.app, await readJson(), clientIp(request)));
      }
      if (path === '/api/v1/auth/email-code/verify' && request.method === 'POST') {
        if (!emailCodeOn) fail(503, 'EMAIL_CODE_DISABLED', messageFor('EMAIL_CODE_DISABLED'));
        const { userId, ...tokens } = await auth.verifyEmailCode(config.app, await readJson(), clientIp(request));
        const pass = await sso.issueForUser(userId).catch(() => null);
        return json(pass ? withHeaders(tokens, { 'Set-Cookie': passCookie(pass, origin) }) : tokens);
      }
      // Contacto público (portales, C1): sin sesión, para las pantallas de enlace no válido o caducado. Los textos de tipo
      // `contacto` de Central («Textos y contacto», editables por el owner), registrados como lectura pública `contact`
      // (core.allow_public_read); cacheable 5 minutos. Sin datos personales.
      if (path === '/api/v1/public/contact' && request.method === 'GET') {
        const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'es';
        // Público del contacto (cada uno con su correo, editable en Central): por defecto, el del propio portal.
        const AUDIENCES = ['organizers', 'guests', 'staff', 'suppliers'];
        const asked = url.searchParams.get('audience') ?? '';
        const audience = AUDIENCES.includes(asked) ? asked : (AUDIENCES.includes(config.app) ? config.app : 'organizers');
        const items = await supabase.rpc<unknown[] | null>('core_public_read', { p_name: 'contact', p_args: { lang, audience } });
        return json(withHeaders({ lang, audience, items: Array.isArray(items) ? items : [] }, { 'Cache-Control': 'public, max-age=300' }));
      }
      // Visitantes (C11): alta sin datos; el token solo se enseña aquí y viaja luego en `X-Visitor`.
      if (path === '/api/v1/public/visitor' && request.method === 'POST') {
        const body = await readJson() as { eventCode?: unknown; event_code?: unknown };
        const code = body.eventCode ?? body.event_code;
        return json(await issueVisitor(supabase, typeof code === 'string' ? code : null, clientIp(request)));
      }
      // Visitantes v2 (C11 v2, 0106): varios móviles, correo optativo y reclamación de la ficha del huésped.
      if (path === '/api/v1/public/visitor/logout' && request.method === 'POST') return json(await logoutVisitor(supabase, request));
      if (path === '/api/v1/public/visitor/email' && request.method === 'POST') return json(await requestVisitorEmail(supabase, request, await readJson()));
      if (path === '/api/v1/public/visitor/email/verify' && request.method === 'POST') return json(await verifyVisitorEmail(supabase, request, await readJson()));
      if (path === '/api/v1/public/visitor/email/forget' && request.method === 'POST') return json(await forgetVisitorEmail(supabase, request));
      if (path === '/api/v1/public/visitor/me' && request.method === 'GET') return json(await visitorMe(supabase, request));
      // 0115: un miembro con sesión ata su visitante (dirección y staff en ven.ikisai.com con su identidad).
      if (path === '/api/v1/public/visitor/as-member' && request.method === 'POST') return json(await visitorAsMember(supabase, request, (t) => auth.identity(t)));
      if (path === '/api/v1/public/visitor/visit' && request.method === 'POST') return json(await visitorVisit(supabase, request, await readJson()));
      if (path === '/api/v1/public/visitor/handoff' && request.method === 'POST') return json(await createVisitorHandoff(supabase, request));
      if (path === '/api/v1/public/visitor/handoff/redeem' && request.method === 'POST') return json(await redeemVisitorHandoff(supabase, request, await readJson()));
      if (path === '/api/v1/public/visitor/claim' && request.method === 'POST') {
        return json(await claimVisitor(supabase, request, await readJson(), PORTAL_DOMAINS.guests!, (person, app, scope) => portalUserFor(supabase, person, app, scope)));
      }
      if (path.startsWith('/api/v1/public/')) {
        const relative = path.slice('/api/v1/public/'.length);
        const visitor = await resolveVisitor(supabase, request);
        const read = (name: string, args: Record<string, unknown> = {}) => publicReadWithVisitor(supabase, name, args, visitor);
        for (const route of compiledPublic) {
          if (route.method !== request.method) continue;
          const params = route.matcher(relative);
          if (!params) continue;
          const result = await route.handler({ request, url, params, json: readJson, visitor, supabase, read,
            apply: (operations) => applyPublicOperations(supabase, config.app, operations, visitor?.id ?? null) });
          return result instanceof Response ? result : json(result);
        }
        // Lectura pública expuesta al navegador (core.allow_public_read(nombre, fn, true)), por su nombre y con los parámetros
        // de la consulta como args. El dato es público por decisión de la app dueña, así que la sirve cualquier Edge; con
        // visitante, sin caché. Las lecturas no expuestas (las que piden las Edges con argumentos propios) dan 404.
        if (request.method === 'GET' && /^[a-z][a-z_]{1,40}$/.test(relative)) {
          const out = await publicReadWithVisitor(supabase, relative, Object.fromEntries(url.searchParams), visitor, { fromClient: true });
          return json(visitor ? out : withHeaders(out, { 'Cache-Control': 'public, max-age=30' }));
        }
        fail(404, 'NOT_FOUND', 'Ruta pública desconocida.');
      }
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
      const relative = path.slice('/api/v1/'.length);
      const moduleName = relative.split('/', 1)[0]!;
      const mounted = modules.get(moduleName);
      if (mounted) {
        const moduleCtx = await mounted.sync.context(user, token!);
        const rest = relative.slice(moduleName.length + 1);
        const moduleGrants = (moduleCtx.membership as any)?.scopes?.grants;
        if (request.method !== 'GET' && Array.isArray(moduleGrants) && moduleGrants.length && moduleGrants.every((g: any) => g?.preview === true)
            && !rest.startsWith('read/')) {
          fail(403, 'PREVIEW_READ_ONLY', 'Es una vista previa: no se guardan cambios.');
        }
        for (const route of mounted.routes) {
          if (route.method !== request.method) continue;
          const params = route.matcher(rest);
          if (!params) continue;
          return json(await route.handler({ request, url, path, method: request.method, params, ctx: moduleCtx, json: readJson }));
        }
        fail(404, 'NOT_FOUND', 'Ruta desconocida.');
      }
      const ctx = await sync.context(user, token!);
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
      // Vista previa (O6): una sesión cuyas entradas de ámbito son todas `preview` solo lee.
      const grants = (ctx.membership as any)?.scopes?.grants;
      if (request.method !== 'GET' && Array.isArray(grants) && grants.length && grants.every((g: any) => g?.preview === true)
          && !relative.startsWith('read/') && relative !== 'auth/logout') {
        fail(403, 'PREVIEW_READ_ONLY', 'Es una vista previa: no se guardan cambios.');
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
