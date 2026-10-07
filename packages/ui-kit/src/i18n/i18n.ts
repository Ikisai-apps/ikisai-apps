/**
 * Idiomas (español e inglés) para los portales (PORTALES_V2.md §8). Dos piezas:
 * - **Textos del kit:** `kt('Enviar')`. La clave es el propio texto en español, así que en español no cambia nada (las
 *   apps internas no pagan nada) y en inglés se busca en `KIT_EN` (`kit-en.ts`). Variables con `{nombre}`.
 * - **Textos de la app:** `createI18n({ app, dictionaries: { es, en } })` → `t('clave', vars)`. Elige el idioma del
 *   navegador si está entre los admitidos, recuerda el cambio manual por dispositivo, pone `<html lang>`, cambia también
 *   el idioma del kit y formatea fechas, números y monedas con `Intl` en el idioma elegido.
 * Plurales: una entrada puede ser `{ one: '…', other: '…' }` y se elige con `Intl.PluralRules` según `vars.count`.
 */
import { KIT_EN } from './kit-en.ts';

export type Locale = 'es' | 'en';
export type Entry = string | { zero?: string; one?: string; other: string };
export type Dictionary = Record<string, Entry>;
export type Vars = Record<string, string | number | null | undefined>;

const LOCALE_TAG: Record<Locale, string> = { es: 'es-ES', en: 'en-GB' };
const kitDictionaries: Record<Locale, Dictionary> = { es: {}, en: KIT_EN };
let kitLocale: Locale = 'es';
const kitListeners = new Set<(locale: Locale) => void>();

/** Rellena `{nombre}` con las variables (lo que no esté se deja tal cual). */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (vars[name] === undefined || vars[name] === null ? all : String(vars[name])));
}

function pick(entry: Entry, locale: Locale, vars?: Vars): string {
  if (typeof entry === 'string') return entry;
  const count = Number(vars?.count ?? 0);
  if (count === 0 && entry.zero) return entry.zero;
  const rule = new Intl.PluralRules(LOCALE_TAG[locale]).select(count);
  return (rule === 'one' ? entry.one : undefined) ?? entry.other;
}

/** Idioma de los textos del kit. */
export function kitLocaleNow(): Locale { return kitLocale; }

/** Cambia el idioma de los textos del kit (lo hace `createI18n`; las apps internas no lo tocan). */
export function setKitLocale(locale: Locale): void {
  if (locale === kitLocale) return;
  kitLocale = locale;
  for (const listener of kitListeners) listener(locale);
}
export function onKitLocaleChange(listener: (locale: Locale) => void): () => void { kitListeners.add(listener); return () => kitListeners.delete(listener); }

/** Añade o corrige traducciones del kit (p. ej. un portal que prefiere otra palabra). */
export function extendKitDictionary(locale: Locale, entries: Dictionary): void {
  Object.assign(kitDictionaries[locale], entries);
}

/** Texto del kit en el idioma actual. La clave es el texto en español. */
export function kt(spanish: string, vars?: Vars): string {
  const entry = kitLocale === 'es' ? undefined : kitDictionaries[kitLocale][spanish];
  return interpolate(entry === undefined ? spanish : pick(entry, kitLocale, vars), vars);
}

/** Etiqueta BCP 47 para `Intl` del idioma de los textos del kit. */
export function kitLocaleTag(): string { return LOCALE_TAG[kitLocale]; }

export interface I18nOptions {
  /** Id de la app (clave del idioma elegido en este dispositivo). */
  app: string;
  dictionaries: Partial<Record<Locale, Dictionary>>;
  /** Idiomas admitidos; por defecto los de `dictionaries`. */
  supported?: Locale[];
  /** Si el navegador no pide ninguno admitido; por defecto `es`. */
  fallback?: Locale;
  /** Moneda por defecto de `formatMoney`; por defecto `EUR`. */
  currency?: string;
}

export interface I18n {
  locale(): Locale;
  setLocale(locale: Locale): void;
  supported(): Locale[];
  /** Texto de la app; si falta en el idioma, el del idioma de reserva; si tampoco, la clave. */
  t(key: string, vars?: Vars): string;
  onChange(listener: (locale: Locale) => void): () => void;
  formatDate(value: Date | string | number, options?: Intl.DateTimeFormatOptions): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatMoney(amount: number, currency?: string): string;
  /** Etiqueta para `Intl` (`es-ES`, `en-GB`). */
  tag(): string;
}

/** Idioma pedido por el navegador entre los admitidos. */
export function browserLocale(supported: Locale[], fallback: Locale = 'es'): Locale {
  const wanted = (typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : []).map((l) => l.toLowerCase().slice(0, 2));
  return (wanted.find((l) => (supported as string[]).includes(l)) as Locale | undefined) ?? fallback;
}

export function createI18n(options: I18nOptions): I18n {
  const supported = options.supported ?? (Object.keys(options.dictionaries) as Locale[]);
  const fallback = options.fallback ?? 'es';
  const key = `ikisai-locale:${options.app}`;
  const listeners = new Set<(locale: Locale) => void>();
  let stored: string | null = null;
  try { stored = localStorage.getItem(key); } catch { /* sin almacenamiento */ }
  let current: Locale = stored && (supported as string[]).includes(stored) ? stored as Locale : browserLocale(supported, fallback);

  function apply(): void {
    document.documentElement.lang = current;
    setKitLocale(current);
  }
  apply();

  const tag = () => LOCALE_TAG[current];
  return {
    locale: () => current,
    supported: () => supported.slice(),
    setLocale(locale) {
      if (!(supported as string[]).includes(locale) || locale === current) return;
      current = locale;
      try { localStorage.setItem(key, locale); } catch { /* */ }
      apply();
      for (const l of listeners) l(locale);
    },
    t(k, vars) {
      const entry = options.dictionaries[current]?.[k] ?? options.dictionaries[fallback]?.[k];
      return entry === undefined ? k : interpolate(pick(entry, current, vars), vars);
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    formatDate(value, opts) { return new Intl.DateTimeFormat(tag(), opts ?? { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value)); },
    formatNumber(value, opts) { return new Intl.NumberFormat(tag(), opts).format(value); },
    formatMoney(amount, currency) { return new Intl.NumberFormat(tag(), { style: 'currency', currency: currency ?? options.currency ?? 'EUR' }).format(amount); },
    tag,
  };
}
