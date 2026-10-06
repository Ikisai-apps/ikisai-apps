/**
 * Agentes de IA (contrato §3, docs/tasks/AGENTES.md): riesgo de un lote, propuestas con aprobación humana,
 * claves de agente y registro de accesos. Todo se impone en core.*; aquí se calcula el riesgo y se filtra lo visible.
 */
import { fail, messageFor } from './errors.ts';
import { generateAgentKey } from './auth.ts';
import { sha256Hex, stable, type Supabase } from './supabase.ts';
import type { AppHooks, Operation, RequestContext } from './sync.ts';

export interface AgentPolicy {
  bulkThreshold: number;
  safeProcedures: string[];
  safeActions: string[];
}

export interface Risk {
  required: boolean;
  destructive: boolean;
  bulk: boolean;
  affected: number;
  bulkThreshold: number;
  reasons: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const DEFAULT_POLICY: AgentPolicy = { bulkThreshold: 10, safeProcedures: [], safeActions: [] };

export function policyOf(ctx: RequestContext): AgentPolicy {
  const raw = (ctx.bootstrap as { agentPolicy?: Partial<AgentPolicy> }).agentPolicy;
  return { ...DEFAULT_POLICY, ...(raw ?? {}) };
}

/** Regla del núcleo: destructivo (delete, procedimiento no marcado seguro) o masivo (filas distintas ≥ umbral), más lo que diga la app. */
export async function assessRisk(operations: Operation[], ctx: RequestContext, hooks: AppHooks): Promise<Risk> {
  const policy = policyOf(ctx);
  const reasons: string[] = [];
  const deletes = operations.filter((o) => o.op === 'delete').length;
  const calls = operations.filter((o) => o.op === 'call' && !policy.safeProcedures.includes(o.procedure ?? ''));
  const rows = new Set(operations.filter((o) => o.table && o.id).map((o) => `${o.table}|${o.id}`)).size;
  if (deletes) reasons.push(`delete:${deletes}`);
  for (const call of calls) reasons.push(`call:${call.procedure}`);
  let affected = rows;
  let required = deletes > 0 || calls.length > 0;
  if (hooks.agentRisk) {
    const assessment = (await hooks.agentRisk(operations, ctx)) ?? {};
    if (assessment.required) required = true;
    if (assessment.reasons?.length) reasons.push(...assessment.reasons);
    if (typeof assessment.affectedEstimate === 'number' && assessment.affectedEstimate > affected) affected = assessment.affectedEstimate;
  }
  const bulk = affected >= policy.bulkThreshold;
  if (bulk) reasons.push(`bulk:${affected}>=${policy.bulkThreshold}`);
  return { required: required || bulk, destructive: deletes > 0 || calls.length > 0, bulk, affected, bulkThreshold: policy.bulkThreshold, reasons };
}

export function createAgents(supabase: Supabase, app: string, hooks: AppHooks, validateOperations: (operations: unknown) => Operation[]) {
  function requireHumanOwner(ctx: RequestContext) {
    if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', 'Un agente no administra agentes ni propuestas.');
    if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
  }

  function filterSummary<T extends { summary?: unknown }>(proposal: T, ctx: RequestContext): T {
    if (!hooks.visible || !Array.isArray(proposal.summary)) return proposal;
    const summary = (proposal.summary as Array<{ table: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; op: string }>)
      .filter((c) => c.op === 'call' || hooks.visible!(c.table, c.after ?? c.before ?? {}, ctx));
    return { ...proposal, summary };
  }

  // --- Propuestas ---------------------------------------------------------------
  async function prepare(ctx: RequestContext, body: any) {
    if (ctx.user.kind !== 'agent') fail(403, 'FORBIDDEN', 'Las propuestas las preparan los agentes; una persona guarda directamente.');
    if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    if (!body || typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
    const operations = validateOperations(body.operations);
    if (hooks.beforeCommit) await hooks.beforeCommit(operations, ctx);
    const risk = await assessRisk(operations, ctx, hooks);
    if (!risk.required) fail(422, 'CONFIRMATION_NOT_NEEDED', messageFor('CONFIRMATION_NOT_NEEDED'), { risk });
    const digest = await sha256Hex(stable(operations));
    const proposal = await supabase.rpc<any>('core_proposal_prepare', {
      p_app: app, p_actor: ctx.user.id, p_key: ctx.user.keyId ?? null, p_request_id: body.requestId, p_digest: digest, p_operations: operations, p_risk: risk,
    });
    return filterSummary(proposal, ctx);
  }

  async function list(ctx: RequestContext, params: URLSearchParams) {
    const status = params.get('status');
    if (status && !['pending', 'approved', 'rejected', 'consumed', 'revoked', 'expired'].includes(status)) fail(422, 'INVALID_FILTER', 'Estado desconocido.');
    const limit = params.get('limit') ? Number(params.get('limit')) : null;
    const items = await supabase.rpc<any[]>('core_proposal_list', { p_app: app, p_actor: ctx.user.id, p_status: status, p_limit: limit });
    return { items: items.map((p) => filterSummary(p, ctx)) };
  }

  async function get(ctx: RequestContext, id: string) {
    if (!UUID.test(id)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
    return filterSummary(await supabase.rpc<any>('core_proposal_get', { p_app: app, p_actor: ctx.user.id, p_id: id }), ctx);
  }

  async function decide(ctx: RequestContext, id: string, decision: 'approve' | 'reject') {
    requireHumanOwner(ctx);
    if (!UUID.test(id)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
    const proposal = await supabase.rpc<any>('core_proposal_decide', { p_app: app, p_actor: ctx.user.id, p_id: id, p_decision: decision });
    if (proposal?.autoRejected) {
      fail(409, 'PROPOSAL_UNAVAILABLE', 'El lote ya no encaja con los datos actuales; la propuesta ha quedado rechazada y el agente debe prepararla de nuevo.', { proposal: filterSummary(proposal, ctx) });
    }
    return filterSummary(proposal, ctx);
  }

  // --- Claves ---------------------------------------------------------------------
  async function listKeys(ctx: RequestContext) {
    requireHumanOwner(ctx);
    return { items: await supabase.rpc('core_agent_list', { p_app: app, p_actor: ctx.user.id }) };
  }

  /**
   * Alta de un agente en esta app. Sin `userId`: crea el usuario Auth sintético, el perfil `agent`, la pertenencia y la clave,
   * y devuelve la clave una sola vez. Con `userId` de un agente existente: solo añade la pertenencia a esta app.
   */
  async function issue(ctx: RequestContext, body: any) {
    requireHumanOwner(ctx);
    // Ningún agente en Central (contrato §3.5); se corta antes de crear la cuenta de Auth para no dejarla huérfana.
    if (app === 'central') fail(422, 'INVALID_OPERATION', 'Los agentes no tienen acceso a Central.', { reason: 'agents have no access to central' });
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) fail(422, 'INVALID_OPERATION', 'Nombre del agente inválido.');
    if (!['reader', 'editor'].includes(body?.role)) fail(422, 'INVALID_ROLE', 'Un agente es lector o editor.');
    let expiresAt: string | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      const when = new Date(body.expiresAt);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) fail(422, 'INVALID_OPERATION', 'expiresAt debe ser una fecha futura.');
      expiresAt = when.toISOString();
    }
    if (body.userId !== undefined) {
      if (typeof body.userId !== 'string' || !UUID.test(body.userId)) fail(422, 'INVALID_OPERATION', 'userId inválido.');
      const membership = await supabase.rpc<any>('core_agent_key_issue', {
        p_app: app, p_actor: ctx.user.id, p_user: body.userId, p_name: name, p_role: body.role, p_scopes: body.scopes ?? null, p_digest: null, p_hint: null, p_expires_at: null,
      });
      return { ...membership, token: null, shownOnce: false };
    }
    const bytes = new Uint8Array(18); crypto.getRandomValues(bytes);
    const password = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '');
    const created = await supabase.remote('/auth/v1/admin/users', {
      service: true, method: 'POST',
      body: { email: `agent-${crypto.randomUUID().slice(0, 8)}@agents.ikisai.invalid`, password, email_confirm: true, user_metadata: { kind: 'agent', name } },
    });
    if (typeof created?.id !== 'string') fail(502, 'AUTH_ADMIN_FAILED', 'No se pudo crear la cuenta del agente.');
    const token = generateAgentKey();
    const issued = await supabase.rpc<any>('core_agent_key_issue', {
      p_app: app, p_actor: ctx.user.id, p_user: created.id, p_name: name, p_role: body.role, p_scopes: body.scopes ?? null,
      p_digest: await sha256Hex(token), p_hint: token.slice(-4), p_expires_at: expiresAt,
    });
    return { ...issued, token, shownOnce: true };
  }

  async function revoke(ctx: RequestContext, keyId: string, onlyMembership: boolean) {
    requireHumanOwner(ctx);
    if (!UUID.test(keyId)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
    return supabase.rpc('core_agent_key_revoke', { p_app: app, p_actor: ctx.user.id, p_key: keyId, p_only_membership: onlyMembership });
  }

  // --- Registro -------------------------------------------------------------------
  async function accessLog(ctx: RequestContext, params: URLSearchParams) {
    requireHumanOwner(ctx);
    const before = params.get('before');
    if (before !== null && !/^\d+$/.test(before)) fail(422, 'INVALID_FILTER', 'Parámetro before inválido.');
    const limit = params.get('limit');
    if (limit !== null && !/^\d+$/.test(limit)) fail(422, 'INVALID_FILTER', 'Parámetro limit inválido.');
    return supabase.rpc('core_access_log', { p_app: app, p_actor: ctx.user.id, p_before: before === null ? null : Number(before), p_limit: limit === null ? null : Number(limit) });
  }

  return { prepare, list, get, decide, listKeys, issue, revoke, accessLog };
}
