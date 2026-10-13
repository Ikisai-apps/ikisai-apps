/**
 * Ikisai Food · elaboración en pasos y antelación con unidad (FB_2026_028, decisión del usuario del 13-10-2026;
 * docs/food/API.md §2.1).
 *
 * - `recipes.method_steps`: lista de pasos `{id, text, steps?}` anidable en dos niveles (pasos y subpasos), en el orden en
 *   que se hacen. Se numera al mostrarla (1, 1.1, 1.2, 2…). `recipes.method` guarda el mismo texto ya numerado, para quien
 *   lea la receta sin entender los pasos (agentes, versiones anteriores de la app).
 * - `recipes.prep_minutes`: antelación en minutos; 0 es «En el momento» y null, sin indicar. En pantalla se escribe y se
 *   enseña como número y unidad (minutos, horas o días).
 */

export interface MethodStep {
  id: string;
  text: string;
  /** Subpasos (solo en el primer nivel). */
  steps?: MethodStep[];
}

export const METHOD_STEP_MAX = 500;
export const METHOD_STEPS_MAX = 100;
/** Antelación máxima: siete días. */
export const PREP_MINUTES_MAX = 7 * 24 * 60;

export const PREP_UNITS = ['minutos', 'horas', 'dias'] as const;
export type PrepUnit = (typeof PREP_UNITS)[number];
const UNIT_MINUTES: Record<PrepUnit, number> = { minutos: 1, horas: 60, dias: 1440 };

/** Problema de una lista de pasos, o null si es válida (forma, profundidad, textos y número de pasos). */
export function methodStepsProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return 'debe ser una lista de pasos';
  let count = 0;
  const check = (list: unknown[], depth: number): string | null => {
    for (const step of list) {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return 'tiene un paso que no es un objeto';
      const { id, text, steps, ...rest } = step as Record<string, unknown>;
      if (Object.keys(rest).length) return `tiene un campo desconocido (${Object.keys(rest)[0]})`;
      if (typeof id !== 'string' || !id || id.length > 64) return 'tiene un paso sin id';
      if (typeof text !== 'string' || !text.trim() || text.length > METHOD_STEP_MAX) return `tiene un paso vacío o de más de ${METHOD_STEP_MAX} caracteres`;
      if (++count > METHOD_STEPS_MAX) return `tiene más de ${METHOD_STEPS_MAX} pasos`;
      if (steps !== undefined) {
        if (depth >= 2) return 'solo admite dos niveles (pasos y subpasos)';
        if (!Array.isArray(steps)) return 'tiene subpasos que no son una lista';
        const inner = check(steps, depth + 1);
        if (inner) return inner;
      }
    }
    return null;
  };
  return check(value, 1);
}

/** Número de cada paso en pantalla: `1`, `1.1`… */
export function numberedSteps(steps: MethodStep[]): Array<{ number: string; text: string; depth: 1 | 2 }> {
  const out: Array<{ number: string; text: string; depth: 1 | 2 }> = [];
  steps.forEach((step, i) => {
    out.push({ number: `${i + 1}`, text: step.text, depth: 1 });
    (step.steps ?? []).forEach((sub, j) => out.push({ number: `${i + 1}.${j + 1}`, text: sub.text, depth: 2 }));
  });
  return out;
}

/** Texto numerado que se guarda en `recipes.method`. */
export function formatMethodSteps(steps: MethodStep[]): string | null {
  const lines = numberedSteps(steps).map((s) => `${s.depth === 2 ? '   ' : ''}${s.number}. ${s.text.trim()}`);
  return lines.length ? lines.join('\n') : null;
}

/**
 * Convierte la elaboración en texto libre a pasos sin perder nada: una línea no vacía, un paso. Una línea que empieza por
 * `1.2`, `a)`, `-`, `•` o con sangría pasa a subpaso del paso anterior; la numeración propia del texto (`1.`, `2)`) se quita.
 */
export function methodStepsFromText(text: string | null | undefined, newId: () => string = () => crypto.randomUUID()): MethodStep[] {
  const steps: MethodStep[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indented = /^\s{2,}|^\t/.test(raw);
    let line = raw.trim();
    const subMark = /^(\d+\.\d+\.?|[a-z]\)|[-•*·])\s+/i.exec(line);
    if (subMark) line = line.slice(subMark[0].length);
    else line = line.replace(/^\d+\s*[.)]\s+/, '');
    line = line.slice(0, METHOD_STEP_MAX);
    if (!line) continue;
    const parent = steps.at(-1);
    if ((subMark || indented) && parent) (parent.steps ??= []).push({ id: newId(), text: line });
    else steps.push({ id: newId(), text: line });
    if (steps.reduce((n, s) => n + 1 + (s.steps?.length ?? 0), 0) >= METHOD_STEPS_MAX) break;
  }
  return steps;
}

/** Antelación en minutos como número y unidad para el formulario: la unidad más grande que la deja entera. */
export function prepToParts(minutes: number | null | undefined): { mode: 'sin' | 'momento' | 'antes'; amount: number | null; unit: PrepUnit } {
  if (minutes === null || minutes === undefined) return { mode: 'sin', amount: null, unit: 'horas' };
  if (minutes === 0) return { mode: 'momento', amount: null, unit: 'horas' };
  const unit: PrepUnit = minutes % 1440 === 0 ? 'dias' : minutes % 60 === 0 ? 'horas' : 'minutos';
  return { mode: 'antes', amount: minutes / UNIT_MINUTES[unit], unit };
}

/** Minutos de una antelación escrita como número y unidad (se admiten decimales: «1,5 horas»), o null si no vale. */
export function prepFromParts(amount: string | number, unit: PrepUnit): number | null {
  const value = typeof amount === 'number' ? amount : Number(String(amount).trim().replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  const minutes = Math.round(value * UNIT_MINUTES[unit]);
  return minutes >= 1 && minutes <= PREP_MINUTES_MAX ? minutes : null;
}

/** «En el momento», «90 minutos antes», «2 horas antes», «1 día antes»… o null sin indicar. */
export function prepLabel(minutes: number | null | undefined): string | null {
  const parts = prepToParts(minutes);
  if (parts.mode === 'sin') return null;
  if (parts.mode === 'momento') return 'En el momento';
  const n = parts.amount!;
  const word = parts.unit === 'dias' ? (n === 1 ? 'día' : 'días') : parts.unit === 'horas' ? (n === 1 ? 'hora' : 'horas') : (n === 1 ? 'minuto' : 'minutos');
  return `${n} ${word} antes`;
}
