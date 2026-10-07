/**
 * Idiomas de Guests (API.md §9.10): español e inglés con `createI18n` del kit 0.19 (diccionarios por idioma,
 * `t('clave', vars)`, plurales, idioma del navegador y cambio manual recordado en `ikisai-locale:guests`). El kit cambia
 * también sus propios textos (lanzador, formulario de ayuda, avisos). Aquí solo se añaden las fechas en hora de Madrid.
 */
import { createI18n, type Locale } from '@ikisai/ui-kit';
import { ES } from './i18n-es.ts';
import { EN } from './i18n-en.ts';

export type { Dictionary, Locale } from '@ikisai/ui-kit';

export const i18n = createI18n({ app: 'guests', dictionaries: { es: ES, en: EN } });

export const t = i18n.t;
export const locale = (): Locale => i18n.locale();
export const localeTag = (): string => i18n.tag();
export const setLocale = (next: Locale): void => i18n.setLocale(next);
export const onLocaleChange = (listener: (locale: Locale) => void): (() => void) => i18n.onChange(listener);

/** Fecha en el idioma elegido, en hora de Madrid. Acepta `AAAA-MM-DD` (día civil) o un instante. */
export function formatDate(value: string | Date, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat(i18n.tag(), { timeZone: 'Europe/Madrid', ...options }).format(date);
}
