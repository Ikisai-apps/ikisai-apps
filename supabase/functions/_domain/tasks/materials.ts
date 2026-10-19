/**
 * Tasks · materiales y equipos de una tarea (R6 PR 3; migración 0334; docs/tasks/API.md §36): operaciones puras. Un
 * material es un artículo de Recursos con su cantidad prevista; un equipo (artículo de tipo no consumible: herramientas,
 * máquinas…) solo dice «hace falta». Al completar la tarea se confirma el consumo: la llamada a `resources.consume` va
 * por el cliente de Recursos (`consumeCall`) y el lote de Tasks apunta lo gastado (`confirmConsumptionOps`). Nada se
 * descuenta sin confirmar.
 */
import { POSITION_STEP, reject, type Dataset, type Operation, type TaskMaterialRow, type Uuid } from './types.ts';
import type { NewId } from './ops.ts';

const randomId: NewId = () => crypto.randomUUID();
const live = <T extends { deleted_at: string | null }>(rows: readonly T[] | undefined): T[] => (rows ?? []).filter((r) => !r.deleted_at);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Fila de `central.trade_kit_options`: lo que suele hacer falta para un oficio. */
export interface TradeKitOption { trade_id: Uuid; item_id: Uuid; quantity: number | string | null; note: string | null }

/** Referencia del consumo en Recursos de un material (`source_ref` con `source_app = 'tasks'`). */
export const materialRef = (materialId: Uuid): string => `task_material:${materialId}`;

export function taskMaterials(data: Dataset, taskId: Uuid): TaskMaterialRow[] {
  return live(data['tasks.task_materials']).filter((m) => m.task_id === taskId)
    .sort((a, b) => Number(a.position) - Number(b.position) || a.created_at.localeCompare(b.created_at));
}

function liveTask(data: Dataset, taskId: Uuid) {
  const task = data['tasks.tasks'].find((t) => t.id === taskId && !t.deleted_at);
  if (!task) reject(404, 'NOT_FOUND', 'No existe esa tarea.', { id: taskId });
  return task!;
}
function liveMaterial(data: Dataset, id: Uuid): TaskMaterialRow {
  const row = live(data['tasks.task_materials']).find((m) => m.id === id);
  if (!row) reject(404, 'NOT_FOUND', 'No existe ese material.', { id });
  return row!;
}
const validQuantity = (q: number | null | undefined) => {
  if (q == null) return null;
  if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0) reject(422, 'INVALID_QUANTITY', 'La cantidad debe ser un número mayor que cero.', { field: 'quantity' });
  return round3(q);
};

/** Añadir un artículo a la tarea (si ya está, se suma la cantidad). */
export function addMaterialOps(data: Dataset, input: { taskId: Uuid; itemId: Uuid; quantity?: number | null; note?: string }, newId: NewId = randomId): Operation[] {
  const task = liveTask(data, input.taskId);
  const quantity = validQuantity(input.quantity);
  const existing = taskMaterials(data, task.id).find((m) => m.item_id === input.itemId);
  if (existing) {
    if (existing.consumed != null) reject(422, 'MATERIAL_CONSUMED', 'Ese material ya se gastó en esta tarea.', { id: existing.id });
    if (quantity == null) return [];
    const total = round3(Number(existing.quantity ?? 0) + quantity);
    return [{ op: 'update', table: 'tasks.task_materials', id: existing.id, expectedRevision: existing.revision, fields: { quantity: total } }];
  }
  const position = Math.max(0, ...taskMaterials(data, task.id).map((m) => Number(m.position) || 0)) + POSITION_STEP;
  return [{ op: 'insert', table: 'tasks.task_materials', id: newId(), fields: {
    tab_id: task.tab_id, project_id: task.project_id, task_id: task.id, item_id: input.itemId, quantity, note: (input.note ?? '').slice(0, 500), position,
  } }];
}

/** Cambiar la cantidad prevista (vacía: «lo que haga falta»). Lo gastado ya no cambia. */
export function setMaterialQuantityOps(data: Dataset, id: Uuid, quantity: number | null): Operation[] {
  const row = liveMaterial(data, id);
  if (row.consumed != null) reject(422, 'MATERIAL_CONSUMED', 'Ese material ya se gastó: corrígelo en el inventario.', { id });
  const q = validQuantity(quantity);
  return (row.quantity == null ? null : Number(row.quantity)) === q ? [] : [{ op: 'update', table: 'tasks.task_materials', id, expectedRevision: row.revision, fields: { quantity: q } }];
}

