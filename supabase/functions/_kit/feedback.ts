/**
 * Feedback y QA transversal (contrato §3.7, coordinacion/ampliacion/FEEDBACK.md): rutas `feedback*` que el kit monta en
 * todas las apps y portales. La app de origen la da la propia Edge; el tipo de quien informa lo deduce el núcleo.
 * El contexto técnico pasa por una lista blanca aquí: nada de valores de formularios, cuerpos, cabeceras ni almacenamiento.
 */
import { fail, messageFor } from './errors.ts';
import { sha256Hex, type Supabase } from './supabase.ts';
import type { RequestContext } from './sync.ts';
import { createUploads } from './uploads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^FB_\d{4}_\d{3,}$/i;
const NODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){0,7}$/;
const SUBJECTS = ['application', 'event', 'space'];
const INTENTS = ['bug', 'improvement', 'idea', 'problem', 'suggestion'];
const STATUSES = ['open', 'pending_verify', 'verified', 'dismissed', 'all'];
const PORTALS = ['organizers', 'guests'];
export const FEEDBACK_LIMITS = { message: 4000, contextBytes: 8192, attachments: 3, imageBytes: 2 * 1024 * 1024, pathItems: 6, labelChars: 80 };

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

/** Ruta sin ids, números, consulta ni fragmento: `/reservas/3f2a…/huespedes?x` → `/reservas/:id/huespedes`. */
export function sanitizeRoute(route: unknown): string | undefined {
  if (typeof route !== 'string') return undefined;
  return route.split(/[?#]/)[0]!.split('/').map((part) => (/^[0-9a-f-]{8,}$/i.test(part) || /\d/.test(part) ? ':id' : part.slice(0, 40))).join('/').slice(0, 200);
}

/** Lista blanca del contexto técnico (FEEDBACK.md §2.11 y §8.5). Todo lo demás se descarta. */
export function cleanContext(raw: any): Record<string, unknown> {
  const c = raw && typeof raw === 'object' ? raw : {};
  const out: Record<string, unknown> = {
    release: str(c.release, 80), commit: str(c.commit, 40), serviceWorker: str(c.serviceWorker, 80), route: sanitizeRoute(c.route),
    deviceClass: ['mobile', 'tablet', 'desktop'].includes(c.deviceClass) ? c.deviceClass : undefined,
    viewport: c.viewport ? { width: num(c.viewport.width), height: num(c.viewport.height) } : undefined,
    online: typeof c.online === 'boolean' ? c.online : undefined,
    role: ['reader', 'editor', 'owner'].includes(c.role) ? c.role : undefined,
    userAgent: str(c.userAgent, 200), language: str(c.language, 20),
    sync: c.sync && typeof c.sync === 'object'
      ? { pending: num(c.sync.pending), conflicts: num(c.sync.conflicts), lastSyncAt: str(c.sync.lastSyncAt, 40), cursor: num(c.sync.cursor) }
      : undefined,
    errors: Array.isArray(c.errors) ? c.errors.slice(-5).map((e: any) => ({ type: str(e?.type, 40), message: str(e?.message, 200), at: str(e?.at, 40) })) : undefined,
    http: Array.isArray(c.http)
      ? c.http.slice(-5).map((h: any) => ({ method: str(h?.method, 10), path: sanitizeRoute(h?.path), status: num(h?.status), at: str(h?.at, 40) }))
      : undefined,
    steps: Array.isArray(c.steps)
      ? c.steps.slice(-10).map((s: any) => ({
          route: sanitizeRoute(s?.route), node: typeof s?.node === 'string' && NODE.test(s.node) ? s.node : undefined, action: str(s?.action, 20), at: str(s?.at, 40),
        }))
      : undefined,
  };
  const json = JSON.stringify(out);
  if (new TextEncoder().encode(json).length > FEEDBACK_LIMITS.contextBytes) {
    fail(422, 'FEEDBACK_CONTEXT_TOO_LARGE', messageFor('FEEDBACK_CONTEXT_TOO_LARGE'), { max: FEEDBACK_LIMITS.contextBytes });
  }
  return JSON.parse(json);
}

/** Bloque legible para pegar a un agente («Copiar para Claude», «Descargar .md», script local). */
export function agentBlock(detail: any): string {
  const r = detail.report;
  const c = detail.context ?? {};
  const path = Array.isArray(r.node?.path) && r.node.path.length ? ' · ' + r.node.path.join(' › ') : '';
  const lines = [
    '# ' + r.code + ' · ' + r.originApp + ' · ' + r.intent + (r.blocking ? ' · ME BLOQUEA' : ''),
    '',
    '- Estado: ' + r.display + (r.releasedBuild ? ' (publicado en ' + r.releasedBuild + ')' : ''),
    '- Elemento: ' + (r.node?.id ?? '(sin nodo)') + path,
    '- Versión: ' + (c.release ?? '?') + (c.commit ? ' (' + c.commit + ')' : '') + ' · ruta ' + (detail.sourceRoute ?? c.route ?? '?'),
    '- Dispositivo: ' + (c.deviceClass ?? '?') + ' ' + (c.viewport?.width ?? '?') + '×' + (c.viewport?.height ?? '?') + ' · ' + (c.online === false ? 'sin red' : 'en línea')
      + (c.sync ? ' · pendientes ' + (c.sync.pending ?? 0) + ', conflictos ' + (c.sync.conflicts ?? 0) : ''),
    '- Busca en el repo: ' + (r.node?.id ?? r.originApp),
    '',
    '## Lo que dice',
    '',
    r.message,
  ];
  if (Array.isArray(c.steps) && c.steps.length) lines.push('', '## Últimos pasos', '', ...c.steps.map((s: any) => '1. ' + (s.action ?? 'tocó') + ' ' + (s.node ?? '') + ' (' + (s.route ?? '') + ')'));
  if (Array.isArray(c.errors) && c.errors.length) lines.push('', '## Errores recientes', '', ...c.errors.map((e: any) => '- ' + e.type + ': ' + e.message));
  if (Array.isArray(c.http) && c.http.length) lines.push('', '## Fallos HTTP recientes', '', ...c.http.map((h: any) => '- ' + h.method + ' ' + h.path + ' → ' + h.status));
  if (detail.attachments?.length) lines.push('', '## Imágenes: ' + detail.attachments.length + ' (en la app)');
  lines.push('', 'Al arreglarlo, pon ' + r.code + ' en el título o la descripción del PR: al publicarse, el reporte pasa a «pendiente de verificar».');
  return lines.join('\n');
}

export function createFeedback(supabase: Supabase, app: string) {
  const uploads = createUploads(supabase, app, {
    bucket: 'feedback-media', maxBytes: FEEDBACK_LIMITS.imageBytes, allowedMime: ['image/webp', 'image/jpeg', 'image/png'], allowReaders: true,
  });

  function human(ctx: RequestContext) {
    if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
  }

  async function create(ctx: RequestContext, body: any) {
    human(ctx);
    if (typeof body?.id !== 'string' || !UUID.test(body.id)) fail(422, 'INVALID_OPERATION', 'id inválido.');
    if (typeof body?.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
    if (!SUBJECTS.includes(body.subject)) fail(422, 'INVALID_OPERATION', 'Asunto inválido.');
    if (!INTENTS.includes(body.intent)) fail(422, 'INVALID_OPERATION', 'Tipo inválido.');
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) fail(422, 'INVALID_OPERATION', 'Escribe un comentario.');
    if (message.length > FEEDBACK_LIMITS.message) fail(422, 'FEEDBACK_MESSAGE_TOO_LONG', messageFor('FEEDBACK_MESSAGE_TOO_LONG'), { max: FEEDBACK_LIMITS.message });
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds : [];
    if (attachmentIds.length > FEEDBACK_LIMITS.attachments) {
      fail(422, 'FEEDBACK_TOO_MANY_ATTACHMENTS', messageFor('FEEDBACK_TOO_MANY_ATTACHMENTS'), { max: FEEDBACK_LIMITS.attachments });
    }
    if (!attachmentIds.every((id: unknown) => typeof id === 'string' && UUID.test(id))) fail(422, 'FEEDBACK_ATTACHMENT_INVALID', messageFor('FEEDBACK_ATTACHMENT_INVALID'));
    const nodeId = typeof body.node?.id === 'string' && body.node.id ? body.node.id : null;
    if (nodeId && !NODE.test(nodeId)) fail(422, 'INVALID_OPERATION', 'Nodo inválido.');
    const path = Array.isArray(body.node?.path)
      ? body.node.path.slice(0, FEEDBACK_LIMITS.pathItems).map((p: unknown) => String(p).slice(0, FEEDBACK_LIMITS.labelChars))
      : [];
    const meta = body.node?.meta && typeof body.node.meta === 'object' ? { kind: str(body.node.meta.kind, 20), icon: str(body.node.meta.icon, 30) } : {};
    const context = cleanContext(body.context);
    const report = {
      id: body.id.toLowerCase(), subject: body.subject, intent: body.intent, blocking: body.blocking === true, message,
      node: { id: nodeId, path, meta }, scope: body.scope && typeof body.scope === 'object' && !Array.isArray(body.scope) ? body.scope : {},
      category: str(body.category, 40) ?? null, context, sourceRoute: (context.route as string | undefined) ?? null,
      attachmentIds: attachmentIds.map((id: string) => id.toLowerCase()),
    };
    // La huella cubre lo que el usuario escribió, no el contexto (puede variar entre reintentos sin red).
    const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify({ ...report, context: undefined, sourceRoute: undefined })));
    return { report: await supabase.rpc('core_feedback_create', { p_app: app, p_actor: ctx.user.id, p_report: { ...report, requestId: body.requestId }, p_digest: digest }) };
  }

  async function list(ctx: RequestContext, params: URLSearchParams) {
    const status = params.get('status') ?? 'open';
    if (!STATUSES.includes(status)) fail(422, 'INVALID_FILTER', 'status inválido.');
    const node = params.get('node');
    if (node && !NODE.test(node)) fail(422, 'INVALID_FILTER', 'node inválido.');
    const requestedApp = params.get('app');
    if (requestedApp && !/^[a-z][a-z0-9_]{1,30}$/.test(requestedApp)) fail(422, 'INVALID_FILTER', 'app inválida.');
    const filters = {
      app: requestedApp ?? app, node: node ?? undefined, status, mine: params.get('mine') === 'true' || undefined,
      pin: params.get('pin') === 'true' || undefined, limit: Number(params.get('limit') ?? 100) || 100,
    };
    return { items: await supabase.rpc('core_feedback_list', { p_app: app, p_actor: ctx.user.id, p_filters: filters }) };
  }

  async function tree(ctx: RequestContext, params: URLSearchParams) {
    const requestedApp = params.get('app') ?? app;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(requestedApp)) fail(422, 'INVALID_FILTER', 'app inválida.');
    return { nodes: await supabase.rpc('core_feedback_tree', { p_app: requestedApp, p_actor: ctx.user.id }) };
  }

  async function get(ctx: RequestContext, idOrCode: string) {
    let detail: any = null;
    if (UUID.test(idOrCode)) detail = await supabase.rpc('core_feedback_get', { p_actor: ctx.user.id, p_id: idOrCode });
    else if (CODE.test(idOrCode)) detail = await supabase.rpc('core_feedback_get_by_code', { p_actor: ctx.user.id, p_code: idOrCode });
    else fail(404, 'OUT_OF_SCOPE', messageFor('OUT_OF_SCOPE'));
    const attachments = [];
    for (const a of detail.attachments ?? []) {
      const signed = await supabase.remote('/storage/v1/object/sign/' + a.bucket + '/' + String(a.path).split('/').map(encodeURIComponent).join('/'), {
        service: true, method: 'POST', body: { expiresIn: 600 },
      });
      attachments.push({ id: a.id, mime: a.mime, url: typeof signed?.signedURL === 'string' ? supabase.base + '/storage/v1' + signed.signedURL : null });
    }
    // Un portal ve su reporte, no el diagnóstico técnico ni las tareas internas.
    if (PORTALS.includes(app)) return { report: detail.report, attachments, tasks: [] };
    return { report: detail.report, attachments, tasks: detail.tasks, sourceRoute: detail.sourceRoute, context: detail.context, agentBlock: agentBlock({ ...detail, attachments }) };
  }

  async function act(ctx: RequestContext, id: string, action: 'support' | 'verify' | 'reopen' | 'dismiss', body: any) {
    human(ctx);
    if (!UUID.test(id)) fail(404, 'OUT_OF_SCOPE', messageFor('OUT_OF_SCOPE'));
    const args = { build: str(body?.build, 80), message: str(body?.message, 1000), reason: str(body?.reason, 500) };
    return { report: await supabase.rpc('core_feedback_act', { p_actor: ctx.user.id, p_id: id, p_action: action, p_args: args }) };
  }

  return { uploads, create, list, tree, get, act };
}

