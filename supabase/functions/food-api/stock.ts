/**
 * Food · lo que la app escribe en Recursos con origen Food (FO4 de la auditoría del 27-10; Recursos 0820, núcleo 0118).
 *
 * Desde el navegador, Recursos no se fía del `source_app` que mande el cliente: en un lote del navegador pone la app del
 * lote, y el cliente de Recursos de Food escribe con la app `resources` (sin origen). Lo que tiene que quedar «de Food»
 * pasa por aquí, por el servidor, que lo confirma con origen `server` y `source_app` 'food':
 * - la entrada (o la salida) de lo comprado en una lista de la compra (`shopping_item:<id>`): Finance le pone el coste
 *   buscando ese origen (0237, 0243);
 * - el consumo de un plato con `resources.consume` (`menu_item:<id>`, `once`): así coincide con el del worker de las 24 h y
 *   nunca se descuenta dos veces.
 * Nada más: cualquier otra operación se rechaza. La cantidad de Maquinaria es una entrada a mano y va sin origen, como
 * cualquier movimiento anotado en Recursos.
 */
import { fail, sha256Hex, stable, type AppRoute, type Operation, type Supabase } from '../_kit/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOPPING_REF = /^shopping_item:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MENU_ITEM_REF = /^menu_item:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOVEMENT_FIELDS = new Set(['item_id', 'space_id', 'quantity', 'kind', 'reason', 'source_ref', 'note']);
const CONSUME_ARGS = new Set(['item_id', 'quantity', 'kind', 'source_ref', 'note', 'once', 'space_ids', 'default_space_id']);

const reject = (index: number, reason: string): never => fail(422, 'INVALID_OPERATION', 'Solo lo comprado y el consumo de un plato.', { index, reason });

/**
 * Las operaciones que admite la ruta, con `source_app: 'food'` puesto aquí. Una entrada o salida de lo comprado
 * (`resources.movements`, `entrada_manual` o `salida_manual`, con referencia `shopping_item:`) o el consumo de un plato
 * (`resources.consume`, `consumo_servicio`, referencia `menu_item:`).
 */
export function stockOperations(input: unknown): Operation[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 200) fail(422, 'INVALID_OPERATION', 'Entre 1 y 200 operaciones.');
  return (input as unknown[]).map((raw, index) => {
    const op = (raw ?? {}) as Record<string, any>;
    if (op.op === 'insert' && op.table === 'resources.movements') {
      if (typeof op.id !== 'string' || !UUID.test(op.id)) reject(index, 'id');
      const fields = (op.fields ?? {}) as Record<string, unknown>;
      if (Object.keys(fields).some((k) => !MOVEMENT_FIELDS.has(k))) reject(index, 'fields');
      if (!['entrada_manual', 'salida_manual'].includes(String(fields.kind))) reject(index, 'kind');
      if (typeof fields.source_ref !== 'string' || !SHOPPING_REF.test(fields.source_ref)) reject(index, 'source_ref');
      return { op: 'insert', table: 'resources.movements', id: op.id.toLowerCase(), fields: { ...fields, source_app: 'food' } } as Operation;
    }
    if (op.op === 'call' && op.procedure === 'resources.consume') {
      const args = (op.args ?? {}) as Record<string, unknown>;
      if (Object.keys(args).some((k) => !CONSUME_ARGS.has(k))) reject(index, 'args');
      if (args.kind !== 'consumo_servicio') reject(index, 'kind');
      if (typeof args.source_ref !== 'string' || !MENU_ITEM_REF.test(args.source_ref)) reject(index, 'source_ref');
      return { op: 'call', procedure: 'resources.consume', args: { ...args, source_app: 'food', once: true } } as unknown as Operation;
    }
    return reject(index, 'op');
  });
}

/**
 * `POST stock/commands {requestId, operations}`: lo comprado y el consumo, a Recursos con origen Food. Editor u owner de
 * Food; en Recursos cuentan los permisos de la persona (es quien lo hace), con origen `server`.
 */
export function stockRoutes(supabase: Supabase): AppRoute[] {
  return [{
    method: 'POST', pattern: 'stock/commands', handler: async ({ ctx, json }) => {
      if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Solo quien edita puede anotar en el inventario.');
      const body = ((await json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(body.requestId) ? body.requestId : fail(422, 'INVALID_OPERATION', 'requestId inválido.');
      const operations = stockOperations(body.operations);
      return supabase.rpc('core_commit', {
        p_app: 'resources', p_actor: ctx.user.id, p_request_id: `food-stock:${requestId}`, p_digest: await sha256Hex(stable(operations)),
        p_expected_cursor: null, p_operations: operations, p_confirmation: null, p_origin: 'server',
      });
    },
  }];
}