/** Quitar un material o equipo de la tarea (lo gastado se queda: es historia del inventario). */
export function removeMaterialOps(data: Dataset, id: Uuid): Operation[] {
  const row = liveMaterial(data, id);
  if (row.consumed != null && Number(row.consumed) > 0) reject(422, 'MATERIAL_CONSUMED', 'Ese material ya se gastó: se queda en la tarea.', { id });
  return [{ op: 'delete', table: 'tasks.task_materials', id, expectedRevision: row.revision }];
}

/**
 * El kit de los oficios de la tarea que aún no está en ella: un artículo por línea (si dos oficios piden el mismo, la
 * mayor cantidad). `isLive(itemId)` descarta artículos borrados o archivados en Recursos.
 */
export function kitSuggestions(data: Dataset, taskId: Uuid, kit: readonly TradeKitOption[], isLive: (itemId: Uuid) => boolean = () => true): Array<{ itemId: Uuid; quantity: number | null; tradeIds: Uuid[] }> {
  const trades = new Set(live(data['tasks.task_trades']).filter((t) => t.task_id === taskId).map((t) => t.trade_id));
  if (!trades.size) return [];
  const have = new Set(taskMaterials(data, taskId).map((m) => m.item_id));
  const out = new Map<Uuid, { itemId: Uuid; quantity: number | null; tradeIds: Uuid[] }>();
  for (const line of kit) {
    if (!trades.has(line.trade_id) || have.has(line.item_id) || !isLive(line.item_id)) continue;
    const q = line.quantity == null ? null : Number(line.quantity);
    const seen = out.get(line.item_id);
    if (!seen) out.set(line.item_id, { itemId: line.item_id, quantity: q, tradeIds: [line.trade_id] });
    else { seen.tradeIds.push(line.trade_id); if (q != null && (seen.quantity == null || q > seen.quantity)) seen.quantity = q; }
  }
  return [...out.values()];
}

/** Añadir de una vez el kit sugerido. */
export function addKitOps(data: Dataset, taskId: Uuid, suggestions: ReadonlyArray<{ itemId: Uuid; quantity: number | null }>, newId: NewId = randomId): Operation[] {
  const task = liveTask(data, taskId);
  let position = Math.max(0, ...taskMaterials(data, task.id).map((m) => Number(m.position) || 0));
  return suggestions.map((s) => ({ op: 'insert' as const, table: 'tasks.task_materials', id: newId(), fields: {
    tab_id: task.tab_id, project_id: task.project_id, task_id: task.id, item_id: s.itemId, quantity: s.quantity, note: '', position: (position += POSITION_STEP),
  } }));
}

/** Materiales (consumibles) de la tarea sin consumo confirmado: lo que pregunta «Confirmar consumo». */
export function pendingConsumption(data: Dataset, taskId: Uuid, isConsumable: (itemId: Uuid) => boolean): TaskMaterialRow[] {
  return taskMaterials(data, taskId).filter((m) => m.consumed == null && isConsumable(m.item_id));
}

/** La llamada a Recursos que gasta un material: una sola vez por material (`once`), aunque se reintente. */
export function consumeCall(material: TaskMaterialRow, quantity: number, defaultSpaceId?: Uuid | null): Operation {
  if (!(quantity > 0)) reject(422, 'INVALID_QUANTITY', 'Lo gastado debe ser mayor que cero.', { id: material.id });
  return { op: 'call', procedure: 'resources.consume', args: {
    item_id: material.item_id, quantity: round3(quantity), kind: 'consumo_tarea', source_app: 'tasks', source_ref: materialRef(material.id), once: true,
    ...(defaultSpaceId ? { default_space_id: defaultSpaceId } : {}),
  } } as Operation;
}

/** Apuntar en Tasks lo gastado de cada material (0 = «No se usó»). Solo los que aún no lo tienen. */
export function confirmConsumptionOps(data: Dataset, lines: ReadonlyArray<{ materialId: Uuid; consumed: number }>): Operation[] {
  return lines.flatMap(({ materialId, consumed }) => {
    const row = liveMaterial(data, materialId);
    if (row.consumed != null) return [];
    if (typeof consumed !== 'number' || !Number.isFinite(consumed) || consumed < 0) reject(422, 'INVALID_QUANTITY', 'Lo gastado no puede ser negativo.', { id: materialId });
    return [{ op: 'update' as const, table: 'tasks.task_materials', id: row.id, expectedRevision: row.revision, fields: { consumed: round3(consumed) } }];
  });
}
