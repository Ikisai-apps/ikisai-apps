/**
 * Estado de cada apartado de la Experiencia (pasada única, zona 3): qué ven tus asistentes, qué falta y qué llega más
 * adelante. Se **deriva** de lo leído (espejo propio, programa y alojamiento de Booking, menú de Food) y nunca se guarda.
 * Puro y sin navegador (`tests/organizers/experience-state.test.ts`): devuelve claves en español (`textKey`, `extraKey`,
 * `nextKey`) con sus variables, y la pantalla las traduce con `t()`.
 */

/** Marca un texto que se traduce al pintarlo (como `L` de `i18n.ts`, sin depender del kit). */
const L = (spanish: string): string => spanish;

export type SectionKey = 'programa' | 'menu' | 'alojamiento' | 'materiales' | 'preguntas' | 'plano';
export type SectionStateName = 'loading' | 'unknown' | 'later' | 'todo' | 'ok' | 'hidden' | 'vacio';
type Vars = Record<string, string | number>;

export interface SectionState {
  state: SectionStateName;
  textKey: string;
  vars?: Vars;
  extraKey?: string;
  extraVars?: Vars;
  /** Cosas por decidir (camas pedidas), para la marca de la subnavegación. */
  count?: number;
  /** El título del paso cuando está por hacer. */
  nextKey?: string;
  /** Ventana en que lo ven (`before`, `during`, `after`), si no es «siempre». */
  window?: string;
}

/** Una lectura: el valor, `{ error: código }` o `null` mientras se lee. */
export type Read<T> = T | { error: string } | null;

type RowLike = Record<string, unknown>;
interface ProgramLike { confirmed: boolean; items: Array<{ day: string }> }
interface MenuLike { available: boolean; status: string; services: unknown[] }
interface BedLike { kind: string; guest_id?: string | null; group_label?: string | null; status?: string }
interface RoomsLike { rooms: Array<{ beds: BedLike[] }>; pending: unknown[] }

export interface SectionsInput {
  exp: RowLike | null;
  materials: RowLike[];
  questions: RowLike[];
  answers: RowLike[];
  program: Read<ProgramLike>;
  menu: Read<MenuLike>;
  rooms: Read<RoomsLike>;
  /** Comentarios tuyos a cocina (opcional). */
  comments?: number | null;
}

/** Casilla «Lo ven tus asistentes» de cada apartado en la experiencia (`organizers.experiences`). */
export const MODULE_OF: Record<SectionKey, string> = {
  programa: 'program_visible', menu: 'menu_visible', alojamiento: 'lodging_visible', materiales: 'materials_visible', preguntas: 'questions_visible', plano: 'map_visible',
};
/** Orden de «Lo siguiente» (el plano no cuenta). */
export const NEXT_ORDER: readonly SectionKey[] = ['materiales', 'preguntas', 'programa', 'alojamiento', 'menu'];

const isError = (x: unknown): x is { error: string } => !!x && typeof x === 'object' && 'error' in x;
const visible = (exp: RowLike | null, key: SectionKey) => exp?.[MODULE_OF[key]] === true;
const windowOf = (exp: RowLike | null, key: string) => {
  const w = exp?.[key];
  return typeof w === 'string' && w !== 'always' ? w : undefined;
};
const shown = (exp: RowLike | null, key: SectionKey): 'ok' | 'hidden' => (visible(exp, key) ? 'ok' : 'hidden');

function program(input: SectionsInput): SectionState {
  const p = input.program;
  if (p === null) return { state: 'loading', textKey: L('…') };
  if (isError(p)) return { state: 'unknown', textKey: L('No se ha podido leer.') };
  if (!p.confirmed) return { state: 'later', textKey: L('Cuando la reserva esté confirmada') };
  if (!p.items.length) return { state: 'todo', textKey: L('Aún sin actividades'), nextKey: L('Añade la primera actividad') };
  const n = p.items.length;
  const d = new Set(p.items.map((i) => i.day)).size;
  const textKey = n === 1 ? L('1 actividad en 1 día') : d === 1 ? L('{n} actividades en 1 día') : L('{n} actividades en {d} días');
  return { state: shown(input.exp, 'programa'), textKey, vars: { n, d }, window: windowOf(input.exp, 'program_window') };
}

function menu(input: SectionsInput): SectionState {
  const m = input.menu;
  if (m === null) return { state: 'loading', textKey: L('…') };
  if (isError(m)) return { state: 'unknown', textKey: L('No se ha podido leer.') };
  if (!m.available) return { state: 'later', textKey: L('La cocina aún no lo ha compartido') };
  const n = m.services.length;
  const confirmed = m.status === 'confirmado';
  const textKey = confirmed ? (n === 1 ? L('Confirmado · 1 servicio') : L('Confirmado · {n} servicios')) : (n === 1 ? L('Provisional · 1 servicio') : L('Provisional · {n} servicios'));
  const c = input.comments ?? 0;
  return {
    state: shown(input.exp, 'menu'), textKey, vars: { n }, window: windowOf(input.exp, 'menu_window'),
    ...(c > 0 ? { extraKey: c === 1 ? L('1 comentario tuyo a cocina') : L('{n} comentarios tuyos a cocina'), extraVars: { n: c } } : {}),
  };
}

