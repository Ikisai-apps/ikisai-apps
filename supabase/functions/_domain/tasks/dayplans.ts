/**
 * Tasks · «Plan de hoy» (MUELA-095; migración 0339; docs/tasks/API.md §38): operaciones puras sobre `tasks.day_plans`.
 * Un plan por persona y día, privado. Sus elementos son tareas (`task_id`) o textos «solo hoy» (`text`, con `done`), en el
 * orden de quien lo hace. Poner, quitar, ordenar o traer de ayer son escrituras del plan, nunca de la tarea; «Llevar a…»
 * crea la tarea con su operación de siempre y la fila del plan pasa a apuntarla (`linkPlanItem`).
 */
import { POSITION_STEP, reject, type Dataset, type DayPlanItem, type DayPlanRow, type Operation, type Uuid } from './types.ts';
import { DAY_PLAN_MAX_ITEMS, DAY_PLAN_TEXT_MAX } from './validate.ts';
import type { NewId } from './ops.ts';

const randomId: NewId = () => crypto.randomUUID();
const byPosition = (a: DayPlanItem, b: DayPlanItem) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** El plan vivo de una persona para un día (`AAAA-MM-DD`), o `null`. */
export function dayPlanFor(data: Dataset, actorId: Uuid, day: string): DayPlanRow | null {
  return (data['tasks.day_plans'] ?? []).find((p) => !p.deleted_at && p.actor_id === actorId && p.day === day) ?? null;
}

/** Sus elementos, en su orden. */
export function dayPlanItems(plan: DayPlanRow | null | undefined): DayPlanItem[] {
  return Array.isArray(plan?.items) ? [...plan!.items].sort(byPosition) : [];
}

/** El plan anterior más reciente (otro día antes de `day`), para «De ayer quedaron…». */
export function previousDayPlan(data: Dataset, actorId: Uuid, day: string): DayPlanRow | null {
  return (data['tasks.day_plans'] ?? []).filter((p) => !p.deleted_at && p.actor_id === actorId && p.day < day)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))[0] ?? null;
}

/** Renumera con paso fijo, en el orden recibido. */
function renumbered(items: readonly DayPlanItem[]): DayPlanItem[] {
  return items.map((it, i) => ({ ...it, position: (i + 1) * POSITION_STEP }));
}

function room(items: readonly DayPlanItem[], extra = 1): void {
  if (items.length + extra > DAY_PLAN_MAX_ITEMS) reject(422, 'INVALID_PLAN', `En el plan de hoy caben ${DAY_PLAN_MAX_ITEMS} cosas.`, { max: DAY_PLAN_MAX_ITEMS });
}

/** Una tarea al final del plan (si ya está, el plan no cambia). */
export function planWithTask(items: readonly DayPlanItem[], task: { id: Uuid; tab_id?: Uuid | null }, newId: NewId = randomId): DayPlanItem[] {
  const list = [...items].sort(byPosition);
  if (list.some((it) => it.task_id === task.id)) return list;
  room(list);
  return renumbered([...list, { id: newId(), task_id: task.id, tab_id: task.tab_id ?? null, position: 0 }]);
}

/** Varias tareas al final, en orden (las que ya están, se saltan). */
export function planWithTasks(items: readonly DayPlanItem[], tasks: ReadonlyArray<{ id: Uuid; tab_id?: Uuid | null }>, newId: NewId = randomId): DayPlanItem[] {
  return tasks.reduce<DayPlanItem[]>((list, task) => planWithTask(list, task, newId), [...items]);
}

/** Un texto «solo hoy» al final. */
export function planWithText(items: readonly DayPlanItem[], text: string, newId: NewId = randomId, tabId: Uuid | null = null): DayPlanItem[] {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > DAY_PLAN_TEXT_MAX) reject(422, 'INVALID_PLAN', `Escribe qué vas a hacer (hasta ${DAY_PLAN_TEXT_MAX} caracteres).`, { max: DAY_PLAN_TEXT_MAX });
  const list = [...items].sort(byPosition);
  room(list);
  return renumbered([...list, { id: newId(), text: clean, tab_id: tabId, position: 0, done: false }]);
}

