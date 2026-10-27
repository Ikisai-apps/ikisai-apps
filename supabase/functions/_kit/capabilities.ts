/**
 * Catálogo de capacidades (migración 0097; Visión V0.2 de Flow §3.5): lo que una app dueña publica para que otra lo ofrezca
 * e invoque con los permisos reales de la persona. Toda Edge sirve `GET capabilities` (las que esta persona puede usar) y
 * `POST capabilities/:id/invoke` (la Edge llama a la API del dueño con el token de la persona y deja un recibo).
 * Nunca hay superusuario: si la persona no es miembro del dueño con rol suficiente, NEEDS_ACCESS.
 */
import { Fault, fail, messageFor } from './errors.ts';
import type { Supabase } from './supabase.ts';
import type { RequestContext } from './sync.ts';

export interface CapabilityCheck { id: string; app: string; domain: string | null; route: string; kind: string; risk: string; idempotent: boolean; version: number }

export interface CapabilitiesOptions {
  /** Transporte hacia la API del dueño (pruebas); por defecto, fetch. */
  fetch?: typeof fetch;
  /** Base de la API de cada app dueña; por defecto `https://<dominio de core.apps>`, o IKISAI_API_BASE_<APP>. */
  apiBaseOf?: (app: string, domain: string | null) => string | null;
}

export function createCapabilities(supabase: Supabase, callerApp: string, options: CapabilitiesOptions = {}) {
  const transport = options.fetch ?? fetch;
  const env = (name: string) => (globalThis as any).Deno?.env?.get?.(name) as string | undefined;
  const apiBaseOf = options.apiBaseOf ?? ((app: string, domain: string | null) => env('IKISAI_API_BASE_' + app.toUpperCase()) ?? (domain ? 'https://' + domain : null));

  async function list(ctx: RequestContext) {
    const items = await supabase.rpc<unknown[] | null>('core_capabilities_for', { p_actor: ctx.user.id });
    return { items: Array.isArray(items) ? items : [] };
  }

  async function receipts(ctx: RequestContext, params: URLSearchParams) {
    const all = params.get('all') === '1' && ctx.membership.role === 'owner';
    const items = await supabase.rpc<unknown[] | null>('core_capability_receipts_of', { p_actor: ctx.user.id, p_caller_app: callerApp, p_all: all, p_limit: Number(params.get('limit') ?? 50) || 50 });
    return { items: Array.isArray(items) ? items : [] };
  }

  /** Invoca la capacidad en la API del dueño con el token de la persona. `body.requestId` da la idempotencia que el dueño soporte. */
  async function invoke(ctx: RequestContext, id: string, body: Record<string, unknown>) {
    if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    if (!/^[a-z]+\.[a-z0-9_]+$/.test(id)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
    let cap: CapabilityCheck;
    try {
      cap = await supabase.rpc<CapabilityCheck>('core_capability_check', { p_actor: ctx.user.id, p_id: id });
    } catch (error) {
      // Una denegación también deja recibo (quién intentó qué); una capacidad inexistente, no.
      if (error instanceof Fault && error.status !== 404) {
        try { await supabase.rpc('core_capability_receipt', { p: { capability: id, version: 0, callerApp, actorId: ctx.user.id, requestId: typeof body.requestId === 'string' ? body.requestId : null, status: error.status, ok: false, errorCode: error.code, summary: {} } }); } catch { /* nunca impide la respuesta */ }
      }
      throw error;
    }
    const base = apiBaseOf(cap.app, cap.domain);
    if (!base) fail(503, 'APP_UNAVAILABLE', 'La app dueña no tiene dirección conocida.');
    const [method, route] = cap.route.split(' ', 2) as [string, string];
    const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
    const receipt = async (status: number, ok: boolean, errorCode: string | null, summary: Record<string, unknown>) => {
      try {
        await supabase.rpc('core_capability_receipt', { p: { capability: cap.id, version: cap.version, callerApp, actorId: ctx.user.id, requestId: requestId ?? null, status, ok, errorCode, summary } });
      } catch { /* el recibo nunca impide la respuesta */ }
    };
    let res: Response;
    try {
      const url = base.replace(/\/$/, '') + '/api/v1/' + route;
      res = await transport(method === 'GET' ? url + (Object.keys(body).length ? '?' + new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])) : '') : url, {
        method, headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json', 'X-Ikisai-Capability': cap.id, 'X-Ikisai-Caller': callerApp },
        body: method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch {
      await receipt(503, false, 'APP_UNAVAILABLE', {});
      fail(503, 'APP_UNAVAILABLE', 'La app dueña no responde ahora mismo. Inténtalo más tarde.', { app: cap.app });
    }
    const out = await res.json().catch(() => ({})) as any;
    const code = out?.error?.code as string | undefined;
    if (!res.ok) {
      await receipt(res.status, false, code ?? 'APP_REJECTED', {});
      if (res.status === 401 || res.status === 403 || code === 'NO_MEMBERSHIP') fail(403, 'NEEDS_ACCESS', 'Tu cuenta no puede hacer esto en ' + cap.app + '.', { app: cap.app, code: code ?? null });
      throw new Fault(res.status === 409 ? 409 : (res.status === 404 ? 404 : 422), code ?? 'APP_REJECTED', out?.error?.message ?? 'La app dueña no ha aceptado la petición.', { app: cap.app, details: out?.error?.details ?? null });
    }
    // Resumen del recibo: ids y banderas del resultado, nunca el cuerpo entero.
    const summary: Record<string, unknown> = {};
    for (const key of ['id', 'entryId', 'purchaseId', 'taskId', 'replayed', 'cursor']) if (out && out[key] !== undefined && (typeof out[key] !== 'object' || out[key] === null)) summary[key] = out[key];
    await receipt(res.status, true, null, summary);
    return { capability: cap.id, version: cap.version, result: out };
  }

  return { list, invoke, receipts };
}
