/**
 * Ikisai Central · Revisión (tanda 27, MUELA-027; migración `1512`, docs/central/API.md §2.14): el avance de cada pantalla en
 * los diez pasos del cuadro y su feedback. El feedback se une a su pantalla por el prefijo de sus ids de feedback o por su
 * ruta; así no hace falta un dato nuevo en el kit.
 */

export const REVIEW_SCREENS_TABLE = 'central.review_screens';

/** Los diez pasos del cuadro de avance, en orden y con sus nombres tal cual (VG, 15-10-2026). */
export const REVIEW_STEPS = ['cal', 'fuera', 'sin', 'hoy', 'alt', 'demo', 'listo', 'cons', 'aprob', 'hecha'] as const;
export type ReviewStep = typeof REVIEW_STEPS[number];
export const REVIEW_STEP_LABELS: Record<ReviewStep, string> = {
  cal: 'Sevilla la está tocando', fuera: 'Sin agente', sin: 'Sin empezar', hoy: 'En estudio', alt: 'Prototipo hecho: te toca valorarlo',
  demo: 'Montaje: se hace la demo', listo: 'Demo hecha: te toca validarla', cons: 'Construcción', aprob: 'Aprobada', hecha: 'Pasada a Sevilla',
};
/** Pasos en los que la pantalla espera a quien administra. */
export const REVIEW_STEPS_TO_ACT: readonly ReviewStep[] = ['alt', 'listo'];

export const REVIEW_APPS = ['central', 'tasks', 'invoices', 'booking', 'food', 'guests', 'organizers', 'resources', 'transversal'] as const;
export const REVIEW_APP_LABELS: Record<string, string> = {
  central: 'Central', tasks: 'Tasks', invoices: 'Finance', booking: 'Booking', food: 'Food', guests: 'Guests', organizers: 'Organizers',
  resources: 'Recursos', transversal: 'Común',
};

export interface ReviewScreenLike {
  id: string; app: string; name: string; step: string; route?: string | null; feedback_prefix?: string | null; position?: number | null;
  deleted_at?: string | null;
}
/** Lo que se usa de un reporte de feedback (`GET feedback`): app de origen, id del nodo y ruta de donde se mandó. */
export interface ReportLike { originApp: string; node?: { id?: string | null } | null; sourceRoute?: string | null }

export const stepIndex = (step: string) => (REVIEW_STEPS as readonly string[]).indexOf(step);

/** Pantallas vivas en el orden del cuadro: por app (orden de `REVIEW_APPS`), su posición y su nombre. */
export function sortScreens<T extends ReviewScreenLike>(rows: readonly T[]): T[] {
  const app = (a: string) => { const i = (REVIEW_APPS as readonly string[]).indexOf(a); return i < 0 ? 99 : i; };
  return rows.filter((s) => !s.deleted_at)
    .sort((a, b) => app(a.app) - app(b.app) || (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name, 'es'));
}

/** Recuento por paso, con los diez pasos aunque estén a cero. */
export function stepCounts(rows: readonly ReviewScreenLike[]): Record<ReviewStep, number> {
  const out = Object.fromEntries(REVIEW_STEPS.map((s) => [s, 0])) as Record<ReviewStep, number>;
  for (const s of rows) if (!s.deleted_at && stepIndex(s.step) >= 0) out[s.step as ReviewStep]++;
  return out;
}

/** «33 de 92 pantallas pasadas a Sevilla». */
export function reviewProgress(rows: readonly ReviewScreenLike[]): { done: number; total: number } {
  const live = rows.filter((s) => !s.deleted_at);
  return { done: live.filter((s) => s.step === 'hecha').length, total: live.length };
}

/** Las pantallas que esperan a quien administra (valorar el prototipo o validar la demo), en el orden del cuadro. */
export function screensToAct<T extends ReviewScreenLike>(rows: readonly T[]): T[] {
  return sortScreens(rows).filter((s) => REVIEW_STEPS_TO_ACT.includes(s.step as ReviewStep));
}

const prefixMatch = (id: string, prefix: string) => id === prefix || id.startsWith(prefix + '.');
// `#/` es Inicio: solo esa ruta, no todas las que empiezan por ella.
const routeMatch = (route: string, prefix: string) => {
  const base = prefix.replace(/\/+$/, '');
  if (base === '#') return route === '#/' || route === '#';
  return route === base || route.startsWith(base + '/') || route.startsWith(base + '?');
};

/**
 * La pantalla de un reporte: de su app, la de prefijo de feedback más largo que encaje con el id del nodo; si no, la de ruta
 * más larga que encaje con la ruta de donde se mandó. Sin ninguna, null («Sin pantalla» dentro de su app).
 */
export function screenOfReport<T extends ReviewScreenLike>(report: ReportLike, rows: readonly T[]): T | null {
  const mine = rows.filter((s) => !s.deleted_at && s.app === report.originApp);
  const node = report.node?.id ?? '';
  const byNode = node
    ? mine.filter((s) => s.feedback_prefix && prefixMatch(node, s.feedback_prefix)).sort((a, b) => b.feedback_prefix!.length - a.feedback_prefix!.length)[0]
    : undefined;
  if (byNode) return byNode;
  const route = report.sourceRoute ?? '';
  const byRoute = route
    ? mine.filter((s) => s.route && routeMatch(route, s.route)).sort((a, b) => b.route!.length - a.route!.length)[0]
    : undefined;
  return byRoute ?? null;
}
