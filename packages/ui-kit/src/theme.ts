/** Tema claro/oscuro y acento. El modo sigue al sistema salvo que la persona elija otro; la elección se guarda por app. */

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'ikisai-theme';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function themePreference(): ThemePreference {
  const stored = storage()?.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/** Aplica la preferencia guardada a `<html data-theme>`; sin preferencia, deja decidir a `prefers-color-scheme`. */
export function applyTheme(preference: ThemePreference = themePreference()): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || meta.content;
}

export function setTheme(preference: ThemePreference): void {
  const store = storage();
  if (preference === 'system') store?.removeItem(STORAGE_KEY);
  else store?.setItem(STORAGE_KEY, preference);
  applyTheme(preference);
}

/** Modo efectivo ahora mismo, resuelta la preferencia «sistema». */
export function effectiveTheme(): 'light' | 'dark' {
  const preference = themePreference();
  if (preference !== 'system') return preference;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Alterna claro/oscuro desde el modo efectivo (lo que espera un botón sol/luna). */
export function toggleTheme(): 'light' | 'dark' {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** Luminancia relativa; blanco o negro según lo que contraste mejor con `color`. */
export function inkOn(color: string): '#1f2a22' | '#ffffff' {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (!m) return '#1f2a22';
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.4 ? '#1f2a22' : '#ffffff';
}

/** Estilo en línea para un elemento con color propio (tarjeta, pastilla): `--item-color` y su tinta. */
export function itemColorStyle(color: string | null | undefined): string {
  if (!color) return '';
  return `--item-color:${color};--item-ink:${inkOn(color)}`;
}

/**
 * Acento derivado: con un color elegido por la persona (área, proyecto) lo fija en `<html>`; sin color, vuelve al neutro
 * de los tokens. Nunca pisa el color del elemento que lo lleva: solo tiñe lo neutro (botones, anillos, navegación).
 */
export function applyAccent(color: string | null | undefined): void {
  const root = document.documentElement;
  if (color) {
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-ink', inkOn(color));
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-ink');
  }
}
