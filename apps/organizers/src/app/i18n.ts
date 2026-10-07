/**
 * Idiomas de Organizers (PORTALES_V2 §8; API.md §13.1): español e inglés con `createI18n` del kit 0.19.
 * Como en el kit, **la clave es el propio texto en español**: `t('Mis retiros')` devuelve el español tal cual o su
 * traducción de `EN`. Los textos de las tablas de etiquetas se marcan con `L('…')` y se traducen al pintarlos con `t()`.
 * `tests/organizers/i18n.test.ts` comprueba que cada `t('…')` y `L('…')` del código tiene su entrada en `EN`.
 */
import { createI18n, interpolate, type Vars } from '@ikisai/ui-kit';
import { EN } from './i18n-en.ts';

export const i18n = createI18n({ app: 'organizers', dictionaries: { es: {}, en: EN } });

/** Texto en el idioma actual, con `{variables}`. */
export function t(spanish: string, vars?: Vars): string {
  const out = i18n.t(spanish, vars);
  return out === spanish ? interpolate(spanish, vars) : out;
}

/** Marca un texto traducible que se guarda en una tabla y se traduce después con `t()`. */
export const L = (spanish: string): string => spanish;

export const lang = (): 'es' | 'en' => i18n.locale();