function lodging(input: SectionsInput): SectionState {
  const r = input.rooms;
  if (r === null) return { state: 'loading', textKey: L('…') };
  if (isError(r)) return r.error === 'EVENT_REQUIRED' ? { state: 'later', textKey: L('Cuando la reserva esté confirmada') } : { state: 'unknown', textKey: L('No se ha podido leer.') };
  if (!r.rooms.length) return { state: 'later', textKey: L('Ikisai aún no ha asignado habitaciones') };
  const beds = r.rooms.flatMap((room) => room.beds);
  const taken = (b: BedLike) => !!(b.guest_id || b.group_label);
  // Las supletorias cuentan solo si están ocupadas; lo pedido sin aprobar no cuenta como cama asignada.
  const total = beds.filter((b) => b.kind !== 'supletoria' || taken(b)).length;
  const assigned = beds.filter((b) => !!b.guest_id && b.status !== 'requested').length;
  const vars = { a: assigned, n: total };
  const pending = r.pending.length;
  if (pending > 0) {
    return {
      state: 'todo', textKey: L('{a} de {n} con cama'), vars, count: pending, nextKey: L('Aprobar las camas pedidas'),
      extraKey: pending === 1 ? L('1 cama pedida por aprobar') : L('{n} camas pedidas por aprobar'), extraVars: { n: pending },
    };
  }
  return { state: shown(input.exp, 'alojamiento'), textKey: L('{a} de {n} con cama'), vars };
}

function materials(input: SectionsInput): SectionState {
  const all = input.materials.filter((m) => m.is_logo !== true || m.published === true);
  const n = all.length;
  if (!n) return { state: 'vacio', textKey: L('Aún no has añadido materiales') };
  const published = all.filter((m) => m.published === true);
  const p = published.length;
  if (!p) return { state: 'todo', textKey: n === 1 ? L('1 sin publicar') : L('{n} sin publicar'), vars: { n }, nextKey: L('Publicar tus materiales') };
  const windows = new Set(published.map((m) => (typeof m.window === 'string' ? m.window : 'always')));
  const window = windows.size === 1 ? [...windows][0] : undefined;
  const textKey = p === n ? (n === 1 ? L('1 publicado') : L('{n} publicados')) : L('{p} de {n} publicados');
  return { state: shown(input.exp, 'materiales'), textKey, vars: { n, p }, window: window && window !== 'always' ? window : undefined };
}

function questions(input: SectionsInput): SectionState {
  const n = input.questions.length;
  if (!n) return { state: 'vacio', textKey: L('Aún no has creado preguntas') };
  const p = input.questions.filter((q) => q.published === true).length;
  if (!p) return { state: 'todo', textKey: n === 1 ? L('1 sin publicar') : L('{n} sin publicar'), vars: { n }, nextKey: L('Publicar tus preguntas') };
  const r = input.answers.length;
  const textKey = n === 1
    ? (r === 1 ? L('1 pregunta · 1 respuesta') : L('1 pregunta · {r} respuestas'))
    : (r === 1 ? L('{n} preguntas · 1 respuesta') : L('{n} preguntas · {r} respuestas'));
  return { state: shown(input.exp, 'preguntas'), textKey, vars: { n, r } };
}

export function sectionsOf(input: SectionsInput): Record<SectionKey, SectionState> {
  return {
    programa: program(input),
    menu: menu(input),
    alojamiento: lodging(input),
    materiales: materials(input),
    preguntas: questions(input),
    plano: { state: shown(input.exp, 'plano'), textKey: L('Cómo llegar y moverse por el centro') },
  };
}

/** Los apartados que van en «Lo siguiente», en su orden: primero los ocultos, luego los que faltan y luego los que ya ven. */
export function stepsOf(sections: Record<SectionKey, SectionState>): SectionKey[] {
  const rank: Partial<Record<SectionStateName, number>> = { hidden: 0, todo: 1, ok: 2 };
  return NEXT_ORDER.filter((k) => rank[sections[k].state] !== undefined)
    .sort((a, b) => rank[sections[a].state]! - rank[sections[b].state]! || NEXT_ORDER.indexOf(a) - NEXT_ORDER.indexOf(b));
}

/** Lo siguiente: el primer oculto o, si no hay, el primero por hacer. */
export function nextOf(sections: Record<SectionKey, SectionState>): SectionKey | null {
  return NEXT_ORDER.find((k) => sections[k].state === 'hidden') ?? NEXT_ORDER.find((k) => sections[k].state === 'todo') ?? null;
}
