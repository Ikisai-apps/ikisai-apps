/**
 * Servidor MCP por app (contrato §3.2, docs/tasks/AGENTES.md §6): `POST /api/v1/mcp`, JSON-RPC 2.0 sobre HTTP, con la misma
 * autenticación que el resto de la API (sesión de persona o clave de agente `ika_`). Herramientas genéricas montadas sobre las
 * rutas del núcleo; cada app añade las de dominio con `AppConfig.mcpTools`. Todo pasa por el mismo camino (hooks, riesgo,
 * propuestas, core.commit): MCP no da a un agente nada que la API no le dé. La aprobación de propuestas no se expone.
 */
import { Fault } from './errors.ts';
import type { RequestContext, Role } from './sync.ts';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

export interface McpToolKit {
  /** `POST commands` con el riesgo de agente aplicado. */
  commit(body: { requestId: string; operations: unknown[]; confirmationId?: string | null; expectedCursor?: number | null }): Promise<unknown>;
  /** `POST proposals`. */
  prepare(body: { requestId: string; operations: unknown[] }): Promise<unknown>;
  /** Lectura registrada (`read/:name`). */
  read(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Snapshot de tablas concretas (filtrado por visibilidad). */
  snapshot(tables: string[], options?: { includeDeleted?: boolean; limit?: number; offset?: number }): Promise<unknown>;
}

export interface McpTool {
  /** Nombre completo, con el prefijo de la app (`tasks_create_task`). */
  name: string;
  description: string;
  /** JSON Schema del argumento (objeto). */
  inputSchema: Record<string, unknown>;
  /** Rol mínimo para anunciarla y ejecutarla; por defecto `reader`. */
  minRole?: Role;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };
  handler(args: Record<string, unknown>, ctx: RequestContext, kit: McpToolKit): Promise<unknown>;
}

interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: any }

const RANK: Record<string, number> = { reader: 0, editor: 1, owner: 2 };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const OPERATIONS = { type: 'array', description: 'Operaciones de fila del contrato §4 (insert/update/delete/restore/call).', items: { type: 'object' } };

