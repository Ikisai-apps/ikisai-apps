/**
 * Elegir uno o varios espacios (`createSpacePicker`, RECURSOS.md §7 y §17): tan rápido como las chips de etiqueta de hoy.
 * - **Más usados a un toque:** chips que pasa la app (`quick`) o, si no, los recientes de este navegador.
 * - **Buscar:** por nombre, nombre público, código o ruta, sin mayúsculas ni tildes; cada resultado con su ruta
 *   («Hab 3 — Altura 3 › Albergue»). Flechas, Intro y Escape.
 * - **Elegidos:** chips con la ruta corta («Albergue › Hab 3») y «×» para quitarlos.
 * - **Filtro:** por tipos (`kinds: ['habitacion', 'sala']`) o por función (`filter: (r) => r.attributes.bookable === true`).
 * Toma las filas de una `SpaceSource` (se actualiza sola) o de `rows`.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { normalizeName } from '../fields/suggest.ts';
import { DEFAULT_SPACE_KINDS, ancestorsOf, indexSpaces, kindLabel, spaceMatches, spacePath, type SpaceKind, type SpaceRow, type SpaceSource } from './model.ts';

export interface SpacePickerOptions {
  label: string;
  source?: SpaceSource;
  rows?: SpaceRow[];
  kinds?: SpaceKind[];
  /** Varios (tareas) o uno (por defecto). */
  multiple?: boolean;
  value?: string[] | string | null;
  onChange?: (ids: string[]) => void;
  /** Solo se pueden elegir estos tipos. */
  kindFilter?: string[];
  /** Solo se pueden elegir los que cumplan esto. */
  filter?: (row: SpaceRow) => boolean;
  /** Ids de los más usados que da la app (Tasks los cuenta en sus tareas); vacío = sin chips rápidas. */
  quick?: string[];
  /** Sin `quick`: clave para recordar los recientes en este navegador. */
  recentKey?: string;
  placeholder?: string;
  /** Base de las marcas de feedback y uso. */
  feedbackId?: string;
  /** Cuántas chips rápidas como máximo (6). */
  quickLimit?: number;
}

export interface SpacePicker {
  element: HTMLElement;
  get(): string[];
  /** Cambia la selección sin llamar a `onChange`. */
  set(ids: string[] | string | null): void;
  setRows(rows: SpaceRow[]): void;
  destroy(): void;
}

export const SPACE_PICKER_MARKS = {
  quick: ['rapido', 'Espacio más usado'],
  search: ['buscar', 'Buscar espacio'],
  option: ['opcion', 'Resultado de la búsqueda'],
  remove: ['quitar', 'Quitar espacio'],
} as const;

let uid = 0;

function readRecent(key: string | undefined): string[] {
  if (!key) return [];
  try { return JSON.parse(localStorage.getItem(`ikisai-space-recent:${key}`) ?? '[]') as string[]; } catch { return []; }
}
function writeRecent(key: string | undefined, ids: string[]): void {
  if (!key) return;
  try { localStorage.setItem(`ikisai-space-recent:${key}`, JSON.stringify(ids.slice(0, 12))); } catch { /* sin almacenamiento */ }
}

const asIds = (value: string[] | string | null | undefined): string[] => (Array.isArray(value) ? value.slice() : value ? [value] : []);

