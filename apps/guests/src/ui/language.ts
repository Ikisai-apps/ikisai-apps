/** Selector de idioma (API.md §9.10): ES | EN del kit, recordado en este dispositivo; la app repinta con `onLocaleChange`. */
import { createLanguageSelect } from '@ikisai/ui-kit';
import { i18n } from '../app/i18n.ts';

export function languageSelect(): HTMLElement {
  return createLanguageSelect(i18n, { attrs: { id: 'language', 'data-feedback-id': 'guests.entrada.idioma.cambiar', 'data-feedback-label': 'Idioma' } });
}