// ---------------------------------------------------------------------------
// Worker (lo monta central-api con `feedbackWorker: true`; pg_cron lo despierta solo si hay trabajo)
// ---------------------------------------------------------------------------

const SPACE_KINDS = ['damage', 'cleaning', 'missing', 'utilities', 'safety', 'other'];
const EVENT_KINDS = ['setup', 'accommodation', 'cleaning', 'food', 'technical', 'operation', 'other'];
const KIND_LABELS: Record<string, string> = {
  damage: 'Avería', cleaning: 'Limpieza', missing: 'Falta algo', utilities: 'Agua o electricidad', safety: 'Seguridad', other: 'Otra cosa',
  setup: 'Montaje', accommodation: 'Alojamiento', food: 'Cocina', technical: 'Técnico', operation: 'Horarios y operación',
};
const WHO: Record<string, string> = { guest: 'Reporte de huésped', organizer: 'Petición del organizador', internal: 'Reporte del equipo' };

/** Petición a Tasks para un reporte operativo (FEEDBACK.md §4): dice qué es, no dónde va; sin datos personales añadidos. */
export function taskRequestFor(item: any) {
  const space = item.subject === 'space';
  const category = (space ? SPACE_KINDS : EVENT_KINDS).includes(item.category) ? item.category : 'other';
  const message = String(item.message ?? '').replace(/\s+/g, ' ').trim();
  return {
    source: 'feedback',
    kind: (space ? 'feedback.space.' : 'feedback.event.') + category,
    kind_label: (space ? 'Espacio · ' : 'Retiro · ') + KIND_LABELS[category],
    external_ref: item.externalRef,
    title: (message.length > 100 ? message.slice(0, 99) + '…' : message) || (space ? 'Incidencia en el espacio' : 'Petición del retiro'),
    note: (WHO[item.reporterKind] ?? 'Reporte') + ' · ' + item.code + (item.blocking ? ' · urgente' : '') + '\n\n' + message.slice(0, 800),
    external_url: 'https://tasks.ikisai.com/#/feedback/' + item.code,
    on_behalf_of: { kind: item.reporterKind, report_code: item.code },
  };
}

