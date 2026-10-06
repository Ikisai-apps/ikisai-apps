import { el, replace } from './dom.ts';
import { icon } from './icons.ts';
import { lockScroll } from './overlay/focus.ts';

export interface PaletteItem {
  group: string;
  text: string;
  sub?: string;
  /** Punto de color (área, proyecto). */
  color?: string | null;
  /** Atajo que se muestra a la derecha. */
  hint?: string;
  /** Palabras extra para la búsqueda. */
  keywords?: string;
  run: () => void;
}

export interface PaletteOptions {
  /** Devuelve los elementos para la consulta actual (ya normalizada, puede estar vacía). */
  items: (query: string) => PaletteItem[];
  placeholder?: string;
  /** Ctrl K / Cmd K abre y cierra; por defecto activo. */
  hotkey?: boolean;
  /** Máximo de resultados; por defecto 16. */
  limit?: number;
  /** Grupos que no aparecen sin consulta (por ejemplo «Tareas»). */
  hiddenWhenEmpty?: string[];
}

export interface CommandPalette {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

/** Minúsculas sin acentos, para buscar. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Filtra y ordena: todas las palabras deben aparecer; primero lo que empieza por la consulta. */
export function filterPaletteItems(items: PaletteItem[], query: string, limit = 16, hiddenWhenEmpty: string[] = []): PaletteItem[] {
  if (!query) return items.filter((item) => !hiddenWhenEmpty.includes(item.group)).slice(0, limit);
  const words = query.split(/\s+/).filter(Boolean);
  return items
    .map((item) => {
      const hay = foldText(`${item.text} ${item.sub ?? ''} ${item.keywords ?? ''}`);
      if (!words.every((w) => hay.includes(w))) return null;
      return { item, rank: foldText(item.text).startsWith(words[0]!) ? 0 : 1 };
    })
    .filter((x): x is { item: PaletteItem; rank: number } => x !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.item)
    .slice(0, limit);
}

/** Paleta de comandos (Ctrl K): salta a proyectos, áreas, vistas o acciones sin el ratón. */
export function createCommandPalette(options: PaletteOptions): CommandPalette {
  let back: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let list: HTMLElement | null = null;
  let rows: PaletteItem[] = [];
  let index = 0;
  let unlock: (() => void) | null = null;
  let opener: HTMLElement | null = null;

  function draw(): void {
    if (!input || !list) return;
    const query = foldText(input.value.trim());
    rows = filterPaletteItems(options.items(query), query, options.limit, options.hiddenWhenEmpty);
    index = Math.min(index, Math.max(0, rows.length - 1));
    if (!rows.length) {
      replace(list, el('div', { class: 'palette-empty' }, 'Nada coincide. Prueba con otro nombre.'));
      return;
    }
    const nodes: HTMLElement[] = [];
    let group = '';
    rows.forEach((item, n) => {
      if (item.group !== group) {
        group = item.group;
        nodes.push(el('div', { class: 'palette-group' }, group));
      }
      nodes.push(el('button', {
        type: 'button',
        class: `palette-item${n === index ? ' on' : ''}`,
        role: 'option',
        'aria-selected': String(n === index),
        dataset: { paletteItem: String(n) },
        onclick: () => { close(); item.run(); },
        onmousemove: () => { if (index !== n) { index = n; list?.querySelectorAll('.palette-item').forEach((node) => { const on = (node as HTMLElement).dataset.paletteItem === String(n); node.classList.toggle('on', on); node.setAttribute('aria-selected', String(on)); }); } },
      },
        el('span', { class: `pdot${item.color ? '' : ' plain'}`, style: item.color ? `--pcolor:${item.color}` : null }),
        el('span', { class: 'ptext' }, el('span', null, item.text), item.sub ? el('small', null, item.sub) : null),
        item.hint ? el('span', { class: 'phint' }, item.hint) : el('span'),
      ));
    });
    replace(list, ...nodes);
    list.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function open(): void {
    if (back) { input?.focus(); return; }
    opener = document.activeElement as HTMLElement | null;
    input = el('input', { id: 'paletteInput', placeholder: options.placeholder ?? 'Buscar o saltar…', autocomplete: 'off', spellcheck: 'false', 'aria-label': options.placeholder ?? 'Buscar o saltar', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'paletteList' });
    list = el('div', { class: 'palette-list', id: 'paletteList', role: 'listbox' });
    back = el('div', { class: 'palette-back', id: 'palette', onclick: (e: Event) => { if (e.target === back) close(); } },
      el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Paleta de comandos' },
        el('div', { class: 'palette-input' }, icon('search'), input, el('kbd', null, 'Esc')),
        list,
        el('div', { class: 'palette-foot' }, el('span', null, '↑ ↓ moverse'), el('span', null, 'Enter abrir'), el('span', null, 'Esc cerrar')),
      ),
    );
    input.addEventListener('input', () => { index = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(rows.length - 1, index + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(0, index - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); const item = rows[index]; if (item) { close(); item.run(); } }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); }
    });
    unlock = lockScroll();
    document.body.append(back);
    index = 0;
    draw();
    input.focus();
  }

  function close(): void {
    if (!back) return;
    back.remove();
    back = null;
    input = null;
    list = null;
    unlock?.();
    unlock = null;
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }

  const onHotkey = (e: KeyboardEvent) => {
    if (options.hotkey === false) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (back) close();
      else open();
    }
  };
  document.addEventListener('keydown', onHotkey);

  return {
    open,
    close,
    toggle: () => (back ? close() : open()),
    isOpen: () => back !== null,
    destroy() {
      close();
      document.removeEventListener('keydown', onHotkey);
    },
  };
}
