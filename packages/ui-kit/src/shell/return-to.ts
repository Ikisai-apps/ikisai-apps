/**
 * «‹ Volver a…» entre apps (MUELA-013, K9). Convención común de los saltos entre apps (propuesta 1 de MUELA-013):
 * `…?desde=<app>&volver=<url de vuelta>&titulo=<a dónde se vuelve>`, en la búsqueda o en el hash (`#/ruta?…`).
 * - Solo cuenta si viene `volver` (una URL `https:` de `*.ikisai.com` o del mismo origen); `desde` sola **no**: ya la usan
 *   otros saltos con su propio sentido (Booking → Finance: `desde=booking:reservation:<id>`) y se deja intacta.
 * - Al llegar se guarda en la sesión de la pestaña y se quitan `volver` y `titulo` de la URL (`replaceState`), para que
 *   recargar o «atrás» no repitan el salto.
 * - Con origen, «atrás» desde el inicio vuelve a la app de la que se vino sin preguntar «¿Cerrar la app?».
 */
const KEY = 'ikisai-return-to';

export interface ReturnTo {
  /** App de la que se vino (`central`), si lo dice. */
  from: string | null;
  url: string;
  /** «Cumplimiento», «la reserva de Ana»… */
  title: string | null;
}

function allowed(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    if (u.origin === location.origin) return true;
    return u.protocol === 'https:' && (u.hostname === 'ikisai.com' || u.hostname.endsWith('.ikisai.com'));
  } catch { return false; }
}

/** Lee `volver`/`titulo`/`desde` de la URL (búsqueda o hash), los guarda y quita `volver` y `titulo`. */
export function readReturnTo(): ReturnTo | null {
  if (typeof window === 'undefined') return null;
  const search = new URLSearchParams(location.search);
  const hashAt = location.hash.indexOf('?');
  const hashParams = new URLSearchParams(hashAt >= 0 ? location.hash.slice(hashAt + 1) : '');
  const source = search.has('volver') ? search : hashParams.has('volver') ? hashParams : null;
  if (source) {
    const url = source.get('volver') ?? '';
    if (allowed(url)) {
      const value: ReturnTo = { from: source.get('desde'), url, title: source.get('titulo') };
      try { sessionStorage.setItem(KEY, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
      source.delete('volver');
      source.delete('titulo');
      const qs = source.toString();
      const next = source === search
        ? `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`
        : `${location.pathname}${location.search}${location.hash.slice(0, hashAt)}${qs ? `?${qs}` : ''}`;
      history.replaceState(history.state, '', next);
      return value;
    }
  }
  return currentReturnTo();
}

/** El origen guardado en esta pestaña (o `null`). */
export function currentReturnTo(): ReturnTo | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const value = raw ? JSON.parse(raw) as ReturnTo : null;
    return value && typeof value.url === 'string' && allowed(value.url) ? value : null;
  } catch { return null; }
}

/** Olvida el origen (p. ej. al volver, o si la persona lo cierra). */
export function clearReturnTo(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* sin almacenamiento */ }
}

/**
 * Enlace a otra app con la vuelta: `withReturnTo('https://food.ikisai.com/#/menus', { from: 'central', title: 'Cumplimiento' })`
 * añade `desde`, `volver` (esta página) y `titulo` al hash si lo hay, o a la búsqueda.
 */
export function withReturnTo(target: string, options: { from: string; title?: string | null; url?: string }): string {
  const params = new URLSearchParams();
  params.set('desde', options.from);
  params.set('volver', options.url ?? location.href);
  if (options.title) params.set('titulo', options.title);
  const hashAt = target.indexOf('#');
  if (hashAt >= 0) {
    const hash = target.slice(hashAt);
    return `${target.slice(0, hashAt)}${hash}${hash.includes('?') ? '&' : '?'}${params.toString()}`;
  }
  return `${target}${target.includes('?') ? '&' : '?'}${params.toString()}`;
}