export function createFeedbackWorker(supabase: Supabase, options: { workerKey?: string; fetch?: typeof fetch }) {
  const transport = options.fetch ?? fetch;
  const tasksWorker = (route: string, body: unknown) => transport(supabase.base + '/functions/v1/tasks-api/api/v1/worker/' + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': options.workerKey ?? '' }, body: JSON.stringify(body),
  });

  /** Cuenta de servicio «Feedback (sistema)»: la crea en Auth la primera vez, sin contraseña utilizable, y la registra. */
  async function ensureServiceActor(): Promise<string> {
    const existing = await supabase.rpc<string | null>('core_service_actor', { p_name: 'feedback' });
    if (existing) return existing;
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    const user = await supabase.remote('/auth/v1/admin/users', {
      service: true, method: 'POST',
      body: { email: 'svc-feedback-' + crypto.randomUUID().slice(0, 8) + '@sistema.ikisai.com', password: btoa(String.fromCharCode(...bytes)), email_confirm: true, user_metadata: { service: 'feedback' } },
    });
    if (typeof user?.id !== 'string') fail(502, 'AUTH_ADMIN_FAILED', messageFor('AUTH_ADMIN_FAILED'));
    return supabase.rpc<string>('core_register_service_actor', { p_user: user.id, p_name: 'feedback' });
  }

  async function tick() {
    const out = { routed: 0, errors: 0, statusUpdates: 0 };
    const claims = await supabase.rpc<any[]>('core_feedback_routing_claim', { p_limit: 20 });
    if (claims.length) await ensureServiceActor();
    for (const item of claims) {
      try {
        const res = await tasksWorker('requests/task', taskRequestFor(item));
        const data = await res.json().catch(() => null);
        if (!res.ok || typeof data?.taskId !== 'string') throw new Error('tasks_' + res.status + (data?.error?.code ? '_' + data.error.code : ''));
        await supabase.rpc('core_feedback_routing_result', { p_external_ref: item.externalRef, p_task_id: data.taskId, p_error: null });
        out.routed++;
      } catch (error) {
        await supabase.rpc('core_feedback_routing_result', { p_external_ref: item.externalRef, p_task_id: null, p_error: String((error as Error)?.message ?? error).slice(0, 200) });
        out.errors++;
      }
    }
    const refs = await supabase.rpc<string[]>('core_feedback_open_task_refs', { p_limit: 200 });
    if (refs.length) {
      const res = await tasksWorker('requests/status', { externalRefs: refs });
      const data = await res.json().catch(() => null);
      if (res.ok && Array.isArray(data?.items)) {
        out.statusUpdates = await supabase.rpc<number>('core_feedback_task_status', {
          p_updates: data.items.filter((i: any) => typeof i?.externalRef === 'string' && typeof i?.status === 'string').map((i: any) => ({ externalRef: i.externalRef, status: i.status })),
        });
      }
    }
    return out;
  }

  return { tick, ensureServiceActor };
}
