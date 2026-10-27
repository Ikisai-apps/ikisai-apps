/**
 * «Montaje» del evento (encargo de VG, 27-10-2026; diseño en DECORACION_Y_FINCA.md): la decoración específica de un
 * evento se describe como cambios sobre la general de cada plano (añadir, quitar o sustituir un objeto), y cada cambio es
 * una tarea hija de «Montaje del evento» en Tasks. Sin DOM ni red: lo usan la ficha y la Edge.
 */

/** Un objeto de la decoración general de un plano (Recursos). */
export interface DecorItem { item_id: string; icon_id: string; x: number; y: number; size: 1 | 4; rot?: number; label?: string | null }

/** Un cambio del evento sobre la general. `replace` cambia el icono (y, si viene, el sitio) de un objeto que ya está. */
export type DecorChange =
  | { op: 'add'; key: string; icon_id: string; x: number; y: number; size: 1 | 4; rot?: number; label?: string | null }
  | { op: 'remove'; item_id: string; label?: string | null }
  | { op: 'replace'; item_id: string; icon_id: string; x?: number; y?: number; size?: 1 | 4; rot?: number; label?: string | null };

export interface DecorEdit { plan_id: string; plan_label?: string | null; changes: DecorChange[] }

/** La clave estable de un cambio (para la tarea hija idempotente): el objeto que toca, o la clave del nuevo. */
export const changeKey = (c: DecorChange): string => (c.op === 'add' ? `add:${c.key}` : `${c.op}:${c.item_id}`);

/**
 * Normaliza los cambios de un plano frente a su general:
 * - fuera los que no tocan nada (quitar o sustituir un objeto que no está en la general; sustituir por el mismo icono y sitio);
 * - un objeto, como mucho un cambio (el último manda);
 * - orden estable: añadir, sustituir y quitar, y dentro por clave.
 */
export function normalizeChanges(general: readonly DecorItem[], changes: readonly DecorChange[]): DecorChange[] {
  const byId = new Map(general.map((g) => [g.item_id, g]));
  const last = new Map<string, DecorChange>();
  for (const c of changes) {
    if (c.op !== 'add') {
      const g = byId.get(c.item_id);
      if (!g) continue;
      if (c.op === 'replace' && c.icon_id === g.icon_id && (c.x ?? g.x) === g.x && (c.y ?? g.y) === g.y && (c.size ?? g.size) === g.size && (c.rot ?? g.rot ?? 0) === (g.rot ?? 0)) {
        last.delete(changeKey(c));
        continue;
      }
    }
    // un objeto de la general: el último cambio sustituye a los anteriores (quitar y luego sustituir = sustituir)
    if (c.op !== 'add') { last.delete(`remove:${c.item_id}`); last.delete(`replace:${c.item_id}`); }
    last.set(changeKey(c), c);
  }
  const rank = { add: 0, replace: 1, remove: 2 } as const;
  return [...last.values()].sort((a, b) => rank[a.op] - rank[b.op] || changeKey(a).localeCompare(changeKey(b)));
}

/** La decoración que se pinta para el evento: la general con sus cambios. */
export function applyChanges(general: readonly DecorItem[], changes: readonly DecorChange[]): DecorItem[] {
  const out = new Map(general.map((g) => [g.item_id, { ...g }]));
  for (const c of normalizeChanges(general, changes)) {
    if (c.op === 'remove') out.delete(c.item_id);
    else if (c.op === 'replace') {
      const g = out.get(c.item_id)!;
      out.set(c.item_id, { ...g, icon_id: c.icon_id, x: c.x ?? g.x, y: c.y ?? g.y, size: c.size ?? g.size, rot: c.rot ?? g.rot, label: c.label ?? g.label });
    } else out.set(`add:${c.key}`, { item_id: `add:${c.key}`, icon_id: c.icon_id, x: c.x, y: c.y, size: c.size, rot: c.rot, label: c.label ?? null });
  }
  return [...out.values()];
}

/** Una tarea para Tasks («Pedir a Tasks»): la padre del evento y una hija por cambio. */
export interface MontageTask { external_ref: string; parent_external_ref: string | null; title: string; note: string | null; due: string | null }

const VERB = { add: 'Montar', remove: 'Retirar', replace: 'Sustituir' } as const;

/**
 * Las tareas de montaje de un evento: una padre «Montaje del evento» y una hija por cada cambio de cada plano.
 * `external_ref` estable (código del evento + plano + clave del cambio): pedir dos veces no duplica, y un cambio que se
 * deshace deja de estar en la lista (quien llama retira la hija que sobra).
 */
export function montageTasks(event: { code: string; title: string; start_date: string | null }, edits: readonly DecorEdit[], general: ReadonlyMap<string, readonly DecorItem[]>): MontageTask[] {
  const parent = `${event.code}-MONTAJE`;
  const children: MontageTask[] = [];
  for (const edit of [...edits].sort((a, b) => a.plan_id.localeCompare(b.plan_id))) {
    const base = general.get(edit.plan_id) ?? [];
    const byId = new Map(base.map((g) => [g.item_id, g]));
    for (const c of normalizeChanges(base, edit.changes)) {
      const what = c.label ?? (c.op === 'add' ? 'objeto' : byId.get(c.item_id)?.label ?? 'objeto');
      children.push({
        external_ref: `${parent}-${edit.plan_id.slice(0, 8)}-${changeKey(c).replace(':', '-').slice(0, 60)}`,
        parent_external_ref: parent,
        title: `${VERB[c.op]}: ${what}${edit.plan_label ? ` (${edit.plan_label})` : ''}`.slice(0, 500),
        note: null,
        due: event.start_date,
      });
    }
  }
  if (children.length === 0) return [];
  return [{ external_ref: parent, parent_external_ref: null, title: `Montaje del evento · ${event.title}`.slice(0, 500), note: `${children.length} ${children.length === 1 ? 'cambio' : 'cambios'} sobre la decoración general.`, due: event.start_date }, ...children];
}
