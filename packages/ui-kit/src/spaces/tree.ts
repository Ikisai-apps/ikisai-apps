/**
 * Árbol de espacios (`createSpaceTree`, RECURSOS.md §4.1 y §7): Altura › Edificio o Exterior › Espacio › Subespacio.
 * - **Ver:** desplegar y plegar, buscar (nombre, nombre público, código o ruta), datos de cada tipo en la fila, «Sin altura»
 *   para lo que la migración aún no ha colocado y «Ver archivados».
 * - **Editar** (permiso `edit`): ficha con nombre, nombre público, código, notas y datos del tipo.
 * - **Estructura** (permiso `structure`): crear dentro («+»), mover arrastrando el asa de 44×44 (encima o debajo = al
 *   lado; en el centro = dentro), subir y bajar (botones o flechas en el asa), «Mover a…», «Duplicar» con lo de dentro,
 *   «Archivar» (con todo lo de dentro) y «Recuperar». Las colocaciones no válidas se marcan con su motivo.
 * Trabaja contra `SpaceSource` (sin red: la cola local del sync-client) y repinta con `subscribe`.
 */
import { el, replace, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { kitLayer } from '../layer.ts';
import { kt } from '../i18n/i18n.ts';
import { openSheet, closeSheet } from '../overlay/sheet.ts';
import { alertDialog, confirmDialog } from '../overlay/dialog.ts';
import { toast } from '../toast.ts';
import { positionBetween } from '../sortable.ts';
import { attachSuggestions } from '../fields/suggest.ts';
import {
  DEFAULT_SPACE_KINDS, canPlace, childrenOf, indexSpaces, kindLabel, kindOf, kindsFor, newSpaceId, nextAltura, spaceDescendants,
  spaceMatches, spacePath, ancestorsOf, type SpaceKind, type SpaceRow, type SpaceSource,
} from './model.ts';
import { createSpacePicker } from './picker.ts';

export interface SpaceTreeOptions {
  source: SpaceSource;
  /** Tipos (los de `space_kinds` cuando los dé `resources-api`); por defecto los de RECURSOS.md §11.1. */
  kinds?: SpaceKind[];
  /** `edit`: nombre, datos y notas (editor). `structure`: crear, mover y archivar (administrador). */
  permissions?: { edit?: boolean; structure?: boolean };
  /** Solo estas filas (y sus antepasados, para la ruta): p. ej. lo reservable en Booking. */
  filter?: (row: SpaceRow) => boolean;
  /** Nombre accesible del árbol. */
  label?: string;
  /** Base de las marcas de feedback y uso (`'booking.espacios.arbol'`). */
  feedbackId?: string;
  /** Contenedor de las hojas (apps con CSS acotado). */
  container?: HTMLElement;
  /** Clave para recordar qué está desplegado (en el navegador). */
  storageKey?: string;
}

export interface SpaceTree {
  element: HTMLElement;
  /** Vuelve a leer la fuente. */
  refresh(): Promise<void>;
  expand(id: string): void;
  collapse(id: string): void;
  destroy(): void;
}

/** Sufijos y etiquetas de las marcas (los lee también el catálogo, `feature-catalog.mjs`). */
export const SPACE_TREE_MARKS = {
  search: ['buscar', 'Buscar espacio'],
  newAltura: ['nueva_altura', 'Nueva altura'],
  archived: ['ver_archivados', 'Ver archivados'],
  row: ['fila', 'Espacio'],
  toggle: ['desplegar', 'Desplegar o plegar'],
  handle: ['mover', 'Arrastrar para mover'],
  add: ['anadir', 'Añadir dentro'],
  edit: ['editar', 'Editar espacio'],
  up: ['subir', 'Subir'],
  down: ['bajar', 'Bajar'],
  save: ['guardar', 'Guardar espacio'],
  duplicate: ['duplicar', 'Duplicar'],
  archive: ['archivar', 'Archivar'],
  restore: ['recuperar', 'Recuperar'],
} as const;

const LEGACY = '__sin_altura__';

type Drop = { mode: 'before' | 'after' | 'inside'; target: SpaceRow; parent: SpaceRow | null; position: number } | null;

function summary(kinds: readonly SpaceKind[], row: SpaceRow): string {
  const k = kindOf(kinds, row.kind);
  const parts: string[] = [];
  for (const attr of k?.attributes ?? []) {
    const value = row.attributes?.[attr.key];
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (attr.type === 'boolean') parts.push(kt(attr.label));
    else if (attr.type === 'number') parts.push(`${kt(attr.label)} ${value}`);
    else parts.push(kt(attr.options.find((o) => o.value === value)?.label ?? String(value)));
  }
  return parts.join(' · ');
}

function readExpanded(key: string | undefined): Set<string> | null {
  if (!key) return null;
  try { const raw = localStorage.getItem(`ikisai-space-tree:${key}`); return raw ? new Set(JSON.parse(raw) as string[]) : null; } catch { return null; }
}

export function createSpaceTree(options: SpaceTreeOptions): SpaceTree {
  let kinds = options.kinds ?? DEFAULT_SPACE_KINDS;
  const canEdit = options.permissions?.edit ?? true;
  const canStructure = options.permissions?.structure ?? false;
  const base = options.feedbackId;
  const mark = (key: keyof typeof SPACE_TREE_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${SPACE_TREE_MARKS[key][0]}`, 'data-feedback-label': SPACE_TREE_MARKS[key][1] } : {});

  let rows: SpaceRow[] = [];
  let byId = new Map<string, SpaceRow>();
  let query = '';
  let showArchived = false;
  let expanded = readExpanded(options.storageKey);
  let unsubscribe: (() => void) | null = null;

  const live = el('div', { class: 'vh', 'aria-live': 'polite' });
  const search = el('input', { type: 'search', class: 'space-tree-search', placeholder: kt('Buscar espacio'), 'aria-label': kt('Buscar espacio'), autocomplete: 'off', ...mark('search'),
    oninput: () => { query = search.value; paint(); } }) as HTMLInputElement;
  const archivedToggle = el('input', { type: 'checkbox', onchange: () => { showArchived = archivedToggle.checked; paint(); } }) as HTMLInputElement;
  const newAltura = canStructure ? el('button', { type: 'button', class: 'ghost small', ...mark('newAltura'), onclick: () => openCreate(null) }, icon('plus', 16), kt('Altura')) : null;
  const list = el('ul', { class: 'space-tree-list', role: 'list', 'aria-label': options.label ?? kt('Espacios') });
  const element = el('div', { class: 'space-tree', ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label ?? 'Espacios' } : {}) },
    el('div', { class: 'space-tree-bar' }, search, newAltura),
    list,
    el('label', { class: 'space-tree-archived', ...mark('archived') }, archivedToggle, kt('Ver archivados')),
    live,
  );

  const visibleRow = (r: SpaceRow) => (showArchived || r.active);
  function defaultExpanded(): Set<string> {
    return new Set(rows.filter((r) => (kindOf(kinds, r.kind)?.level ?? 9) <= 2).map((r) => r.id).concat(LEGACY));
  }
  function isOpen(id: string): boolean { return (expanded ?? defaultExpanded()).has(id); }
  function setOpen(id: string, open: boolean): void {
    const next = new Set(expanded ?? defaultExpanded());
    if (open) next.add(id); else next.delete(id);
    expanded = next;
    if (options.storageKey) { try { localStorage.setItem(`ikisai-space-tree:${options.storageKey}`, JSON.stringify([...next])); } catch { /* sin almacenamiento */ } }
    paint();
  }

  /** Filas que se pintan: con búsqueda o filtro, las que coinciden y sus antepasados (desplegados). */
  function shownIds(): Set<string> | null {
    if (!query.trim() && !options.filter) return null;
    const out = new Set<string>();
    for (const r of rows) {
      if (!visibleRow(r)) continue;
      if (options.filter && !options.filter(r)) continue;
      if (query.trim() && !spaceMatches(byId, r, query)) continue;
      out.add(r.id);
      for (const a of ancestorsOf(byId, r.id)) out.add(a.id);
    }
    return out;
  }

  function isLegacyRoot(r: SpaceRow): boolean { return r.parentId === null && (kindOf(kinds, r.kind)?.level ?? 1) > 1; }

  function paint(): void {
    const shown = shownIds();
    const forced = shown !== null && query.trim() !== '';
    const items: HTMLElement[] = [];
    const walk = (parentId: string | null, depth: number, legacy = false) => {
      const kids = rows.filter((r) => r.parentId === parentId && visibleRow(r) && (!shown || shown.has(r.id)) && (parentId !== null || isLegacyRoot(r) === legacy))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      kids.forEach((r, i) => {
        const hasKids = rows.some((c) => c.parentId === r.id && visibleRow(c) && (!shown || shown.has(c.id)));
        const open = hasKids && (forced || isOpen(r.id));
        items.push(rowEl(r, depth, hasKids, open, i, kids.length));
        if (open) walk(r.id, depth + 1);
      });
    };
    walk(null, 0);
    const legacyCount = rows.filter((r) => isLegacyRoot(r) && visibleRow(r) && (!shown || shown.has(r.id))).length;
    if (legacyCount) {
      const open = forced || isOpen(LEGACY);
      items.push(el('li', { class: 'space-group', dataset: { group: 'legacy' } },
        el('button', { type: 'button', class: 'space-toggle', 'aria-expanded': String(open), ...mark('toggle'), onclick: () => setOpen(LEGACY, !open) }, icon(open ? 'chevronDown' : 'chevronRight', 16)),
        el('strong', null, kt('Sin altura')), el('span', { class: 'space-count' }, String(legacyCount)),
        el('span', { class: 'hint' }, kt('Por colocar: arrástralos a su altura.'))));
      if (open) walk(null, 1, true);
    }
    if (!items.length) items.push(el('li', { class: 'empty' }, query.trim() ? kt('Ningún espacio coincide con «{q}».', { q: query.trim() }) : kt('Todavía no hay espacios.')));
    replace(list, ...items);
  }

  function rowEl(r: SpaceRow, depth: number, hasKids: boolean, open: boolean, index: number, count: number): HTMLElement {
    const k = kindOf(kinds, r.kind);
    const childKinds = canStructure && r.active ? kindsFor(kinds, r) : [];
    const sub = r.kind === 'altura' ? r.notes : summary(kinds, r);
    const path = spacePath(byId, r.id);
    const handle = canStructure && r.active && !query.trim()
      ? el('button', { type: 'button', class: 'space-handle', 'aria-label': kt('Mover {name}. Flechas para subir o bajar; arrastrar para llevarlo a otro sitio.', { name: path }), ...mark('handle'),
        onkeydown: (e: Event) => onKey(e as KeyboardEvent, r), onpointerdown: (e: Event) => onPointerDown(e as PointerEvent, r) }, icon('grip', 18))
      : el('span', { class: 'space-handle-slot', 'aria-hidden': 'true' });
    const toggle = hasKids
      ? el('button', { type: 'button', class: 'space-toggle', 'aria-expanded': String(open), 'aria-label': open ? kt('Plegar {name}', { name: r.name }) : kt('Desplegar {name}', { name: r.name }), ...mark('toggle'), onclick: () => setOpen(r.id, !open) }, icon(open ? 'chevronDown' : 'chevronRight', 16))
      : el('span', { class: 'space-toggle-slot', 'aria-hidden': 'true' });
    const body = el('button', { type: 'button', class: 'space-body', 'aria-label': `${path}, ${kindLabel(kinds, r.kind)}${r.active ? '' : `, ${kt('archivado')}`}`, ...mark('row'),
      onclick: () => openEdit(r) },
      el('span', { class: 'space-name' }, r.name, r.code ? el('span', { class: 'space-code' }, r.code) : null),
      el('span', { class: 'space-kind' }, kt(k?.label ?? r.kind)),
      sub ? el('span', { class: 'space-sub' }, sub) : null,
      r.pending ? el('span', { class: 'space-pending', title: kt('Sin enviar todavía') }, kt('Sin enviar')) : null,
    );
    const actions = el('div', { class: 'space-actions' },
      childKinds.length ? el('button', { type: 'button', class: 'iconbtn', 'aria-label': kt('Añadir dentro de {name}', { name: r.name }), ...mark('add'), onclick: () => openCreate(r) }, icon('plus', 18)) : null,
      canEdit ? el('button', { type: 'button', class: 'iconbtn', 'aria-label': kt('Editar {name}', { name: r.name }), ...mark('edit'), onclick: () => openEdit(r) }, icon('edit', 18)) : null,
      canStructure && r.active && !query.trim() ? el('div', { class: 'space-moves' },
        el('button', { type: 'button', class: 'iconbtn small', disabled: index === 0, 'aria-label': kt('Subir {name}', { name: r.name }), ...mark('up'), onclick: () => void step(r, -1) }, icon('chevronUp', 16)),
        el('button', { type: 'button', class: 'iconbtn small', disabled: index === count - 1, 'aria-label': kt('Bajar {name}', { name: r.name }), ...mark('down'), onclick: () => void step(r, 1) }, icon('chevronDown', 16)),
      ) : null,
    );
    return el('li', { class: `space-row${r.active ? '' : ' archived'}`, style: `--depth:${depth}`, dataset: { id: r.id, kind: r.kind, level: String(k?.level ?? ''), pending: String(!!r.pending) } },
      handle, toggle, body, actions);
  }

  // --- Mover ------------------------------------------------------------------------
  function siblingsOf(r: SpaceRow): SpaceRow[] {
    return childrenOf(rows, r.parentId).filter((s) => r.parentId !== null || isLegacyRoot(s) === isLegacyRoot(r));
  }

  async function commitMove(r: SpaceRow, parent: SpaceRow | null, position: number): Promise<void> {
    const parentId = parent?.id ?? null;
    if (parentId === r.parentId && position === r.position) return;
    // Optimista: se pinta ya; la fuente avisa con `subscribe`.
    rows = rows.map((x) => (x.id === r.id ? { ...x, parentId, position } : x));
    byId = indexSpaces(rows);
    if (parent) setOpen(parent.id, true); else paint();
    live.textContent = kt('{name} movido a {path}.', { name: r.name, path: parent ? spacePath(byId, parent.id) : kt('la raíz') });
    try {
      await options.source.update(r.id, { parentId, position });
    } catch (error) {
      toast(error instanceof Error ? error.message : kt('No se ha podido mover.'));
      await refresh();
    }
  }

  async function step(r: SpaceRow, delta: -1 | 1): Promise<void> {
    const sibs = siblingsOf(r);
    const i = sibs.findIndex((s) => s.id === r.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= sibs.length) return;
    const others = sibs.filter((s) => s.id !== r.id);
    const at = j; // índice en `others` (sin la fila) donde queda
    const prev = others[at - 1]?.position ?? null;
    const next = others[at]?.position ?? null;
    await commitMove(r, r.parentId ? byId.get(r.parentId) ?? null : null, positionBetween(prev, next));
    focusHandle(r.id);
  }

  function focusHandle(id: string): void {
    list.querySelector<HTMLElement>(`.space-row[data-id="${CSS.escape(id)}"] .space-handle`)?.focus({ preventScroll: true });
  }

  function onKey(e: KeyboardEvent, r: SpaceRow): void {
    if (e.key === 'ArrowUp') { e.preventDefault(); void step(r, -1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); void step(r, 1); }
  }

  /** Dónde caería `moving` según el puntero sobre `target` (zona superior, central o inferior). */
  function dropFor(moving: SpaceRow, target: SpaceRow, ratio: number, retry = true): { drop: Drop; reason: string | null } {
    const mode: 'before' | 'after' | 'inside' = ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'inside';
    if (target.id === moving.id) return { drop: null, reason: null };
    const parent = mode === 'inside' ? target : (target.parentId ? byId.get(target.parentId) ?? null : null);
    const legacyRoot = parent === null && moving.parentId === null && isLegacyRoot(moving) && isLegacyRoot(target);
    const placement = canPlace(kinds, moving.kind, parent, { rows, movingId: moving.id, legacyRoot });
    if (!placement.ok) {
      // Si donde apunta no vale, se prueba lo otro antes de rechazar: en el centro de un hermano, al lado; en el borde de
      // un padre posible (una cama en el borde de una habitación), dentro.
      if (!retry) return { drop: null, reason: placement.reason };
      if (mode === 'inside') {
        const side = dropFor(moving, target, ratio < 0.5 ? 0 : 1, false);
        if (side.drop) return side;
      } else {
        const inside = dropFor(moving, target, 0.5, false);
        if (inside.drop?.mode === 'inside') return inside;
      }
      return { drop: null, reason: placement.reason };
    }
    let position: number;
    if (mode === 'inside') {
      const kids = childrenOf(rows, target.id).filter((c) => c.id !== moving.id);
      position = positionBetween(kids[kids.length - 1]?.position ?? null, null);
    } else {
      const sibs = siblingsOf(target).filter((s) => s.id !== moving.id);
      const i = sibs.findIndex((s) => s.id === target.id);
      position = mode === 'before' ? positionBetween(sibs[i - 1]?.position ?? null, target.position) : positionBetween(target.position, sibs[i + 1]?.position ?? null);
    }
    return { drop: { mode, target, parent, position }, reason: null };
  }

  function onPointerDown(e: PointerEvent, r: SpaceRow): void {
    if (e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    const rowNode = handle.closest<HTMLElement>('.space-row')!;
    const touchy = e.pointerType === 'touch';
    const d = { x: e.clientX, y: e.clientY, started: false, hold: !touchy, ghost: null as HTMLElement | null, timer: null as ReturnType<typeof setTimeout> | null, drop: null as Drop, reason: null as string | null };
    const clearMarks = () => list.querySelectorAll('.space-row').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'drop-inside', 'drop-invalid'));
    const start = () => {
      if (d.started) return;
      d.started = true;
      handle.setPointerCapture(e.pointerId);
      rowNode.classList.add('lifting');
      const g = el('div', { class: 'space-ghost' }, el('strong', null, r.name), el('span', { class: 'space-ghost-reason' }));
      g.style.left = `${rowNode.getBoundingClientRect().left + 24}px`;
      g.style.top = `${d.y - 18}px`;
      kitLayer(options.container).append(g);
      d.ghost = g;
      document.body.classList.add('dragging');
    };
    // Captura desde el primer momento: el movimiento sale del asa enseguida y tiene que seguir llegándole.
    try { handle.setPointerCapture(e.pointerId); } catch { /* puntero ya liberado */ }
    if (touchy) d.timer = setTimeout(() => { d.hold = true; start(); }, 320);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      if (!d.started) {
        if (!d.hold) { if (Math.hypot(dx, dy) > 8) cleanup(); return; }
        if (Math.hypot(dx, dy) > 6) start();
        if (!d.started) return;
      }
      ev.preventDefault();
      if (d.ghost) d.ghost.style.top = `${ev.clientY - 18}px`;
      clearMarks();
      d.drop = null; d.reason = null;
      const over = Array.from(list.querySelectorAll<HTMLElement>('.space-row')).find((n) => { const b = n.getBoundingClientRect(); return ev.clientY >= b.top && ev.clientY <= b.bottom; });
      const target = over ? byId.get(over.dataset.id!) : undefined;
      if (over && target) {
        const b = over.getBoundingClientRect();
        const result = dropFor(r, target, (ev.clientY - b.top) / b.height);
        d.drop = result.drop; d.reason = result.reason;
        if (result.drop) {
          const node = list.querySelector<HTMLElement>(`.space-row[data-id="${CSS.escape(result.drop.target.id)}"]`);
          node?.classList.add(`drop-${result.drop.mode}`);
        } else if (result.reason) over.classList.add('drop-invalid');
      }
      if (d.ghost) {
        d.ghost.classList.toggle('invalid', !!d.reason);
        d.ghost.querySelector('.space-ghost-reason')!.textContent = d.reason ?? (d.drop ? (d.drop.mode === 'inside' ? kt('Dentro de {name}', { name: d.drop.target.name }) : kt('Junto a {name}', { name: d.drop.target.name })) : '');
      }
      const margin = 48;
      if (ev.clientY < margin) window.scrollBy(0, -10);
      else if (ev.clientY > window.innerHeight - margin) window.scrollBy(0, 10);
    };
    const cleanup = () => {
      if (d.timer) clearTimeout(d.timer);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      rowNode.classList.remove('lifting');
      d.ghost?.remove();
      document.body.classList.remove('dragging');
      clearMarks();
    };
    const end = () => {
      const { started, drop, reason } = d;
      cleanup();
      if (!started) return;
      if (drop) void commitMove(r, drop.parent, drop.position);
      else if (reason) { live.textContent = reason; toast(reason); }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // --- Ficha ------------------------------------------------------------------------
  function attributeField(kind: SpaceKind | undefined, values: Record<string, unknown>, disabled: boolean): HTMLElement[] {
    return (kind?.attributes ?? []).map((attr) => {
      const name = `attr_${attr.key}`;
      if (attr.type === 'boolean') {
        return el('label', { class: 'field check' }, el('input', { type: 'checkbox', name, checked: values[attr.key] === true, disabled }), el('span', null, kt(attr.label)));
      }
      if (attr.type === 'number') {
        const input = el('input', { type: 'number', name, inputmode: 'numeric', min: attr.min ?? null, disabled }) as HTMLInputElement;
        if (typeof values[attr.key] === 'number') input.value = String(values[attr.key]);
        return el('label', { class: 'field' }, el('span', null, kt(attr.label)), input);
      }
      const select = el('select', { name, disabled }, el('option', { value: '' }, '—'), ...attr.options.map((o) => el('option', { value: o.value }, kt(o.label)))) as HTMLSelectElement;
      select.value = typeof values[attr.key] === 'string' ? String(values[attr.key]) : '';
      return el('label', { class: 'field' }, el('span', null, kt(attr.label)), select);
    });
  }

  function readAttributes(form: HTMLFormElement, kind: SpaceKind | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const attr of kind?.attributes ?? []) {
      const input = form.elements.namedItem(`attr_${attr.key}`) as HTMLInputElement | HTMLSelectElement | null;
      if (!input) continue;
      if (attr.type === 'boolean') out[attr.key] = (input as HTMLInputElement).checked;
      else if (attr.type === 'number') { if (input.value !== '') out[attr.key] = Number(input.value); }
      else if (input.value) out[attr.key] = input.value;
    }
    return out;
  }

  function nameField(value: string, siblings: SpaceRow[], readonly: boolean): { element: HTMLElement; input: HTMLInputElement } {
    const input = el('input', { type: 'text', name: 'name', required: true, autocomplete: 'off', readonly, id: `space-name-${newSpaceId()}` }) as HTMLInputElement;
    input.value = value;
    // Campo con sugerencias (0.27) en modo «único»: avisa si ya hay uno igual al lado.
    const hint = attachSuggestions(input, { values: siblings.map((s) => s.name), mode: 'unique' });
    // Solo el aviso: la lista desplegable de los hermanos no ayuda a poner un nombre nuevo.
    input.removeAttribute('list');
    return { element: el('label', { class: 'field' }, el('span', null, kt('Nombre')), input, hint.element), input };
  }

  function textField(label: string, name: string, value: string | null, disabled: boolean, multiline = false): HTMLElement {
    const input = multiline
      ? el('textarea', { name, rows: '3', disabled }) as HTMLTextAreaElement
      : el('input', { type: 'text', name, disabled, autocomplete: 'off' }) as HTMLInputElement;
    input.value = value ?? '';
    return el('label', { class: 'field' }, el('span', null, label), input);
  }

  function openEdit(r: SpaceRow): void {
    const k = kindOf(kinds, r.kind);
    const readonly = !canEdit;
    const isAltura = r.kind === 'altura';
    const siblings = siblingsOf(r).filter((s) => s.id !== r.id);
    const name = nameField(r.name, siblings, readonly || isAltura);
    let moveTo: string | null | undefined;
    const structure: Child[] = [];
    if (canStructure && r.active && !isAltura) {
      const picker = createSpacePicker({
        rows, kinds, label: kt('Mover a…'), placeholder: kt('Buscar dónde ponerlo'),
        filter: (p) => p.id !== r.id && canPlace(kinds, r.kind, p, { rows, movingId: r.id }).ok,
        onChange: (ids) => { moveTo = ids[0] ?? undefined; },
        quick: [], recentKey: options.storageKey ? `${options.storageKey}-mover` : undefined,
        feedbackId: base ? `${base}.ficha.mover_a` : undefined,
      });
      structure.push(el('div', { class: 'space-sheet-section' },
        el('p', { class: 'hint' }, kt('Ahora en: {path}', { path: r.parentId ? spacePath(byId, r.parentId) : kt('Sin altura') })), picker.element));
    }
    const form = el('form', { class: 'space-form', novalidate: true },
      el('p', { class: 'hint' }, `${kindLabel(kinds, r.kind)} · ${spacePath(byId, r.id)}`),
      name.element,
      isAltura ? textField(kt('Descripción'), 'notes', r.notes, readonly) : null,
      isAltura ? null : textField(kt('Nombre público (huéspedes y organizadores)'), 'publicName', r.publicName, readonly),
      isAltura ? null : textField(kt('Código'), 'code', r.code, readonly),
      ...attributeField(k, r.attributes ?? {}, readonly),
      isAltura ? null : textField(kt('Notas'), 'notes', r.notes, readonly, true),
      ...structure,
    ) as HTMLFormElement;
    const extra = canStructure ? [
      r.active && !isAltura ? el('button', { type: 'button', class: 'ghost', ...mark('duplicate'), onclick: () => void duplicate(r) }, kt('Duplicar')) : null,
      r.active ? el('button', { type: 'button', class: 'danger', ...mark('archive'), onclick: () => void archive(r) }, kt('Archivar'))
        : el('button', { type: 'button', class: 'ghost', ...mark('restore'), onclick: () => void restore(r) }, kt('Recuperar')),
    ] : [];
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!canEdit) return;
      const data = new FormData(form);
      const fields: Partial<SpaceRow> = {};
      const nextName = name.input.value.trim();
      if (!nextName) { name.input.focus(); toast(kt('El nombre no puede quedar vacío.')); return; }
      if (nextName !== r.name) fields.name = nextName;
      for (const key of ['publicName', 'code', 'notes'] as const) {
        if (!data.has(key)) continue;
        const v = String(data.get(key) ?? '').trim() || null;
        if (v !== (r[key] ?? null)) fields[key] = v;
      }
      const attrs = readAttributes(form, k);
      if (JSON.stringify({ ...r.attributes, ...attrs }) !== JSON.stringify(r.attributes ?? {})) fields.attributes = { ...r.attributes, ...attrs };
      void (async () => {
        try {
          if (Object.keys(fields).length) await options.source.update(r.id, fields);
          if (moveTo !== undefined && moveTo !== r.parentId) {
            const parent = moveTo ? byId.get(moveTo) ?? null : null;
            const kids = childrenOf(rows, moveTo).filter((c) => c.id !== r.id);
            await closeSheet(true);
            await commitMove(r, parent, positionBetween(kids[kids.length - 1]?.position ?? null, null));
            return;
          }
          await closeSheet(true);
          if (Object.keys(fields).length) toast(kt('Guardado.'));
        } catch (error) {
          toast(error instanceof Error ? error.message : kt('No se ha podido guardar.'));
        }
      })();
    });
    openSheet({
      title: r.name, body: form, container: options.container,
      foot: el('div', { class: 'space-sheet-foot' }, ...extra, canEdit ? el('button', { type: 'button', class: 'primary', ...mark('save'), onclick: () => form.requestSubmit() }, kt('Guardar')) : null),
    });
  }

  function openCreate(parent: SpaceRow | null): void {
    const options2 = parent ? kindsFor(kinds, parent) : kinds.filter((k) => k.level === 1);
    if (!options2.length) return;
    let kind = options2[0]!;
    const siblings = childrenOf(rows, parent?.id ?? null);
    const altura = !parent ? nextAltura(rows) : null;
    if (!parent && altura === null) { void alertDialog(kt('Ya están las cinco alturas'), kt('Recupera una archivada o cambia la descripción de una que ya existe.')); return; }
    const name = nameField(!parent ? `Altura ${altura}` : '', siblings, !parent);
    const attrsHost = el('div', { class: 'space-attrs' });
    const paintAttrs = () => replace(attrsHost, ...attributeField(kind, {}, false));
    const kindSelect = el('select', { name: 'kind', onchange: () => { kind = options2.find((k) => k.kind === kindSelect.value) ?? kind; paintAttrs(); } },
      ...options2.map((k) => el('option', { value: k.kind }, kt(k.label)))) as HTMLSelectElement;
    paintAttrs();
    const form = el('form', { class: 'space-form', novalidate: true },
      el('p', { class: 'hint' }, parent ? kt('Dentro de {path}', { path: spacePath(byId, parent.id) }) : kt('Nivel superior')),
      options2.length > 1 ? el('label', { class: 'field' }, el('span', null, kt('Tipo')), kindSelect) : null,
      name.element,
      !parent ? textField(kt('Descripción'), 'notes', null, false) : null,
      attrsHost,
    ) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = name.input.value.trim();
      if (!value) { name.input.focus(); toast(kt('Pon un nombre.')); return; }
      const notes = String(new FormData(form).get('notes') ?? '').trim() || null;
      const row: SpaceRow = {
        id: newSpaceId(), parentId: parent?.id ?? null, kind: kind.kind, name: value, publicName: null, code: null,
        position: positionBetween(siblings[siblings.length - 1]?.position ?? null, null), active: true, notes, attributes: readAttributes(form, kind),
      };
      void (async () => {
        try {
          await options.source.create(row);
          await closeSheet(true);
          if (parent) setOpen(parent.id, true);
          toast(kt('Creado «{name}».', { name: value }));
        } catch (error) {
          toast(error instanceof Error ? error.message : kt('No se ha podido crear.'));
        }
      })();
    });
    openSheet({
      title: parent ? kt('Nuevo espacio') : kt('Nueva altura'), body: form, container: options.container,
      initialFocus: parent ? name.input : null,
      foot: el('div', { class: 'space-sheet-foot' }, el('button', { type: 'button', class: 'primary', ...mark('save'), onclick: () => form.requestSubmit() }, kt('Crear'))),
    });
  }

  async function duplicate(r: SpaceRow): Promise<void> {
    const ids = [r.id, ...spaceDescendants(rows, r.id)];
    const map = new Map(ids.map((id) => [id, newSpaceId()]));
    const sibs = siblingsOf(r);
    const i = sibs.findIndex((s) => s.id === r.id);
    const copies = ids.map((id) => {
      const src = byId.get(id)!;
      const top = id === r.id;
      return {
        ...src, id: map.get(id)!, parentId: top ? src.parentId : map.get(src.parentId!) ?? src.parentId,
        name: top ? kt('{name} (copia)', { name: src.name }) : src.name, code: top ? null : src.code, pending: undefined,
        position: top ? positionBetween(r.position, sibs[i + 1]?.position ?? null) : src.position, attributes: { ...src.attributes },
      } satisfies SpaceRow;
    });
    try {
      await options.source.createMany(copies);
      await closeSheet(true);
      toast(ids.length > 1 ? kt('Duplicado con {n} espacios de dentro.', { n: String(ids.length - 1) }) : kt('Duplicado.'));
    } catch (error) {
      toast(error instanceof Error ? error.message : kt('No se ha podido duplicar.'));
    }
  }

  async function archive(r: SpaceRow): Promise<void> {
    const inside = spaceDescendants(rows, r.id);
    const ok = await confirmDialog({
      title: inside.length ? kt('¿Archivar «{name}» y {n} espacios de dentro?', { name: r.name, n: String(inside.length) }) : kt('¿Archivar «{name}»?', { name: r.name }),
      text: kt('Deja de salir para elegir y en las listas. No se borra: se puede recuperar con «Ver archivados».'),
      confirmLabel: kt('Archivar'), danger: true, container: options.container,
    } as Parameters<typeof confirmDialog>[0]);
    if (!ok) return;
    try {
      await options.source.archive([r.id, ...inside]);
      await closeSheet(true);
      toast(kt('Archivado.'));
    } catch (error) {
      // El servidor se niega si dentro hay reservas futuras, stock o tareas abiertas: se enseña su motivo tal cual.
      await alertDialog(kt('No se puede archivar'), error instanceof Error ? error.message : String(error));
    }
  }

  async function restore(r: SpaceRow): Promise<void> {
    const archivedAncestors = ancestorsOf(byId, r.id).filter((a) => !a.active).map((a) => a.id);
    const inside = spaceDescendants(rows, r.id, true).filter((id) => !byId.get(id)?.active);
    try {
      await options.source.restore([...archivedAncestors, r.id, ...inside]);
      await closeSheet(true);
      toast(kt('Recuperado.'));
    } catch (error) {
      toast(error instanceof Error ? error.message : kt('No se ha podido recuperar.'));
    }
  }

  function setRows(next: SpaceRow[]): void {
    rows = next;
    byId = indexSpaces(rows);
    paint();
  }

  async function refresh(): Promise<void> { setRows(await options.source.list()); }

  unsubscribe = options.source.subscribe(setRows);
  // Tipos como datos (`space_kinds`) si la fuente los da y la app no fijó `kinds`.
  const setKinds = (next: SpaceKind[]) => { if (next.length) { kinds = next; paint(); } };
  const offKinds = !options.kinds && options.source.subscribeKinds ? options.source.subscribeKinds(setKinds) : null;
  if (!options.kinds && options.source.listKinds) void Promise.resolve(options.source.listKinds()).then(setKinds);
  void refresh();
  return {
    element,
    refresh,
    expand: (id) => setOpen(id, true),
    collapse: (id) => setOpen(id, false),
    destroy() { unsubscribe?.(); offKinds?.(); element.remove(); },
  };
}
