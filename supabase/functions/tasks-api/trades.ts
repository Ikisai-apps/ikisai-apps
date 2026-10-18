/**
 * Ikisai Tasks · oficios de Central en lugar de la familia «Tipo: Acción» (fase P2, PR 1; docs/tasks/API.md §32).
 *
 * La correspondencia etiqueta → oficio se calcula aquí (`actionTradeMap`) con lo que publica Central para Tasks
 * (`central.trade_options`, leída como lectura registrada con el usuario que pide) y viaja como argumento `map` a la
 * lectura y a los procedimientos SQL, que revalidan cada oficio con `central.trade_alive`. Todo, solo para la propietaria
 * humana con acceso completo.
 * - `POST read/tasks.trades_preview {remove?}` (lo desvía `createTasksApp` a `actions/preview`): vista previa.
 * - `POST actions/to-trades {requestId, remove?}`: la ida. `CENTRAL_TRADES_EMPTY` si Central no tiene oficios.
 * - `POST actions/to-labels {requestId, dropUnmapped?}`: la vuelta.
 */
import { createSync, fail, type AppRoute, type RequestContext, type Supabase } from '../_kit/mod.ts';
import { actionTradeMap, isAdministrator, tradeMapArgument, type FamilyRow, type LabelRow, type Role, type TradeOption } from '../_domain/tasks/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 2000;

export function tradeRoutes(supabase: Supabase): AppRoute[] {
  /** Confirmaciones y lecturas internas: mismo `core.commit`, sin el `beforeCommit` que veta los `call` de clientes. */
  const internal = createSync(supabase, 'tasks', {});
  const admin = (ctx: RequestContext) => {
    if (!isAdministrator({ role: ctx.membership.role as Role, scopes: ctx.membership.scopes, kind: ctx.bootstrap.profile.kind })) {
      fail(403, 'FORBIDDEN', 'Se necesita un propietario con acceso a toda la app.');
    }
  };

  /** Los oficios activos de Central, leídos con el usuario que pide. Si no se pueden leer, error claro (nunca «todo dudoso»). */
  async function tradeOptions(ctx: RequestContext): Promise<TradeOption[]> {
    const rows: TradeOption[] = [];
    try {
      for (let offset = 0; ; offset += PAGE) {
        const page = await internal.read(ctx, 'central.trade_options', { limit: PAGE, offset }) as { rows?: TradeOption[]; total?: number } | null;
        if (!page || !Array.isArray(page.rows)) throw new Error('lectura sin filas');
        rows.push(...page.rows);
        if (page.rows.length < PAGE || rows.length >= Number(page.total ?? 0)) break;
      }
    } catch (error) {
      console.error('[tasks] central.trade_options', (error as Error)?.message);
      fail(503, 'CENTRAL_UNAVAILABLE', 'No se pudo leer el catálogo de oficios de Central. Inténtalo de nuevo más tarde.');
    }
    return rows;
  }

  async function catalog<T>(ctx: RequestContext, table: 'tasks.families' | 'tasks.labels'): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await supabase.rpc<{ rows: T[] }>('core_snapshot_table', { p_app: 'tasks', p_role: ctx.membership.role, p_table: table, p_include_deleted: false, p_limit: PAGE, p_offset: offset });
      rows.push(...page.rows);
      if (page.rows.length < PAGE) return rows;
    }
  }

  async function correspondence(ctx: RequestContext) {
    const [options, families, labels] = await Promise.all([tradeOptions(ctx), catalog<FamilyRow>(ctx, 'tasks.families'), catalog<LabelRow>(ctx, 'tasks.labels')]);
    return { options, map: actionTradeMap(families, labels, options) };
  }

  const removeList = (value: unknown): string[] => {
    const remove = value ?? [];
    if (!Array.isArray(remove) || remove.length > 500 || !remove.every((id: unknown) => typeof id === 'string' && UUID.test(id))) fail(422, 'INVALID_OPERATION', 'remove es una lista de ids de etiqueta.');
    return (remove as string[]).map((id) => id.toLowerCase());
  };

  return [
    {
      method: 'POST', pattern: 'actions/:direction', handler: async ({ ctx, params, json }) => {
        admin(ctx);
        const body = await json();
        if (params.direction === 'preview') {
          const remove = removeList(body.remove);
          const { options, map } = await correspondence(ctx);
          const out = await internal.read(ctx, 'tasks.trades_preview', { remove, map: tradeMapArgument(map) }) as Record<string, any>;
          const path = new Map(options.map((o) => [o.trade_id, o.path || o.name]));
          for (const item of out.mapped ?? []) item.tradePath = path.get(item.tradeId) ?? null;
          for (const item of out.lost ?? []) item.tradePath = path.get(item.tradeId) ?? null;
          // Hoy en producción Central no tiene oficios: la interfaz lo dice en vez de enseñar todas las acciones como dudosas.
          if (options.length === 0) out.centralEmpty = true;
          return out;
        }
        if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
        let operation;
        if (params.direction === 'to-trades') {
          const remove = removeList(body.remove);
          const { options, map } = await correspondence(ctx);
          if (options.length === 0) fail(422, 'CENTRAL_TRADES_EMPTY', 'Central todavía no tiene oficios: créalos allí antes de pasar las acciones.');
          operation = { op: 'call' as const, procedure: 'tasks.actions_to_trades', args: { remove, map: tradeMapArgument(map) } };
        } else if (params.direction === 'to-labels') {
          const { map } = await correspondence(ctx);
          operation = { op: 'call' as const, procedure: 'tasks.trades_to_actions', args: { dropUnmapped: body.dropUnmapped === true, map: tradeMapArgument(map) } };
        } else {
          fail(404, 'NOT_FOUND', 'Ruta desconocida.');
        }
        const committed = await internal.commit(ctx, { requestId: body.requestId, operations: [operation!] });
        const result = (committed.results[0] as { result?: { source: string; counts: Record<string, number> } })?.result;
        return { source: result?.source, counts: result?.counts ?? {}, cursor: committed.cursor };
      },
    },
  ];
}

/**
 * La vista previa se pide como las demás lecturas (`POST read/tasks.trades_preview`, igual que `tasks.zones_preview`),
 * pero antes hay que leer Central con el usuario: el kit sirve `read/:name` directamente desde SQL, así que esa ruta se
 * desvía aquí a `actions/preview`, que calcula la correspondencia y llama a la lectura SQL.
 */
export function withTradesPreview(handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  const READ = /\/api\/v1\/read\/tasks\.trades_preview\/?$/;
  return async (request) => {
    if (request.method !== 'POST') return handler(request);
    const url = new URL(request.url);
    if (!READ.test(url.pathname)) return handler(request);
    url.pathname = url.pathname.replace(READ, '/api/v1/actions/preview');
    const body = await request.arrayBuffer();
    return handler(new Request(url, { method: 'POST', headers: request.headers, body }));
  };
}
