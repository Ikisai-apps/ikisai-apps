import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { foldText } from '../palette.ts';

export interface LabelFamily {
  id: string;
  name: string;
  /** Color de la familia: tiñe los chips (pastel) y el punto de la cabecera. */
  color?: string | null;
  archived?: boolean;
  /** Solo una etiqueta de esta familia a la vez (p. ej. «Fase»). */
  single?: boolean;
}

export interface LabelItem {
  id: string;
  name: string;
  familyId: string;
  /** Etiqueta padre (un nivel): se muestra sangrada bajo su padre. */
  parentId?: string | null;
  archived?: boolean;
}

export interface LabelPickerOptions {
  families: LabelFamily[];
  labels: LabelItem[];
  selected?: string[];
  onChange?: (selected: string[]) => void;
  /** Ids que deben salir primero dentro de su familia (p. ej. las usadas en el proyecto). */
  preferred?: string[];
  /** Mostrar buscador; por defecto cuando hay más de 12 etiquetas. */
  search?: boolean;
  /** Familias que empiezan plegadas; por defecto se pliegan las que no tienen selección cuando hay más de 3 familias. */
  collapsed?: boolean | string[];
  /** Permite crear una etiqueta en una familia desde el buscador; devuelve la etiqueta creada (ya con id). */
  onCreate?: (familyId: string, name: string) => Promise<LabelItem> | LabelItem;
  /** Nombre accesible. */
  label?: string;
  disabled?: boolean;
  /** Chips heredados (p. ej. de las hijas) que se muestran apagados y no se pueden quitar. */
  inherited?: string[];
}

export interface LabelPicker {
  element: HTMLElement;
  get(): string[];
  set(selected: string[]): void;
  /** Sustituye catálogo (tras crear etiquetas o cambiar de área). */
  setCatalog(families: LabelFamily[], labels: LabelItem[]): void;
  destroy(): void;
}

/** Chips de las etiquetas dadas, coloreados por familia (para resúmenes y filas). */
export function labelChips(ids: string[], labels: LabelItem[], families: LabelFamily[], options: { onRemove?: (id: string) => void; inherited?: string[] } = {}): HTMLElement[] {
  const familyById = new Map(families.map((f) => [f.id, f]));
  const byId = new Map(labels.map((l) => [l.id, l]));
  return ids.flatMap((id) => {
    const label = byId.get(id);
    if (!label) return [];
    const color = familyById.get(label.familyId)?.color;
    const inherited = options.inherited?.includes(id);
    return [el('span', { class: `chip${inherited ? ' inherited' : ''}`, style: color ? `--chip:${color}` : null, dataset: { label: id } },
      el('span', null, label.name),
      options.onRemove && !inherited ? el('button', { class: 'x', type: 'button', 'aria-label': `Quitar ${label.name}`, onclick: () => options.onRemove?.(id) }, '×') : null,
    )];
  });
}

