import { el, replace } from './dom.ts';
import { icon } from './icons.ts';
import { effectiveTheme, setTheme, themePreference, toggleTheme, type ThemePreference } from './theme.ts';

const listeners = new Set<() => void>();
function notify(): void {
  for (const fn of listeners) fn();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', notify);

/** Botón sol/luna para la cabecera: alterna claro/oscuro desde el modo efectivo y refleja el cambio. */
export function createThemeToggle(): HTMLButtonElement {
  const button = el('button', { class: 'iconbtn themetoggle', type: 'button' });
  const paint = () => {
    const dark = effectiveTheme() === 'dark';
    replace(button, icon(dark ? 'sun' : 'moon'));
    button.setAttribute('aria-label', dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
    button.title = dark ? 'Tema claro' : 'Tema oscuro';
  };
  button.addEventListener('click', () => { toggleTheme(); notify(); });
  listeners.add(paint);
  paint();
  return button;
}

/** Selector de tres opciones (Sistema / Claro / Oscuro) para una pantalla de ajustes. */
export function createThemeSelect(): HTMLElement {
  const options: Array<[ThemePreference, string, 'settings' | 'sun' | 'moon']> = [['system', 'Sistema', 'settings'], ['light', 'Claro', 'sun'], ['dark', 'Oscuro', 'moon']];
  const group = el('div', { class: 'segmented themeselect', role: 'radiogroup', 'aria-label': 'Tema' });
  const buttons = options.map(([value, label, glyph]) => {
    const button = el('button', { type: 'button', role: 'radio', dataset: { theme: value }, onclick: () => { setTheme(value); notify(); } }, icon(glyph, 16), el('span', null, label));
    group.append(button);
    return [value, button] as const;
  });
  const paint = () => {
    const current = themePreference();
    for (const [value, button] of buttons) {
      button.classList.toggle('on', value === current);
      button.setAttribute('aria-checked', String(value === current));
    }
  };
  listeners.add(paint);
  paint();
  return group;
}