export function createSpacePicker(options: SpacePickerOptions): SpacePicker {
  const kinds = options.kinds ?? DEFAULT_SPACE_KINDS;
  const multiple = !!options.multiple;
  const limit = options.quickLimit ?? 6;
  const base = options.feedbackId;
  const mark = (key: keyof typeof SPACE_PICKER_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${SPACE_PICKER_MARKS[key][0]}`, 'data-feedback-label': SPACE_PICKER_MARKS[key][1] } : {});
  const id = `kit-space-picker-${++uid}`;
  let rows = options.rows ?? [];
  let byId = indexSpaces(rows);
  let selected = asIds(options.value);
  let results: SpaceRow[] = [];
  let active = -1;

  const selectable = (r: SpaceRow) => r.active && (!options.kindFilter || options.kindFilter.includes(r.kind)) && (!options.filter || options.filter(r));
  const shortPath = (rid: string) => { const r = byId.get(rid); if (!r) return ''; const parent = ancestorsOf(byId, rid).pop(); return parent && parent.kind !== 'altura' ? `${parent.name} › ${r.name}` : r.name; };

  const chips = el('div', { class: 'space-picked', 'aria-live': 'polite' });
  const quickHost = el('div', { class: 'space-quick' });
  const input = el('input', {
    type: 'text', id, class: 'space-search', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', 'aria-controls': `${id}-list`,
    autocomplete: 'off', placeholder: options.placeholder ?? kt('Buscar espacio…'), ...mark('search'),
    oninput: () => search(), onfocus: () => { if (input.value) search(); },
    onkeydown: (e: Event) => onKey(e as KeyboardEvent),
    // Al salir del campo se cierra la lista, salvo que haya vuelto a él (un toque en «×» y otra búsqueda).
    onblur: () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150),
  }) as HTMLInputElement;
  const listbox = el('ul', { class: 'space-results', id: `${id}-list`, role: 'listbox', 'aria-label': options.label, hidden: true });
  const element = el('div', { class: `space-picker${multiple ? ' multiple' : ''}`, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) },
    el('label', { class: 'space-picker-label', for: id }, options.label),
    chips,
    quickHost,
    el('div', { class: 'space-search-wrap' }, icon('search', 16), input),
    listbox,
  );

  function emit(): void { options.onChange?.(selected.slice()); }

  function toggle(rid: string, from: 'quick' | 'search'): void {
    if (multiple) selected = selected.includes(rid) ? selected.filter((x) => x !== rid) : [...selected, rid];
    else selected = selected[0] === rid && from === 'quick' ? [] : [rid];
    if (selected.includes(rid)) writeRecent(options.recentKey, [rid, ...readRecent(options.recentKey).filter((x) => x !== rid)]);
    paint();
    emit();
  }

  function quickIds(): string[] {
    const source = options.quick ?? readRecent(options.recentKey);
    const out = source.filter((x) => byId.get(x) && selectable(byId.get(x)!));
    // Los elegidos también salen (marcados) para poder quitarlos de un toque, como las chips de hoy.
    return [...new Set([...selected.filter((x) => out.includes(x)), ...out])].slice(0, limit);
  }

  function paint(): void {
    replace(chips, ...selected.filter((x) => byId.has(x)).map((x) => el('span', { class: 'chip space-chip', title: spacePath(byId, x) },
      shortPath(x),
      el('button', { type: 'button', class: 'space-chip-x', 'aria-label': kt('Quitar {path}', { path: spacePath(byId, x) }), ...mark('remove'), onclick: () => { selected = selected.filter((s) => s !== x); paint(); emit(); } }, icon('close', 14)))));
    const quick = quickIds();
    replace(quickHost, ...(quick.length ? [
      el('span', { class: 'space-quick-label' }, options.quick ? kt('Más usados') : kt('Recientes')),
      ...quick.map((x) => el('button', { type: 'button', class: `filterchip space-quick-chip${selected.includes(x) ? ' on' : ''}`, 'aria-pressed': String(selected.includes(x)), title: spacePath(byId, x), ...mark('quick'), onclick: () => toggle(x, 'quick') }, byId.get(x)!.name)),
    ] : []));
  }

  function search(): void {
    const q = input.value.trim();
    // Primero los que empiezan por lo buscado, luego los que lo contienen en el nombre y al final los que lo tienen en la ruta.
    const nq = normalizeName(q);
    const rank = (r: SpaceRow) => { const n = normalizeName(r.name); return n.startsWith(nq) ? 0 : n.includes(nq) ? 1 : 2; };
    results = q ? rows.filter((r) => selectable(r) && spaceMatches(byId, r, q))
      .sort((a, b) => rank(a) - rank(b) || spacePath(byId, a.id).localeCompare(spacePath(byId, b.id))).slice(0, 30) : [];
    active = results.length ? 0 : -1;
    paintResults(q);
  }

  function paintResults(q: string): void {
    const open = q !== '';
    listbox.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    replace(listbox, ...(results.length ? results.map((r, i) => {
      const parentPath = ancestorsOf(byId, r.id).map((a) => a.name).join(' › ');
      return el('li', { role: 'option', id: `${id}-opt-${i}`, class: `space-result${i === active ? ' active' : ''}`, 'aria-selected': String(selected.includes(r.id)), ...mark('option'),
        onmousedown: (e: Event) => e.preventDefault(), onclick: () => pick(r.id) },
        el('span', { class: 'space-result-name' }, r.name, selected.includes(r.id) ? el('span', { class: 'space-result-check' }, icon('check', 14)) : null),
        el('span', { class: 'space-result-path' }, [parentPath, kindLabel(kinds, r.kind)].filter(Boolean).join(' · ')));
    }) : open ? [el('li', { class: 'space-result empty', role: 'option', 'aria-disabled': 'true' }, kt('Ningún espacio coincide con «{q}».', { q }))] : []));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-opt-${active}`); else input.removeAttribute('aria-activedescendant');
  }

  function pick(rid: string): void {
    toggle(rid, 'search');
    if (!multiple) { input.value = ''; close(); } else { input.select(); search(); }
  }

  function close(): void { results = []; active = -1; paintResults(''); }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      paintResults(input.value.trim());
      document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (active >= 0 && results[active]) { e.preventDefault(); pick(results[active]!.id); }
    } else if (e.key === 'Escape' && !listbox.hidden) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      close();
    }
  }

  function setRows(next: SpaceRow[]): void {
    rows = next;
    byId = indexSpaces(rows);
    paint();
    if (input.value) search();
  }

  const unsubscribe = options.source?.subscribe(setRows);
  if (options.source) void Promise.resolve(options.source.list()).then(setRows);
  paint();
  return {
    element,
    get: () => selected.slice(),
    set(ids) { selected = asIds(ids); paint(); },
    setRows,
    destroy() { unsubscribe?.(); element.remove(); },
  };
}
