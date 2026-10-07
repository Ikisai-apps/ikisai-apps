/**
 * Selector de idioma (ES | EN) para la cabecera o el menú de un portal. Cambia el idioma de `createI18n` (que lo
 * recuerda en el dispositivo) y la app repinta con `i18n.onChange`.
 */
import { el, replace } from '../dom.ts';
import { kt, type I18n, type Locale } from './i18n.ts';

const NAMES: Record<Locale, { short: string; long: string }> = {
  es: { short: 'ES', long: 'Español' },
  en: { short: 'EN', long: 'English' },
};

export function createLanguageSelect(i18n: I18n, options: { attrs?: Record<string, string> } = {}): HTMLElement {
  const group = el('div', { class: 'segmented lang-select', role: 'radiogroup', ...(options.attrs ?? {}) });
  const paint = () => {
    group.setAttribute('aria-label', kt('Idioma'));
    replace(group, ...i18n.supported().map((locale) => el('button', {
      type: 'button', role: 'radio', lang: locale, class: locale === i18n.locale() ? 'on' : '',
      'aria-checked': String(locale === i18n.locale()), 'aria-label': NAMES[locale].long, dataset: { locale },
      onclick: () => i18n.setLocale(locale),
    }, NAMES[locale].short)));
  };
  paint();
  i18n.onChange(paint);
  return group;
}
