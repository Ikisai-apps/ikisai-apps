/**
 * Idiomas de Guests (API.md §9.10): español e inglés. Misma forma que `createI18n` del kit 0.19 (PR #285: diccionarios
 * por idioma, `t('clave', vars)`, plurales con `{one, other}`, idioma del navegador y cambio manual recordado en
 * `ikisai-locale:guests`), para pasar al del kit cambiando solo este archivo cuando se fusione. Mientras tanto, los textos
 * propios del kit (lanzador, formulario de ayuda) siguen en español.
 */
import { ES } from './i18n-es.ts';
import { EN } from './i18n-en.ts';

export type Locale = 'es' | 'en';
export type Entry = string | { zero?: string; one?: string; other: string };
export type Dictionary = Record<string, Entry>;
export type Vars = Record<string, string | number | null | undefined>;

const SUPPORTED: Locale[] = ['es', 'en'];
const TAG: Record<Locale, string> = { es: 'es-ES', en: 'en-GB' };
const DICTIONARIES: Record<Locale, Dictionary> = { es: ES, en: EN };
const STORE = 'ikisai-locale:guests';
const listeners = new Set<(locale: Locale) => void>();

function initial(): Locale {
  try {
    const stored = localStorage.getItem(STORE);
    if (stored === 'es' || stored === 'en') return stored;
  } catch { /* sin almacenamiento */ }
  const wanted = (navigator.languages ?? [navigator.language]).map((l) => (l ?? '').toLowerCase().slice(0, 2));
  return (wanted.find((l) => (SUPPORTED as string[]).includes(l)) as Locale | undefined) ?? 'es';
}

let current: Locale = initial();
document.documentElement.lang = current;

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (vars[name] === undefined || vars[name] === null ? all : String(vars[name])));
}

function pick(entry: Entry, vars?: Vars): string {
  if (typeof entry === 'string') return entry;
  const count = Number(vars?.count ?? 0);
  if (count === 0 && entry.zero) return entry.zero;
  return (new Intl.PluralRules(TAG[current]).select(count) === 'one' ? entry.one : undefined) ?? entry.other;
}

/** Texto de la app; si falta en el idioma, el español; si tampoco, la clave (una prueba exige que no falte ninguna). */
export function t(key: string, vars?: Vars): string {
  const entry = DICTIONARIES[current][key] ?? ES[key];
  return entry === undefined ? key : interpolate(pick(entry, vars), vars);
}

export function locale(): Locale { return current; }
export function localeTag(): string { return TAG[current]; }
export function supported(): Locale[] { return SUPPORTED.slice(); }

export function setLocale(next: Locale): void {
  if (next === current || !(SUPPORTED as string[]).includes(next)) return;
  current = next;
  try { localStorage.setItem(STORE, next); } catch { /* solo en memoria */ }
  document.documentElement.lang = next;
  for (const listener of listeners) listener(next);
}

export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fecha en el idioma elegido, en hora de Madrid. Acepta `AAAA-MM-DD` (día civil) o un instante. */
export function formatDate(value: string | Date, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat(TAG[current], { timeZone: 'Europe/Madrid', ...options }).format(date);
}