export interface McpCore extends McpToolKit {
  changes(after: number, limit?: number): Promise<unknown>;
  history(before: number | null, limit?: number): Promise<unknown>;
  proposals(status?: string | null): Promise<unknown>;
  proposal(id: string): Promise<unknown>;
  undoPlan(cursor: number): Promise<unknown>;
  undo(cursor: number, body: { requestId: string; planHash: string; confirmationId?: string | null }): Promise<unknown>;
  invoke(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

function genericTools(app: string): Array<Omit<McpTool, 'handler'> & { handler: (args: any, ctx: RequestContext, core: McpCore) => Promise<unknown> }> {
  const ro = { readOnlyHint: true };
  return [
    { name: `${app}_snapshot`, description: `Filas actuales de las tablas de ${app} visibles para ti (paginado).`, annotations: ro,
      inputSchema: obj({ tables: { type: 'array', items: { type: 'string' } }, includeDeleted: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 2000 }, offset: { type: 'integer', minimum: 0 } }),
      handler: (a, ctx, c) => c.snapshot(Array.isArray(a.tables) && a.tables.length ? a.tables : ctx.bootstrap.tables.filter((t) => t.readable).map((t) => t.table), a) },
    { name: `${app}_changes`, description: 'Cambios posteriores a un cursor.', annotations: ro,
      inputSchema: obj({ after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, ['after']),
      handler: (a, _ctx, c) => c.changes(a.after, a.limit) },
    { name: `${app}_history`, description: 'Historial de lotes (más recientes primero).', annotations: ro,
      inputSchema: obj({ before: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
      handler: (a, _ctx, c) => c.history(a.before ?? null, a.limit) },
    { name: `${app}_read`, description: 'Lectura registrada (función o vista) por su nombre schema.objeto.', annotations: ro,
      inputSchema: obj({ name: { type: 'string' }, args: { type: 'object' } }, ['name']),
      handler: (a, _ctx, c) => c.read(a.name, a.args ?? {}) },
    { name: `${app}_commit`, description: 'Guarda un lote. Si eres un agente y el lote es destructivo o masivo, responde CONFIRMATION_REQUIRED: prepara una propuesta y repite con confirmationId cuando una persona la apruebe.', minRole: 'editor', annotations: { destructiveHint: true },
      inputSchema: obj({ requestId: { type: 'string' }, operations: OPERATIONS, confirmationId: { type: 'string' }, expectedCursor: { type: 'integer' } }, ['requestId', 'operations']),
      handler: (a, _ctx, c) => c.commit(a) },
    { name: `${app}_prepare_batch`, description: 'Prepara una propuesta para un lote que exige aprobación humana (solo agentes). Devuelve su id y caduca en 24 horas.', minRole: 'editor', annotations: { idempotentHint: true },
      inputSchema: obj({ requestId: { type: 'string' }, operations: OPERATIONS }, ['requestId', 'operations']),
      handler: (a, _ctx, c) => c.prepare(a) },
    { name: `${app}_proposals`, description: 'Propuestas (las tuyas si eres un agente).', annotations: ro,
      inputSchema: obj({ status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'consumed', 'revoked', 'expired'] }, id: { type: 'string' } }),
      handler: (a, _ctx, c) => (a.id ? c.proposal(a.id) : c.proposals(a.status ?? null)) },
    { name: `${app}_undo_plan`, description: 'Plan para deshacer un lote del historial.', minRole: 'editor', annotations: ro,
      inputSchema: obj({ cursor: { type: 'integer', minimum: 1 } }, ['cursor']),
      handler: (a, _ctx, c) => c.undoPlan(a.cursor) },
    { name: `${app}_undo`, description: 'Deshace un lote con el planHash de undo_plan.', minRole: 'editor', annotations: { destructiveHint: true },
      inputSchema: obj({ cursor: { type: 'integer', minimum: 1 }, requestId: { type: 'string' }, planHash: { type: 'string' }, confirmationId: { type: 'string' } }, ['cursor', 'requestId', 'planHash']),
      handler: (a, _ctx, c) => c.undo(a.cursor, a) },
    { name: `${app}_invoke`, description: 'Ejecuta una acción registrada (kind action).', minRole: 'editor', annotations: { destructiveHint: true },
      inputSchema: obj({ name: { type: 'string' }, args: { type: 'object' } }, ['name']),
      handler: (a, _ctx, c) => c.invoke(a.name, a.args ?? {}) },
  ];
}

export function createMcp(app: string, release: string, appTools: McpTool[] = []) {
  const generic = genericTools(app);
  const all = [...generic, ...appTools.map((t) => ({ ...t, handler: (a: any, ctx: RequestContext, core: McpCore) => t.handler(a, ctx, core) }))];

  function visibleTools(ctx: RequestContext) {
    const rank = RANK[ctx.membership.role] ?? 0;
    return all.filter((t) => rank >= (RANK[t.minRole ?? 'reader'] ?? 0) && !(t.name === `${app}_prepare_batch` && ctx.user.kind !== 'agent'));
  }

  async function handleOne(message: JsonRpcRequest, ctx: RequestContext, core: McpCore): Promise<unknown | null> {
    const id = message?.id;
    const isNotification = id === undefined;
    const reply = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const error = (code: number, text: string, data?: unknown) => (isNotification ? null : { jsonrpc: '2.0', id: id ?? null, error: { code, message: text, ...(data === undefined ? {} : { data }) } });
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid Request');
    switch (message.method) {
      case 'initialize': {
        const asked = message.params?.protocolVersion;
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `ikisai-${app}`, version: release },
          instructions: `Datos de Ikisai ${app}. Lee con ${app}_snapshot o ${app}_changes; guarda con ${app}_commit. Lo destructivo o masivo de un agente exige ${app}_prepare_batch y aprobación humana.`,
        });
      }
      case 'ping':
        return reply({});
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'tools/list':
        return reply({ tools: visibleTools(ctx).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })) });
      case 'tools/call': {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        const tool = visibleTools(ctx).find((t) => t.name === name);
        if (!tool) return error(-32602, `Herramienta desconocida o no permitida: ${String(name)}`);
        if (typeof args !== 'object' || Array.isArray(args) || args === null) return error(-32602, 'arguments debe ser un objeto');
        try {
          const result = await tool.handler(args, ctx, core);
          const structured = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: structured });
        } catch (failure) {
          // Los errores de la herramienta son resultados (isError) para que el modelo los vea y pueda corregir.
          if (failure instanceof Fault) {
            const payload = failure.toJSON();
            return reply({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true });
          }
          throw failure;
        }
      }
      default:
        return error(-32601, `Método no soportado: ${message.method}`);
    }
  }

  /** Atiende un cuerpo JSON-RPC (mensaje suelto o lote). `null` = solo notificaciones (202 sin cuerpo). */
  async function handle(body: unknown, ctx: RequestContext, core: McpCore): Promise<unknown | null> {
    if (Array.isArray(body)) {
      if (!body.length) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
      const out = (await Promise.all(body.map((m) => handleOne(m, ctx, core)))).filter((r) => r !== null);
      return out.length ? out : null;
    }
    return handleOne(body as JsonRpcRequest, ctx, core);
  }

  return { handle, tools: (ctx: RequestContext) => visibleTools(ctx).map((t) => t.name) };
}

