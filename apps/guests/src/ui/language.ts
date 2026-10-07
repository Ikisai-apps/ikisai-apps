/** Selector de idioma (API.md §9.10): español o inglés, recordado en este dispositivo. */
import { el } from '@ikisai/ui-kit';
import { locale, setLocale, type Locale } from '../app/i18n.ts';

export function languageSelect(onChange: () => void): HTMLElement {
  const select = el('select', {
    id: 'language', class: 'glang', 'aria-label': 'Idioma · Language',
    'data-feedback-id': 'guests.entrada.idioma.cambiar', 'data-feedback-label': 'Idioma',
    onchange: (event: Event) => { setLocale((event.target as HTMLSelectElement).value as Locale); onChange(); },
  }, el('option', { value: 'es' }, 'Español'), el('option', { value: 'en' }, 'English')) as HTMLSelectElement;
  select.value = locale();
  return select;
}