/** Sin ese elemento (la tarea sigue donde estaba). */
export function planWithout(items: readonly DayPlanItem[], itemId: Uuid): DayPlanItem[] {
  return renumbered([...items].sort(byPosition).filter((it) => it.id !== itemId));
}

/** Sin esa tarea. */
export function planWithoutTask(items: readonly DayPlanItem[], taskId: Uuid): DayPlanItem[] {
  return renumbered([...items].sort(byPosition).filter((it) => it.task_id !== taskId));
}

/** Hecho o no de un texto «solo hoy» (las tareas se marcan en la tarea, con `toggleTask`). */
export function planWithTextDone(items: readonly DayPlanItem[], itemId: Uuid, done: boolean): DayPlanItem[] {
  return [...items].sort(byPosition).map((it) => (it.id === itemId && 'text' in it ? { ...it, done } : it));
}

/** En el orden de `ids` (los que falten se quedan detrás, en el suyo). */
export function planInOrder(items: readonly DayPlanItem[], ids: readonly Uuid[]): DayPlanItem[] {
  const list = [...items].sort(byPosition), rank = new Map(ids.map((id, i) => [id, i]));
  return renumbered(list.map((it, i) => ({ it, i })).sort((a, b) => (rank.get(a.it.id) ?? ids.length + a.i) - (rank.get(b.it.id) ?? ids.length + b.i)).map((x) => x.it));
}

/** «Llevar a…»: el texto «solo hoy» pasa a apuntar a la tarea real recién creada, en el mismo sitio del plan. */
export function linkPlanItem(items: readonly DayPlanItem[], itemId: Uuid, task: { id: Uuid; tab_id?: Uuid | null }): DayPlanItem[] {
  const list = [...items].sort(byPosition);
  if (list.some((it) => it.task_id === task.id && it.id !== itemId)) return planWithout(list, itemId);
  return list.map((it) => (it.id === itemId ? { id: it.id, task_id: task.id, tab_id: task.tab_id ?? null, position: it.position } : it));
}

/** Deshace un `linkPlanItem`: vuelve a ser el texto de antes. */
export function unlinkPlanItem(items: readonly DayPlanItem[], before: DayPlanItem): DayPlanItem[] {
  const list = [...items].sort(byPosition);
  return list.some((it) => it.id === before.id) ? list.map((it) => (it.id === before.id ? { ...before } : it)) : renumbered([...list, before]);
}

/** Comparación sin depender del orden de las claves (jsonb las guarda en el suyo). */
const canonical = (it: DayPlanItem) => [it.id, it.task_id ?? null, it.text ?? null, it.tab_id ?? null, it.position, it.done ?? null];
const sameItems = (a: readonly DayPlanItem[], b: readonly DayPlanItem[]) => JSON.stringify(a.map(canonical)) === JSON.stringify(b.map(canonical));

/**
 * Las operaciones que dejan el plan de `actorId` para `day` con estos elementos (y, si se dice, `reviewed`). Sin plan, lo
 * crea; si no cambia nada, no hay operaciones. Solo escribe el plan.
 */
export function saveDayPlanOps(data: Dataset, actorId: Uuid, day: string, items: readonly DayPlanItem[], options: { reviewed?: boolean; newId?: NewId } = {}): Operation[] {
  const plan = dayPlanFor(data, actorId, day);
  const next = renumbered([...items].sort(byPosition));
  if (!plan) {
    if (!next.length && options.reviewed === undefined) return [];
    return [{ op: 'insert', table: 'tasks.day_plans', id: (options.newId ?? randomId)(), fields: { actor_id: actorId, day, items: next, reviewed: options.reviewed ?? false } }];
  }
  const fields: Record<string, unknown> = {};
  if (!sameItems(dayPlanItems(plan), next)) fields.items = next;
  if (options.reviewed !== undefined && options.reviewed !== plan.reviewed) fields.reviewed = options.reviewed;
  return Object.keys(fields).length ? [{ op: 'update', table: 'tasks.day_plans', id: plan.id, expectedRevision: plan.revision, fields }] : [];
}
