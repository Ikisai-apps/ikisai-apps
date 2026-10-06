import { el, type Child } from './dom.ts';

export interface ListRowSpec {
  id: string;
  title: Child;
  /** Fragmentos de la línea secundaria; se separan con un punto. */
  meta?: Child[];
  /** Chips tras el título (además del de «pendiente» y «en papelera», que pone el componente). */
  chips?: Child[];
  actions?: Child[];
  /** Guardado en este dispositivo y aún no confirmado por el servidor (`row._pending`). */
  pending?: boolean;
  deleted?: boolean;
  selected?: boolean;
  /** Al pulsar la fila (no sus acciones). */
  onClick?: (event: Event) => void;
  /** Texto accesible de la fila cuando es pulsable. */
  label?: string;
}

export interface ListOptions {
  /** Texto del chip pendiente; por defecto «Pendiente de sincronizar». */
  pendingLabel?: string;
  deletedLabel?: string;
}

/** Fila de lista con estado de sincronización visible (contrato §6.4): chip y filete cuando está pendiente. */
export function listRow(spec: ListRowSpec, options: ListOptions = {}): HTMLLIElement {
  const classes = ['row'];
  if (spec.deleted) classes.push('deleted');
  if (spec.selected) classes.push('selected');
  if (spec.onClick) classes.push('selectable');
  const row = el('li', {
    class: classes.join(' '),
    dataset: { id: spec.id, pending: String(!!spec.pending) },
    ...(spec.onClick ? { tabindex: '0', role: 'button', 'aria-label': spec.label ?? undefined } : {}),
  },
    el('div', { class: 'row-title' },
      el('span', { class: 'name' }, spec.title),
      ...(spec.chips ?? []),
      spec.pending ? el('span', { class: 'chip pending', title: 'Guardado en este dispositivo; se enviará al servidor cuando haya red' }, el('span', null, options.pendingLabel ?? 'Pendiente de sincronizar')) : null,
      spec.deleted ? el('span', { class: 'chip trash' }, el('span', null, options.deletedLabel ?? 'En papelera')) : null,
    ),
    spec.meta?.length ? el('div', { class: 'row-meta' }, ...spec.meta.map((m) => el('span', null, m))) : null,
    spec.actions?.length ? el('div', { class: 'row-actions', onclick: (e: Event) => e.stopPropagation() }, ...spec.actions) : null,
  );
  if (spec.onClick) {
    row.addEventListener('click', spec.onClick);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); spec.onClick?.(e); } });
  }
  return row;
}

export interface ListSpec {
  rows: ListRowSpec[];
  /** Nombre accesible de la lista. */
  label: string;
  id?: string;
  /** Estado vacío: título y texto. */
  empty?: { title?: string; text: Child };
  options?: ListOptions;
}

/** Lista completa o su estado vacío. */
export function renderList(spec: ListSpec): HTMLElement {
  if (spec.rows.length === 0 && spec.empty) {
    return el('div', { class: 'empty', id: spec.id ?? null }, spec.empty.title ? el('strong', null, spec.empty.title) : null, spec.empty.text);
  }
  return el('ul', { class: 'list', 'aria-label': spec.label, id: spec.id ?? null }, ...spec.rows.map((row) => listRow(row, spec.options)));
}
