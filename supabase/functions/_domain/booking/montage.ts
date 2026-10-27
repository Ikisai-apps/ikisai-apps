/**
 * «Montaje» del evento (encargo de VG, 27-10-2026; diseño en DECORACION_Y_FINCA.md; datos de Recursos, API §2.7): la
 * decoración específica de un evento son filas de `resources.decor_items` en la capa `event` (añadir, quitar o
 * sustituir una pieza general), y cada cambio es una tarea hija de «Montaje del evento» en Tasks. Sin DOM ni red.
 */

/** Una fila de decoración tal como la da `resources.plans_with_decor` (las dos capas sin resolver). */
export interface DecorRow {
  id: string; planId: string; iconId: string | null; cellX: number; cellY: number; scale: number; size: 1 | 4; rotation: number;
  layer: 'general' | 'event'; eventId: string | null; op: 'add' | 'remove' | 'replace'; replacesItemId: string | null;
}

/** Lo que se dibuja para el evento: la general con sus cambios (lo quitado no sale; lo sustituido sale con su sustituto). */
export function resolveEventDecor(rows: readonly DecorRow[], eventId: string): DecorRow[] {
  const general = rows.filter((r) => r.layer === 'general');
  const event = rows.filter((r) => r.layer === 'event' && r.eventId === eventId);
  const touched = new Set(event.filter((r) => r.op !== 'add' && r.replacesItemId).map((r) => r.replacesItemId!));
  return [...general.filter((g) => !touched.has(g.id)), ...event.filter((r) => r.op !== 'remove')];
}

/** Un cambio del evento, listo para su tarea: qué se hace, con qué icono y sobre qué pieza general. */
export interface MontageChange { id: string; planId: string; op: 'add' | 'remove' | 'replace'; iconId: string | null; replacesIconId: string | null }

/** Los cambios del evento sobre la general, en orden estable (añadir, sustituir, quitar; y por id). */
export function eventChanges(rows: readonly DecorRow[], eventId: string): MontageChange[] {
  const byId = new Map(rows.filter((r) => r.layer === 'general').map((r) => [r.id, r]));
  const rank = { add: 0, replace: 1, remove: 2 } as const;
  return rows.filter((r) => r.layer === 'event' && r.eventId === eventId)
    .map((r) => ({ id: r.id, planId: r.planId, op: r.op, iconId: r.op === 'remove' ? null : r.iconId, replacesIconId: r.replacesItemId ? byId.get(r.replacesItemId)?.iconId ?? null : null }))
    .sort((a, b) => rank[a.op] - rank[b.op] || a.id.localeCompare(b.id));
}

/** Una tarea para Tasks: la padre del evento y una hija por cambio. */
export interface MontageTask { external_ref: string; parent_external_ref: string | null; title: string; note: string | null; due: string | null }

const VERB = { add: 'Montar', remove: 'Retirar', replace: 'Sustituir' } as const;

/**
 * Las tareas de montaje de un evento: una padre «Montaje del evento» y una hija por cambio. `external_ref` estable (el
 * código del evento y el id de la fila del cambio): pedir dos veces no duplica, y un cambio que se deshace deja de estar
 * en la lista (quien llama retira la hija que sobra). Sin cambios, ninguna.
 */
export function montageTasks(
  event: { code: string; title: string; start_date: string | null },
  changes: readonly MontageChange[],
  names: { icon: (id: string | null) => string; plan: (id: string) => string },
): MontageTask[] {
  if (changes.length === 0) return [];
  const parent = `${event.code}-MONTAJE`;
  const children = changes.map((c): MontageTask => {
    const what = c.op === 'replace' ? `${names.icon(c.replacesIconId)} por ${names.icon(c.iconId)}`
      : c.op === 'remove' ? names.icon(c.replacesIconId) : names.icon(c.iconId);
    return { external_ref: `${parent}-${c.id}`, parent_external_ref: parent, title: `${VERB[c.op]}: ${what} (${names.plan(c.planId)})`.slice(0, 500), note: null, due: event.start_date };
  });
  return [{ external_ref: parent, parent_external_ref: null, title: `Montaje del evento · ${event.title}`.slice(0, 500),
    note: `${children.length} ${children.length === 1 ? 'cambio' : 'cambios'} sobre la decoración general.`, due: event.start_date }, ...children];
}
