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

const VERB = { add: 'Montar', remove: 'Retirar', replace: 'Sustituir' } as const;

/** Nombres para los títulos, a partir de `plans_with_decor` (iconos y planos). */
export interface MontageNames { icon: (id: string | null) => string; plan: (id: string) => string }

/** La referencia de la reserva en Tasks (la misma que el proyecto del retiro, B13). */
export const reservationRef = (code: string): string => `RES${code.replace(/[^A-Za-z0-9_.:-]/g, '')}`;

/**
 * La petición a Tasks (docs/tasks/API.md §42, `worker/requests/task`): la madre «Montaje del evento» en el proyecto de la
 * reserva y una hija por cambio, con la lista ENTERA cada vez (Tasks crea, actualiza o retira). `external_ref` estable:
 * el de la reserva para la madre y el id de la fila del cambio para cada hija.
 */
export function montageRequest(reservation: { id: string; code: string; title: string; start_date: string | null }, changes: readonly MontageChange[], names: MontageNames) {
  const project = reservationRef(reservation.code);
  const due = reservation.start_date ? String(reservation.start_date).slice(0, 10) : undefined;
  return {
    source: 'booking', kind: 'booking.event_setup', external_ref: `${project}-MONTAJE`, project_ref: project,
    title: 'Montaje del evento',
    note: `${reservation.title}: ${changes.length} ${changes.length === 1 ? 'cambio' : 'cambios'} sobre la decoración general.`.slice(0, 1000),
    ...(due ? { due } : {}),
    external_url: `https://booking.ikisai.com/#/reservas/${reservation.id}`,
    children: changes.map((c) => {
      const what = c.op === 'replace' ? `${names.icon(c.replacesIconId)} por ${names.icon(c.iconId)}`
        : c.op === 'remove' ? names.icon(c.replacesIconId) : names.icon(c.iconId);
      return { external_ref: c.id, title: `${VERB[c.op]}: ${what} (${names.plan(c.planId)})`.slice(0, 120), ...(due ? { due } : {}) };
    }),
  };
}

/** Nombres de iconos y planos a partir de lo que devuelve `resources.plans_with_decor`. */
export function namesFrom(out: { icons?: Array<{ id: string; name?: string | null }>; plans?: Array<{ id: string; label?: string | null; buildingId?: string | null; floor?: string | number | null }>; spaces?: Array<{ id: string; name?: string | null }> }): MontageNames {
  const icons = new Map((out.icons ?? []).map((i) => [i.id, i.name ?? 'objeto']));
  const spaces = new Map((out.spaces ?? []).map((sp) => [sp.id, sp.name ?? '']));
  const plans = new Map((out.plans ?? []).map((pl) => [pl.id, pl.label || [pl.buildingId ? spaces.get(pl.buildingId) : null, pl.floor !== null && pl.floor !== undefined ? `planta ${pl.floor}` : null].filter(Boolean).join(' · ') || 'plano']));
  return { icon: (id) => (id ? icons.get(id) ?? 'objeto' : 'objeto'), plan: (id) => plans.get(id) ?? 'plano' };
}

