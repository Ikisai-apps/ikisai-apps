/**
 * Uso semántico de funcionalidades (contrato §3.8, coordinacion/ampliacion/USO.md): rutas `usage*` en todas las apps.
 * Recibe totales diarios por dispositivo (el núcleo guarda el máximo: idempotente) y sirve la perspectiva «Uso» del Revisor,
 * solo al dueño del ecosistema. La persona solo cuenta si es interna, en producción y aceptó el aviso.
 */
import { fail, messageFor } from './errors.ts';
import type { Supabase } from './supabase.ts';
import type { RequestContext } from './sync.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEATURE = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$/;
export const TEAM_PROJECTION = 'central.common_team_projection';

export function createUsage(supabase: Supabase, app: string) {
  function human(ctx: RequestContext) {
    if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
  }

  /** Equipos de Central para la matriz por audiencia: {team_id: {name, users}}. Sin proyección o sin acceso, vacío. */
  async function teams(ctx: RequestContext): Promise<Record<string, { name: string; users: string[] }>> {
    try {
      const out = await supabase.rpc<{ rows?: Array<{ team_id: string; name: string; user_id: string }> }>('core_read', {
        p_app: 'central', p_actor: ctx.user.id, p_name: TEAM_PROJECTION, p_args: { limit: 5000 },
      });
      const map: Record<string, { name: string; users: string[] }> = {};
      for (const r of out?.rows ?? []) {
        if (!r?.team_id) continue;
        map[r.team_id] ??= { name: r.name, users: [] };
        if (r.user_id) map[r.team_id]!.users.push(r.user_id);
      }
      return map;
    } catch {
      return {};
    }
  }

  async function batch(ctx: RequestContext, body: any) {
    human(ctx);
    if (typeof body?.deviceId !== 'string' || !UUID.test(body.deviceId)) fail(422, 'INVALID_OPERATION', 'deviceId inválido.');
    if (!Array.isArray(body.items)) fail(422, 'INVALID_OPERATION', 'items debe ser una lista.');
    return supabase.rpc('core_usage_batch', { p_app: app, p_actor: ctx.user.id, p_device: body.deviceId.toLowerCase(), p_items: body.items });
  }

  async function consent(ctx: RequestContext, accept: boolean) {
    human(ctx);
    return supabase.rpc('core_usage_consent', { p_actor: ctx.user.id, p_accept: accept });
  }

  async function review(ctx: RequestContext, params: URLSearchParams) {
    const requested = params.get('app') ?? 'all';
    if (requested !== 'all' && !/^[a-z][a-z0-9_]{1,30}$/.test(requested)) fail(422, 'INVALID_FILTER', 'app inválida.');
    const items = await supabase.rpc('core_usage_review', { p_actor: ctx.user.id, p_app: requested, p_teams: await teams(ctx) });
    return { items };
  }

  async function feature(ctx: RequestContext, id: string) {
    if (!FEATURE.test(id)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
    const map = await teams(ctx);
    const detail: any = await supabase.rpc('core_usage_feature_detail', { p_actor: ctx.user.id, p_feature: id, p_teams: map });
    // Matriz por equipo: suma de las personas de cada equipo (solo quien aceptó el aviso aparece con nombre).
    const byTeam = Object.entries(map).map(([teamId, t]) => {
      const people = (detail.byPerson ?? []).filter((p: any) => t.users.includes(p.userId));
      return {
        teamId, name: t.name, people: people.length,
        exposures: people.reduce((n: number, p: any) => n + Number(p.exposures), 0),
        activations: people.reduce((n: number, p: any) => n + Number(p.activations), 0),
        successes: people.reduce((n: number, p: any) => n + Number(p.successes), 0),
      };
    }).filter((t) => t.people > 0 || (detail.audience?.teams ?? []).includes(t.teamId));
    return { ...detail, byTeam };
  }

  async function decide(ctx: RequestContext, id: string, body: any) {
    human(ctx);
    if (!FEATURE.test(id)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
    const args: Record<string, unknown> = {};
    if (body?.decision !== undefined) {
      args.decision = body.decision ?? 'clear';
      if (typeof body.reason === 'string') args.reason = body.reason.slice(0, 500);
      if (typeof body.reviewAfter === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.reviewAfter)) args.reviewAfter = body.reviewAfter;
    }
    if (typeof body?.frequency === 'string') args.frequency = body.frequency;
    if (body?.audience && typeof body.audience === 'object') {
      const teamsIn = Array.isArray(body.audience.teams) ? body.audience.teams.filter((t: unknown) => typeof t === 'string' && UUID.test(t)) : [];
      const peopleIn = Array.isArray(body.audience.people) ? body.audience.people.filter((p: unknown) => typeof p === 'string' && UUID.test(p)) : [];
      args.audience = { teams: teamsIn.slice(0, 20), people: peopleIn.slice(0, 50) };
    }
    if (body?.newGeneration === true) args.newGeneration = true;
    return supabase.rpc('core_usage_decide', { p_actor: ctx.user.id, p_feature: id, p_args: args });
  }

  return { batch, consent, review, feature, decide };
}
