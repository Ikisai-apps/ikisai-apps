/**
 * Cocina y Preparación (tanda 27; MUELA-006, 035 y 068 §1–2): qué servicio toca ahora, a qué día y a qué servicio va
 * cada paso, qué paso es el siguiente y cuáles van atrasados, y las cifras del plan. Una sola implementación para las dos
 * pantallas y para Inicio. Sin datos nuevos: sale de `preparation_items` y del grafo del menú.
 *
 * Las horas son las de la casa, en la hora local del dispositivo, como `consumptionDue`.
 */
import type { MenuItem, MenuService } from './menus.ts';
import type { PreparationItem } from './planning.ts';

type Step = Pick<PreparationItem, 'id' | 'menu_item_id' | 'scheduled_date' | 'scheduled_time' | 'done'> & { deleted_at?: string | null };
type Service = Pick<MenuService, 'id' | 'service_date' | 'service_time' | 'service_type' | 'position'> & { deleted_at?: string | null };
type Item = Pick<MenuItem, 'id' | 'service_id'> & { deleted_at?: string | null };

/** Minutos que un servicio sigue siendo «ahora» después de su hora. */
export const SERVICE_NOW_MINUTES = 90;

/** «2026-10-19» del instante, en la hora local. */
export function localDayKey(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** El instante de una fecha y hora locales; sin hora, `null`. */
export function localAt(day: string | null, time: string | null): Date | null {
  if (!day || !time) return null;
  return new Date(`${day}T${time.slice(0, 5)}:00`);
}

/** El servicio de cada paso: el de su plato, si lo tiene. Los demás son «pasos sueltos». */
export function stepService<S extends Service>(step: Step, items: Item[], services: S[]): S | null {
  if (!step.menu_item_id) return null;
  const item = items.find((i) => i.id === step.menu_item_id && !i.deleted_at);
  return (item && services.find((s) => s.id === item.service_id && !s.deleted_at)) || null;
}

/** El día de un paso: el que tiene escrito; si no tiene, el de su servicio. `null` = «Sin día». */
export function stepDay(step: Step, items: Item[], services: Service[]): string | null {
  return step.scheduled_date ?? stepService(step, items, services)?.service_date ?? null;
}

/**
 * Atrasado: sin hacer y con la hora pasada. Sin hora, cuando su día ya pasó. Sin día, nunca.
 * (Regla de la tanda 27: «atrasado» es sin hacer y con la hora pasada; los casos sin hora y sin día los fija Food.)
 */
export function isOverdue(step: Step, day: string | null, now: Date): boolean {
  if (step.done || !day) return false;
  const at = localAt(day, step.scheduled_time);
  return at ? at.getTime() < now.getTime() : day < localDayKey(now);
}

export interface PrepStats {
  total: number;
  done: number;
  pending: number;
  overdue: number;
  /** De 0 a 100, redondeado; 0 sin pasos. */
  pct: number;
}

export function prepStats<T extends Step>(steps: T[], dayOf: (step: T) => string | null, now: Date): PrepStats {
  const live = steps.filter((s) => !s.deleted_at);
  const done = live.filter((s) => s.done).length;
  return {
    total: live.length,
    done,
    pending: live.length - done,
    overdue: live.filter((s) => isOverdue(s, dayOf(s), now)).length,
    pct: live.length ? Math.round((done / live.length) * 100) : 0,
  };
}

/** «Siguiente»: el primer paso sin hacer y no atrasado del día de hoy, por hora (los sin hora, al final). */
export function nextStep<T extends Step>(steps: T[], dayOf: (step: T) => string | null, now: Date): T | null {
  const today = localDayKey(now);
  const candidates = steps.filter((s) => !s.deleted_at && !s.done && dayOf(s) === today && !isOverdue(s, today, now));
  candidates.sort((a, b) => (a.scheduled_time ?? '99').localeCompare(b.scheduled_time ?? '99'));
  return candidates[0] ?? null;
}

export type ServicePhase = 'ahora' | 'despues' | 'hecho';

/**
 * En qué momento está cada servicio del día: el primero cuya hora más 90 minutos no ha pasado es «ahora»; los
 * siguientes, «después»; los anteriores, «hecho». En un día que no es hoy, todos «después» (futuro) o «hecho» (pasado).
 * Un servicio sin hora cuenta al final del día.
 */
export function servicePhases<T extends Service>(services: T[], day: string, now: Date): Array<{ service: T; phase: ServicePhase }> {
  const ofDay = services.filter((s) => !s.deleted_at && s.service_date === day)
    .sort((a, b) => (a.service_time ?? '99').localeCompare(b.service_time ?? '99') || Number(a.position) - Number(b.position));
  const today = localDayKey(now);
  if (day !== today) return ofDay.map((service) => ({ service, phase: day < today ? 'hecho' : 'despues' }));
  let found = false;
  return ofDay.map((service) => {
    const at = localAt(service.service_date, service.service_time);
    const over = at ? at.getTime() + SERVICE_NOW_MINUTES * 60_000 < now.getTime() : false;
    if (over || found) return { service, phase: over ? 'hecho' : 'despues' };
    found = true;
    return { service, phase: 'ahora' };
  });
}

/** «en 2 h 40 min», «en 15 min», «empezó hace 20 min»; sin hora, `null`. */
export function untilText(day: string, time: string | null, now: Date): string | null {
  const at = localAt(day, time);
  if (!at) return null;
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  const span = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
  if (minutes > 0) return `en ${span(minutes)}`;
  if (minutes === 0) return 'ahora';
  return `empezó hace ${span(-minutes)}`;
}

/** «11 pasos · Marga 6 · Tomás 5»: el reparto por responsable, de más a menos; sin responsable no se nombra. */
export function shareOut(steps: Array<Pick<PreparationItem, 'responsible'> & { deleted_at?: string | null }>): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of steps) {
    if (s.deleted_at) continue;
    const name = s.responsible?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
}

/** El círculo del responsable: tras el actual va el siguiente nombre del plan; tras el último, nadie. */
export function nextResponsible(current: string | null, names: string[]): string | null {
  if (!names.length) return null;
  const at = current ? names.indexOf(current.trim()) : -1;
  if (at === -1) return current ? null : names[0]!;
  return names[at + 1] ?? null;
}

/** Mover la hora de un paso: «HH:MM» más los minutos, sin salir del día (de 00:00 a 23:59). */
export function shiftTime(time: string | null, minutes: number): string {
  const [h, m] = (time ?? '12:00').slice(0, 5).split(':').map(Number);
  const total = Math.min(23 * 60 + 59, Math.max(0, (h ?? 12) * 60 + (m ?? 0) + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
