/** Inventario de espacios y camas (docs/booking/API.md §15.1): habitaciones con sus camas, salas y zonas exteriores, por zona y reordenables. */
import type { RowOperation, SyncedRow, TableName } from '@ikisai/sync-client';
import { createSortableList, el, icon, plural, positionBetween, renumber, replace, toast, type Sortable } from '@ikisai/ui-kit';
import { spaceCapacity } from '@ikisai/domain-booking';
import { ASSIGNMENTS, BEDS, SPACES, canRead, canWrite, describeError } from '../app/client.ts';
import { OPTIONS, label } from '../app/labels.ts';
import { openRowSheet, type FieldSpec } from './form.ts';
import type { ViewMount } from './shell.ts';

type Row = SyncedRow & Record<string, any>;

const NO_ZONE = 'Sin zona';

const SPACE_SPECS: FieldSpec[] = [
  { key: 'name', label: 'Nombre', type: 'text', max: 120 },
  { key: 'kind', label: 'Tipo', type: 'select', options: OPTIONS.spaceKind },
  { key: 'zone', label: 'Zona', type: 'text', max: 120, hint: 'Por ejemplo «Planta baja» o «Edificio norte». Agrupa la lista.' },
  { key: 'capacity', label: 'Capacidad', type: 'number', hint: 'Solo en salas y zonas. En una habitación se suman las plazas de sus camas.' },
  { key: 'accessible', label: 'Accesible', type: 'check' },
  { key: 'active', label: 'Activo', type: 'check' },
  { key: 'notes', label: 'Notas', type: 'textarea' },
];

const BED_SPECS: FieldSpec[] = [
  { key: 'label', label: 'Etiqueta', type: 'text', max: 80 },
  { key: 'kind', label: 'Tipo de cama', type: 'select', options: OPTIONS.bedKind },
  { key: 'capacity', label: 'Plazas', type: 'number', hint: '1 o 2 personas.' },
  { key: 'active', label: 'Activa', type: 'check' },
];

const del = (table: TableName, row: Row): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });
const byPosition = (a: Row, b: Row) => Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);