/** Selector de etiquetas por familias: chips conmutables, búsqueda sin acentos, familias plegables, padres e hijas, alta en línea. */
export function createLabelPicker(options: LabelPickerOptions): LabelPicker {
  let families = options.families.slice();
  let labels = options.labels.slice();
  let selected = (options.selected ?? []).slice();
  let query = '';
  const inherited = new Set(options.inherited ?? []);
  const summary = el('div', { class: 'chips lp-summary' });
  const groups = el('div', { class: 'lp-groups' });
  const search = el('input', { type: 'search', class: 'lp-search', placeholder: 'Buscar etiqueta…', 'aria-label': 'Buscar etiqueta', autocomplete: 'off', disabled: !!options.disabled, oninput: () => { query = foldText(search.value.trim()); paintGroups(); } });
  const element = el('div', { class: 'labelpicker', role: 'group', 'aria-label': options.label ?? 'Etiquetas' }, summary, groups);
  const open = new Set<string>();
  let initialised = false;

  function showSearch(): boolean {
    return options.search ?? labels.filter((l) => !l.archived).length > 12;
  }

  function toggle(id: string): void {
    const label = labels.find((l) => l.id === id);
    if (!label || inherited.has(id)) return;
    const family = families.find((f) => f.id === label.familyId);
    if (selected.includes(id)) selected = selected.filter((x) => x !== id);
    else {
      if (family?.single) selected = selected.filter((x) => labels.find((l) => l.id === x)?.familyId !== family.id);
      selected = [...selected, id];
    }
    paint();
    options.onChange?.(selected.slice());
  }

  function paintSummary(): void {
    const chips = labelChips(selected, labels, families, { onRemove: options.disabled ? undefined : toggle, inherited: [...inherited] });
    replace(summary, ...chips, chips.length ? null : el('span', { class: 'hint' }, 'Sin etiquetas.'));
  }

  function matches(l: LabelItem): boolean {
    return !query || foldText(l.name).includes(query);
  }

  function chipButton(l: LabelItem, color: string | null | undefined, child: boolean): HTMLElement {
    const on = selected.includes(l.id);
    return el('button', {
      type: 'button', class: `filterchip lp-chip${on ? ' on' : ''}${child ? ' child' : ''}`, style: color ? `--chip:${color}` : null,
      'aria-pressed': String(on), disabled: !!options.disabled || inherited.has(l.id), dataset: { label: l.id },
      onclick: () => toggle(l.id),
    }, on ? icon('check', 14) : null, el('span', null, l.name));
  }

  function paintGroups(): void {
    const preferred = new Set(options.preferred ?? []);
    const nodes: HTMLElement[] = [];
    for (const f of families.filter((x) => !x.archived)) {
      const all = labels.filter((l) => l.familyId === f.id && !l.archived);
      if (!all.length && !(options.onCreate && query)) continue;
      const visible = all.filter(matches);
      const matchingIds = new Set(visible.map((l) => l.id));
      // Un hijo visible arrastra a su padre y viceversa, para no perder el contexto.
      for (const l of visible) { if (l.parentId) matchingIds.add(l.parentId); }
      const roots = all.filter((l) => !l.parentId || !all.some((p) => p.id === l.parentId)).filter((l) => matchingIds.has(l.id) || all.some((c) => c.parentId === l.id && matchingIds.has(c.id)));
      const sortKey = (l: LabelItem) => (preferred.has(l.id) ? 0 : 1);
      roots.sort((a, b) => sortKey(a) - sortKey(b));
      const count = all.filter((l) => selected.includes(l.id)).length;
      const canCreate = options.onCreate && query && !all.some((l) => foldText(l.name) === query);
      if (!roots.length && !canCreate) continue;
      const isOpen = query ? true : open.has(f.id);
      const body = el('div', { class: 'lp-chips' },
        ...roots.flatMap((r) => [chipButton(r, f.color, false), ...all.filter((c) => c.parentId === r.id && matchingIds.has(c.id)).map((c) => chipButton(c, f.color, true))]),
        canCreate ? el('button', { type: 'button', class: 'filterchip lp-create', dataset: { createIn: f.id }, onclick: async () => { const created = await options.onCreate!(f.id, search.value.trim()); labels = [...labels, created]; search.value = ''; query = ''; selected = [...selected, created.id]; paint(); options.onChange?.(selected.slice()); } }, icon('plus', 14), el('span', null, `Crear «${search.value.trim()}»`)) : null,
      );
      const details = el('details', { class: 'lp-family', open: isOpen, dataset: { family: f.id }, ontoggle: (e: Event) => { const d = e.currentTarget as HTMLDetailsElement; if (d.open) open.add(f.id); else open.delete(f.id); } },
        el('summary', { class: 'lp-head' }, el('span', { class: 'dot', style: f.color ? `background:${f.color}` : null }), el('span', { class: 'lp-name' }, f.name), count ? el('span', { class: 'count' }, String(count)) : null, el('span', { class: 'lp-total muted' }, String(all.length))),
        body,
      );
      nodes.push(details);
    }
    replace(groups, showSearch() ? search : null, ...nodes, nodes.length ? null : el('p', { class: 'hint' }, query ? 'Ninguna etiqueta coincide.' : 'No hay etiquetas en el catálogo.'));
  }

  function paint(): void {
    if (!initialised) {
      initialised = true;
      const many = families.filter((f) => !f.archived).length > 3;
      for (const f of families) {
        const has = labels.some((l) => l.familyId === f.id && selected.includes(l.id));
        const collapsed = Array.isArray(options.collapsed) ? options.collapsed.includes(f.id) : options.collapsed ?? (many && !has);
        if (!collapsed) open.add(f.id);
      }
    }
    paintSummary();
    paintGroups();
  }

  paint();
  return {
    element,
    get: () => selected.slice(),
    set(next) { selected = next.slice(); paint(); },
    setCatalog(f, l) { families = f.slice(); labels = l.slice(); paint(); },
    destroy() { element.remove(); },
  };
}
