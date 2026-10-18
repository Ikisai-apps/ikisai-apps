/** Sugerencias (RECURSOS.md §14.1, migración 0092): propuestas de personas que staff o dirección aprueba o descarta.
 *  Al aprobar, el lote se aplica como un commit de quien aprueba. No confundir con las propuestas de agentes (`agents.ts`). */
import { fail } from './errors.ts';
import type { Supabase } from './supabase.ts';
import type { AppHooks, Operation, RequestContext } from './sync.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const APP = /^[a-z][a-z0-9_]{0,39}$/;

export function createSuggestions(supabase: Supabase, app: string, validateOperations: (ops: unknown) => Operation[], hooks: AppHooks = {}) {
  const canSee = (ctx: RequestContext, s: any) => !hooks.suggestionVisible || hooks.suggestionVisible(s, ctx);
  /** Quien revisa solo previsualiza o decide lo que su app le deja ver (`suggestionVisible`); si no, como si no existiera. */
  async function guard(ctx: RequestContext, raw: string, corrected: Operation[] | null) {
    if (!hooks.suggestionVisible) return;
    const s = await supabase.rpc<any>('core_suggestion_get', { p_app: app, p_actor: ctx.user.id, p_id: raw });
    if (!canSee(ctx, s) || (corrected && !canSee(ctx, { ...s, operations: corrected }))) fail(404, 'NOT_FOUND', 'Sugerencia no encontrada.');
  }
  const id = (raw: string) => { if (!UUID.test(raw)) fail(404, 'NOT_FOUND', 'Sugerencia no encontrada.'); return raw; };
  /** Se puede sugerir a otra app (p. ej. un plato a Food desde Guests); el núcleo comprueba `submit_from`. */
  const target = (raw: unknown) => {
    if (raw === undefined || raw === null || raw === '') return app;
    if (typeof raw !== 'string' || !APP.test(raw)) fail(422, 'INVALID_OPERATION', 'App inválida.');
    return raw;
  };
  const ops = (raw: unknown) => (raw === undefined || raw === null ? null : validateOperations(raw));

  async function create(ctx: RequestContext, body: any) {
    if (!body || typeof body !== 'object') fail(400, 'INVALID_JSON', 'Cuerpo inválido.');
    if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
    if (typeof body.kind !== 'string') fail(422, 'INVALID_OPERATION', 'kind es obligatorio.');
    if (typeof body.summary !== 'string') fail(422, 'INVALID_FIELDS', 'summary es obligatorio.');
    if (body.detail !== undefined && body.detail !== null && (typeof body.detail !== 'object' || Array.isArray(body.detail))) fail(422, 'INVALID_FIELDS', 'detail debe ser un objeto.');
    return supabase.rpc('core_suggest', {
      p_app: target(body.app), p_actor: ctx.user.id, p_request_id: body.requestId, p_kind: body.kind,
      p_summary: body.summary, p_detail: body.detail ?? null, p_operations: validateOperations(body.operations),
    });
  }

  async function list(ctx: RequestContext, params: URLSearchParams) {
    const scope = params.get('scope') ?? 'mine';
    const limit = Number(params.get('limit') ?? 50);
    const result = await supabase.rpc<any>('core_suggestion_list', {
      p_app: scope === 'mine' ? target(params.get('app')) : app, p_actor: ctx.user.id, p_scope: scope,
      p_limit: Number.isFinite(limit) ? limit : 50, p_before: params.get('before'),
    });
    if (scope === 'mine' || !hooks.suggestionVisible) return result;
    // Con ámbitos, el contador también cuenta solo lo visible (las pendientes son pocas: hasta 200).
    const pending = await supabase.rpc<any>('core_suggestion_list', { p_app: app, p_actor: ctx.user.id, p_scope: 'pending', p_limit: 200, p_before: null });
    return { ...result, items: (result.items ?? []).filter((s: any) => canSee(ctx, s)), pendingCount: (pending.items ?? []).filter((s: any) => canSee(ctx, s)).length };
  }

  async function preview(ctx: RequestContext, raw: string, body: any) {
    const corrected = ops(body?.operations);
    await guard(ctx, id(raw), corrected);
    return supabase.rpc('core_suggestion_preview', { p_app: app, p_actor: ctx.user.id, p_id: raw, p_operations: corrected });
  }

  async function decide(ctx: RequestContext, raw: string, decision: 'approve' | 'reject', body: any) {
    if (body?.comment !== undefined && body.comment !== null && typeof body.comment !== 'string') fail(422, 'INVALID_FIELDS', 'comment debe ser texto.');
    const corrected = decision === 'approve' ? ops(body?.operations) : null;
    await guard(ctx, id(raw), corrected);
    return supabase.rpc('core_suggestion_decide', {
      p_app: app, p_actor: ctx.user.id, p_id: raw, p_decision: decision,
      p_comment: body?.comment ?? null, p_operations: corrected,
    });
  }

  async function withdraw(ctx: RequestContext, raw: string, body: any) {
    return supabase.rpc('core_suggestion_withdraw', { p_app: target(body?.app), p_actor: ctx.user.id, p_id: id(raw) });
  }

  return { create, list, preview, decide, withdraw };
}