/** Monta la pantalla `#/espacios`. */
export const mountSpaces: ViewMount = ({ main, client, navigate }) => {
  const writable = canWrite(client);
  const seesAssignments = canRead(client, ASSIGNMENTS);
  const host = el('div');
  let spaces: Row[] = [];
  let beds: Row[] = [];
  let assignments: Row[] = [];
  let destroyed = false;

  // Listas reordenables conservadas entre repintados (receta del checklist): `setItems` solo cuando cambian los datos.
  const lists = new Map<string, { sortable: Sortable<Row>; sig: string }>();

  async function reorder(table: TableName, ordered: Row[], moved: Row, to: number, message: string): Promise<void> {
    const prev = ordered[to - 1], next = ordered[to + 1];
    const a = prev ? Number(prev.position) : null, b = next ? Number(next.position) : null;
    const position = positionBetween(a, b);
    const fits = Number.isFinite(position) && (a === null || position > a) && (b === null || position < b);
    const operations: RowOperation[] = fits
      ? [{ op: 'update', table, id: moved.id, expectedRevision: moved.revision, fields: { position } }]
      : ordered.map((row, i): RowOperation => ({ op: 'update', table, id: row.id, expectedRevision: row.revision, fields: { position: renumber(ordered.length)[i]! } }));
    try {
      await client.commit(operations);
      toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`);
    } catch (error) {
      toast(describeError(error));
    }
  }

  const sig = (rows: Row[]) => rows.map((r) => `${r.id}:${r.revision}:${r._pending === true}`).join('|');

  /** Lista reordenable (o simple, sin permiso de escritura) conservada por clave. */
  function list(key: string, items: Row[], listLabel: string, render: (item: Row) => HTMLElement, onReorder: (ordered: Row[], moved: Row, to: number) => Promise<void>, deps = ''): HTMLElement {
    if (!writable) return el('ul', { class: 'list' }, items.map((item) => el('li', { class: 'row' }, render(item))));
    const signature = `${sig(items)}#${deps}`;
    const kept = lists.get(key);
    if (kept) {
      if (kept.sig !== signature) { kept.sig = signature; kept.sortable.setItems(items); }
      return kept.sortable.element;
    }
    const sortable = createSortableList<Row>({
      items, key: (item) => item.id, name: (item) => String(item.name ?? item.label), label: listLabel, render,
      onReorder: (ordered, move) => onReorder(ordered, move.item, move.to),
    });
    lists.set(key, { sortable, sig: signature });
    return sortable.element;
  }

  function openSpace(space: Row | null): void {
    const spaceBeds = space ? beds.filter((b) => b.space_id === space.id && b.deleted_at === null) : [];
    const blocking = space ? assignments.filter((a) => a.space_id === space.id) : [];
    const last = spaces.reduce((max, s) => Math.max(max, Number(s.position) || 0), 0);
    openRowSheet({
      client, title: space ? 'Espacio' : 'Nuevo espacio', table: SPACES, row: space, specs: SPACE_SPECS,
      defaults: { kind: 'habitacion', active: true, accessible: false },
      insertFields: { position: positionBetween(last || null, null) },
      check: (merged) => merged.kind === 'habitacion' && merged.capacity !== null && merged.capacity !== undefined
        ? 'La capacidad solo se indica en salas y zonas: en una habitación se suman las plazas de sus camas.' : null,
      extra: () => (space && blocking.length > 0
        ? el('p', { class: 'hint', id: 'removeBlocked' }, `No se puede quitar: tiene ${plural(blocking.length, 'asignación viva', 'asignaciones vivas')}. Quítalas primero desde la ficha de cada reserva.`)
        : null),
      remove: space && blocking.length === 0
        ? { label: 'Quitar', operations: () => [...spaceBeds.map((b) => del(BEDS, b)), del(SPACES, space)] } : undefined,
      savedMessage: 'Espacio guardado.',
    });
  }

  function openBed(space: Row, bed: Row | null): void {
    const blocking = bed ? assignments.filter((a) => a.bed_id === bed.id) : [];
    const last = beds.filter((b) => b.space_id === space.id).reduce((max, b) => Math.max(max, Number(b.position) || 0), 0);
    openRowSheet({
      client, title: bed ? `Cama de ${space.name}` : `Nueva cama en ${space.name}`, table: BEDS, row: bed, specs: BED_SPECS,
      defaults: { kind: 'individual', capacity: 1, active: true },
      insertFields: { space_id: space.id, position: positionBetween(last || null, null) },
      check: (merged) => (merged.capacity === 1 || merged.capacity === 2 ? null : 'Una cama admite 1 o 2 personas.'),
      extra: () => (bed && blocking.length > 0
        ? el('p', { class: 'hint', id: 'removeBlocked' }, `No se puede quitar: tiene ${plural(blocking.length, 'asignación viva', 'asignaciones vivas')}. Quítalas primero desde la ficha de cada reserva.`)
        : null),
      remove: bed && blocking.length === 0 ? { label: 'Quitar', operations: () => [del(BEDS, bed)] } : undefined,
      savedMessage: 'Cama guardada.',
    });
  }

  const editButton = (name: string, onclick: () => void) => (writable
    ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': name, onclick }, icon('edit', 16)) : null);

  function bedItem(space: Row, bed: Row): HTMLElement {
    return el('div', { class: 'space-item bed-item', dataset: { pending: String(bed._pending === true) } },
      el('div', { class: 'space-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, bed.label), el('span', { class: 'chip' }, label(bed.kind)), bed.active ? null : el('span', { class: 'chip' }, 'Inactiva')),
        el('div', { class: 'row-meta' }, plural(Number(bed.capacity), 'plaza', 'plazas'))),
      editButton(`Editar cama ${bed.label} de ${space.name}`, () => openBed(space, bed)));
  }

  function spaceItem(space: Row): HTMLElement {
    const own = beds.filter((b) => b.space_id === space.id && b.deleted_at === null).sort(byPosition);
    const places = spaceCapacity(space as any, own as any);
    const isRoom = space.kind === 'habitacion';
    return el('div', { class: 'space-item', dataset: { pending: String(space._pending === true), kind: space.kind } },
      el('div', { class: 'space-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, space.name), el('span', { class: 'chip' }, label(space.kind)),
          space.accessible ? el('span', { class: 'chip' }, 'Accesible') : null, space.active ? null : el('span', { class: 'chip' }, 'Inactivo')),
        el('div', { class: 'row-meta', dataset: { role: 'places' } }, plural(places, 'plaza', 'plazas'), space.notes ? ` · ${space.notes}` : ''),
        editButton(`Editar ${space.name}`, () => openSpace(space))),
      isRoom ? el('div', { class: 'bed-block' },
        el('div', { class: 'sectionlabel' }, 'Camas', el('span', { class: 'count' }, String(own.length))),
        own.length === 0 ? el('p', { class: 'hint' }, 'Sin camas todavía.')
          : list(`beds:${space.id}`, own, `Camas de ${space.name}`, (bed) => bedItem(space, bed), (ordered, moved, to) => reorder(BEDS, ordered, moved, to, 'Orden de las camas guardado.')),
        writable ? el('button', { class: 'ghost small', type: 'button', onclick: () => openBed(space, null) }, 'Añadir cama', el('span', { class: 'vh' }, ` a ${space.name}`)) : null) : null);
  }

  async function paint(): Promise<void> {
    spaces = ((await client.list(SPACES)) as Row[]).filter((s) => s.deleted_at === null).sort(byPosition);
    beds = ((await client.list(BEDS)) as Row[]).filter((b) => b.deleted_at === null);
    assignments = seesAssignments ? ((await client.list(ASSIGNMENTS)) as Row[]).filter((a) => a.deleted_at === null) : [];
    if (destroyed) return;

    // El asa con el foco (teclado) se recupera tras repintar: la lista se reutiliza y se saca del DOM.
    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest<HTMLElement>('.sortable-row');
    const focused = row && active?.classList.contains('sortable-handle') ? { list: row.parentElement?.getAttribute('aria-label') ?? '', key: row.dataset.key ?? '' } : null;

    const zones = new Map<string, Row[]>();
    for (const space of spaces) {
      const zone = (space.zone as string | null)?.trim() || NO_ZONE;
      zones.set(zone, [...(zones.get(zone) ?? []), space]);
    }
    const bedsSig = sig(beds.slice().sort(byPosition));
    const live = new Set<string>();
    const groups = Array.from(zones, ([zone, items]) => {
      const key = `zone:${zone}`;
      live.add(key);
      return el('section', { class: 'zone', dataset: { zone } },
        el('div', { class: 'sectionlabel' }, zone, el('span', { class: 'count' }, String(items.length))),
        list(key, items, `Espacios de ${zone}`, spaceItem, (ordered, moved, to) => reorder(SPACES, ordered, moved, to, 'Orden de los espacios guardado.'), bedsSig));
    });
    for (const space of spaces) live.add(`beds:${space.id}`);
    for (const [key, entry] of lists) if (!live.has(key)) { entry.sortable.destroy(); lists.delete(key); }

    replace(host, groups.length === 0
      ? el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay espacios'), writable ? 'Crea la primera habitación, sala o zona exterior.' : 'Aún no se ha registrado ningún espacio.')
      : groups);
    if (focused) {
      const target = Array.from(host.querySelectorAll<HTMLElement>('ul.sortable')).find((ul) => ul.getAttribute('aria-label') === focused.list);
      target?.querySelector<HTMLElement>(`:scope > .sortable-row[data-key="${focused.key}"] > .sortable-handle`)?.focus({ preventScroll: true });
    }
  }

  replace(
    main,
    el('p', null, el('button', { class: 'linkbtn', type: 'button', id: 'backToHome', onclick: () => navigate('#/') }, '← Inicio')),
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Espacios y camas'), el('p', null, 'Habitaciones con sus camas, salas y zonas exteriores. Se asignan desde la ficha de cada reserva.'))),
    host,
    writable ? el('button', { class: 'fab', type: 'button', id: 'newSpace', onclick: () => openSpace(null) }, icon('plus'), 'Nuevo espacio') : null,
  );

  void paint();
  const offs = [SPACES, BEDS, ...(seesAssignments ? [ASSIGNMENTS] : [])].map((table) => client.onTable(table, () => void paint()));
  return () => {
    destroyed = true;
    offs.forEach((off) => off());
    lists.forEach(({ sortable }) => sortable.destroy());
    lists.clear();
  };
};
