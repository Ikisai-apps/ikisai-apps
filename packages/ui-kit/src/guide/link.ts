/**
 * Enlace del Guiado entre apps: la convención de «‹ Volver a…» (K9, `return-to.ts`) más tres datos:
 * - `campo`: el anclaje que se señala al llegar (id del inventario, nunca un selector).
 * - `paso`: la explicación del paso, una línea (como mucho 140 caracteres).
 * - `guia`: id de la ejecución de Flow, para el Guiado completo (`createGuide`), que lee los pasos de Flow; nunca de la URL.
 * Al llegar se guardan en la sesión de la pestaña y se quitan de la URL, como `volver`: recargar no repite el salto.
 */
import { withReturnTo } from '../shell/return-to.ts';
import { ANCHOR_ID } from './anchors.ts';

const KEY = 'ikisai-guide-link';
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface GuideLink {
  /** Anclaje a señalar. */
  field: string | null;
  /** Explicación del paso. */
  step: string | null;
  /** Ejecución de Flow (Guiado completo). */
  run: string | null;
}

/** Enlace a otra app que señala un campo y vuelve aquí: `withGuideLink('https://booking.ikisai.com/#/reservas/123', { field, step, from: 'flow', title: 'Flow' })`. */
export function withGuideLink(target: string, options: { field?: string | null; step?: string | null; run?: string | null; from: string; title?: string | null; url?: string }): string {
  const base = withReturnTo(target, { from: options.from, title: options.title, url: options.url });
  const params = new URLSearchParams();
  if (options.field && ANCHOR_ID.test(options.field)) params.set('campo', options.field);
  if (options.step) params.set('paso', options.step.trim().slice(0, 140));
  if (options.run && RUN_ID.test(options.run)) params.set('guia', options.run);
  const extra = params.toString();
  return extra ? `${base}&${extra}` : base;
}

/** Lee `campo`, `paso` y `guia` de la URL (búsqueda o hash), los guarda en la pestaña y los quita de la URL. */
export function readGuideLink(): GuideLink | null {
  if (typeof window === 'undefined') return null;
  const search = new URLSearchParams(location.search);
  const hashAt = location.hash.indexOf('?');
  const hashParams = new URLSearchParams(hashAt >= 0 ? location.hash.slice(hashAt + 1) : '');
  const has = (p: URLSearchParams) => p.has('campo') || p.has('guia');
  const source = has(search) ? search : has(hashParams) ? hashParams : null;
  if (source) {
    const field = source.get('campo');
    const run = source.get('guia');
    const value: GuideLink = {
      field: field && ANCHOR_ID.test(field) ? field : null,
      step: source.get('paso')?.trim().slice(0, 140) || null,
      run: run && RUN_ID.test(run) ? run : null,
    };
    for (const k of ['campo', 'paso', 'guia']) source.delete(k);
    const qs = source.toString();
    const next = source === search
      ? `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`
      : `${location.pathname}${location.search}${location.hash.slice(0, hashAt)}${qs ? `?${qs}` : ''}`;
    history.replaceState(history.state, '', next);
    if (value.field || value.run) {
      try { sessionStorage.setItem(KEY, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
      return value;
    }
  }
  return currentGuideLink();
}

/** Lo guardado en esta pestaña (o `null`). */
export function currentGuideLink(): GuideLink | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) as GuideLink : null;
    if (!v) return null;
    return { field: typeof v.field === 'string' && ANCHOR_ID.test(v.field) ? v.field : null, step: typeof v.step === 'string' ? v.step.slice(0, 140) : null, run: typeof v.run === 'string' && RUN_ID.test(v.run) ? v.run : null };
  } catch { return null; }
}

/** Olvida el enlace (al volver o al cerrar el aviso). */
export function clearGuideLink(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* sin almacenamiento */ }
}
