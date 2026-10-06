/**
 * Ikisai Tasks · herramientas de dominio en `/api/v1/mcp` (contrato §3.2, docs/tasks/AGENTES.md §6). Cada herramienta lee
 * lo que quien llama puede ver, construye el lote con `buildTaskTool` (cascadas incluidas) y lo envía por el mismo camino
 * que `commands`: `beforeCommit`, riesgo del agente y `core.commit`. Si el lote necesita aprobación, prepara la
 * propuesta con ese lote exacto y se la devuelve al agente.
 */
import { fail, type McpTool, type McpToolKit, type RequestContext } from '../_kit/mod.ts';
import { DomainError, TABLES, TASK_TOOL_SPECS, buildTaskTool, emptyDataset, type Dataset } from '../_domain/tasks/mod.ts';

const PAGE = 2000;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

/** El conjunto visible para quien llama, papelera incluida (la necesitan las cascadas para reutilizar filas puente). */
export async function visibleDataset(kit: McpToolKit): Promise<Dataset> {
  const data = emptyDataset() as unknown as Record<string, Record<string, unknown>[]>;
  for (let offset = 0, more = true; more; offset += PAGE) {
    const page = await kit.snapshot([...TABLES], { includeDeleted: true, limit: PAGE, offset }) as { tables: Array<{ table: string; rows: Record<string, unknown>[]; total: number }> };
    more = false;
    for (const { table, rows, total } of page.tables) {
      data[table]!.push(...rows);
      if (offset + PAGE < total) more = true;
    }
  }
  return data as unknown as Dataset;
}

/**
 * Ids deterministas para las filas nuevas de un lote: derivados del `requestId`, para que reintentar la misma llamada
 * construya exactamente el mismo lote (el núcleo solo devuelve el recibo si el lote coincide).
 */
async function idsFor(requestId: string, count = 256): Promise<() => string> {
  const encoder = new TextEncoder();
  const ids = await Promise.all(Array.from({ length: count }, async (_, n) => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`ikisai-tasks-mcp:${requestId}:${n}`))).slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }));
  let next = 0;
  return () => { if (next >= ids.length) fail(422, 'INVALID_INPUT', 'El cambio crea demasiadas filas de una vez.'); return ids[next++]!; };
}

const APPROVAL = ' Si el cambio necesita aprobación (borrar, archivar o 10 elementos o más), la respuesta trae `needsApproval: true` y la propuesta ya preparada: cuando una persona la apruebe, envíala con `tasks_commit` usando `requestId`, `operations` y `confirmationId: proposal.id` de esa propuesta.';
const REQUEST_ID_SCHEMA = { type: 'string', pattern: REQUEST_ID.source, description: 'Opcional. Repetir la llamada con el mismo requestId no duplica el cambio.' };

export function tasksMcpTools(): McpTool[] {
  return TASK_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description + APPROVAL,
    inputSchema: { ...spec.inputSchema, properties: { ...(spec.inputSchema.properties as Record<string, unknown>), requestId: REQUEST_ID_SCHEMA } },
    annotations: spec.annotations,
    minRole: 'editor',
    async handler(args: Record<string, unknown>, ctx: RequestContext, kit: McpToolKit) {
      const { requestId: given, ...input } = args ?? {};
      if (given !== undefined && (typeof given !== 'string' || !REQUEST_ID.test(given))) fail(422, 'INVALID_INPUT', 'requestId inválido.', { field: 'requestId' });
      const requestId = (given as string | undefined) ?? `mcp-${spec.name}-${crypto.randomUUID()}`;
      let operations;
      try {
        operations = buildTaskTool(spec.name, await visibleDataset(kit), input, await idsFor(requestId));
      } catch (error) {
        if (error instanceof DomainError) fail(error.status, error.code, error.message, error.details);
        throw error;
      }
      if (!operations.length) return { requestId, unchanged: true };
      try {
        return await kit.commit({ requestId, operations });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (ctx.user.kind === 'agent' && code === 'CONFIRMATION_REQUIRED') {
          return { needsApproval: true, proposal: await kit.prepare({ requestId, operations }) };
        }
        // Reintento de un cambio que ya se aplicó: los datos han cambiado (por ese mismo cambio) y el lote reconstruido
        // ya no coincide con el guardado. No se repite nada.
        if (code === 'IDEMPOTENCY_REUSE' && given !== undefined) {
          return { requestId, alreadyUsed: true, message: 'Ese requestId ya se usó: si es un reintento, el cambio ya estaba hecho y no se repite; si es otro cambio, usa otro requestId.' };
        }
        throw error;
      }
    },
  }));
}
