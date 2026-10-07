/** Inventario de espacios y camas (docs/booking/API.md §15.1): habitaciones con sus camas, salas y zonas exteriores, por zona y reordenables. */
import type { RowOperation, SyncedRow, TableName } from '@ikisai/sync-client';
import { confirmDialog, createSortableList, el, icon, plural, positionBetween, renumber, replace, toast, type Sortable } from '@ikisai/ui-kit';
import { extraCapacity, spaceCapacity } from '@ikisai/domain-booking';
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
  { key: 'bookable', label: 'Reservable', type: 'check', hint: 'Si no, existe pero no se ofrece para asignar ni cuenta en disponibilidad.' },
  { key: 'notes', label: 'Notas', type: 'textarea' },
];

/** Campos del alta rápida: no son columnas, solo piden cuántas camas crear con la habitación. */
const QUICK_SPECS: FieldSpec[] = [
  { key: 'quick_beds', label: 'Camas', type: 'number', local: true, showWhen: { key: 'kind', value: 'habitacion' }, hint: 'Opcional. Crea «Cama 1…N» individuales de 1 plaza.' },
  { key: 'quick_extras', label: 'Supletorias', type: 'number', local: true, showWhen: { key: 'kind', value: 'habitacion' }, hint: 'Opcional. Crea «Supletoria 1…M»; no cuentan en la capacidad base.' },
];

const MAX_QUICK = 50;

interface RoomPlan { name: string; bookable: boolean; beds: number; extras: number }

/** Distribución inicial de ejemplo (sin datos personales). Los nombres se editan después. */
const INITIAL_LAYOUT: RoomPlan[] = [
  { name: 'Habitación doble', bookable: false, beds: 2, extras: 0 },
  ...[1, 2, 3].map((n): RoomPlan => ({ name: `Habitación grande ${n}`, bookable: true, beds: 12, extras: 4 })),
  ...[1, 2].map((n): RoomPlan => ({ name: `Habitación pequeña ${n}`, bookable: true, beds: 2, extras: 2 })),
];

const BED_SPECS: FieldSpec[] = [
  { key: 'label', label: 'Etiqueta', type: 'text', max: 80 },
  { key: 'kind', label: 'Tipo de cama', type: 'select', options: OPTIONS.bedKind, hint: 'La «Supletoria» se activa solo cuando hace falta y no cuenta en la capacidad base de la habitación.' },
  { key: 'capacity', label: 'Plazas', type: 'number', hint: '1 o 2 personas.' },
  { key: 'active', label: 'Activa', type: 'check' },
];

/** Inserta una habitación y sus camas («Cama 1…N» individuales y «Supletoria 1…M») en un solo lote. */
function roomOperations(fields: Record<string, unknown>, beds: Array<{ label: string; kind: string; capacity: number; active?: boolean }>): RowOperation[] {
  const id = crypto.randomUUID();
  const positions = renumber(beds.length);
  return [
    { op: 'insert', table: SPACES, id, fields },
    ...beds.map((bed, i): RowOperation => ({ op: 'insert', table: BEDS, id: crypto.randomUUID(), fields: { space_id: id, active: true, ...bed, position: positions[i]! } })),
  ];
}

const quickBeds = (beds: number, extras: number) => [
  ...Array.from({ length: beds }, (_, i) => ({ label: `Cama ${i + 1}`, kind: 'individual', capacity: 1 })),
  ...Array.from({ length: extras }, (_, i) => ({ label: `Supletoria ${i + 1}`, kind: 'supletoria', capacity: 1 })),
];

const del = (table: TableName, row: Row): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });
const byPosition = (a: Row, b: Row) => Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);

/** Monta la pantalla `#/espacios`. */
export const mountSpaces: ViewMount = ({ main, client, navigate }) => {
  const writable = canWrite(client);
  const seesAssignments = canRead(client, ASSIGNMENTS);
  const host = el('div', { 'data-feedback-id': 'booking.espacios.lista', 'data-feedback-label': 'Espacios' });
  let spaces: Row[] = [];
  let beds: Row[] = [];
  let assignments: Row[] = [];
  let destroyed = false;
  const openBeds = new Set<string>(), closedBeds = new Set<string>();

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
    const listMark = key.startsWith('beds:') ? ['booking.espacios.camas.lista', 'Camas'] : ['booking.espacios.zonas.lista', 'Lista de espacios'];
    if (!writable) return el('ul', { class: 'list', 'data-feedback-id': listMark[0], 'data-feedback-label': listMark[1] }, items.map((item) => el('li', { class: 'row' }, render(item))));
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
    sortable.element.setAttribute('data-feedback-id', listMark[0]!);
    sortable.element.setAttribute('data-feedback-label', listMark[1]!);
    lists.set(key, { sortable, sig: signature });
    return sortable.element;
  }

  function openSpace(space: Row | null): void {
    const spaceBeds = space ? beds.filter((b) => b.space_id === space.id && b.deleted_at === null) : [];
    const blocking = space ? assignments.filter((a) => a.space_id === space.id) : [];
    const last = spaces.reduce((max, s) => Math.max(max, Number(s.position) || 0), 0);
    openRowSheet({
      client, title: space ? 'Espacio' : 'Nuevo espacio', table: SPACES, row: space, feedbackId: space ? 'booking.espacios.espacio' : 'booking.espacios.nuevo', feedbackLabel: space ? 'Editar espacio' : 'Nuevo espacio', specs: space ? SPACE_SPECS : [SPACE_SPECS[0]!, SPACE_SPECS[1]!, ...QUICK_SPECS, ...SPACE_SPECS.slice(2)],
      defaults: { kind: 'habitacion', active: true, accessible: false, bookable: true },
      ...(space ? {} : {
        buildOperations: (values: Record<string, unknown>) => {
          const count = (key: string, name: string): number => {
            const n = values[key] === null || values[key] === undefined ? 0 : Number(values[key]);
            if (!Number.isInteger(n) || n < 0 || n > MAX_QUICK) throw new Error(`${name}: indica un número entre 0 y ${MAX_QUICK}.`);
            return n;
          };
          if (values.name === null) throw new Error('El nombre es obligatorio.');
          const room = values.kind === 'habitacion';
          const nBeds = room ? count('quick_beds', 'Camas') : 0, nExtras = room ? count('quick_extras', 'Supletorias') : 0;
          const fields = { ...Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== null && !QUICK_SPECS.some((q) => q.key === key))), position: positionBetween(last || null, null) };
          return roomOperations(fields, quickBeds(nBeds, nExtras));
        },
      }),
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

  /** Copia de una habitación con las mismas camas, en un solo lote. */
  async function duplicate(space: Row, own: Row[]): Promise<void> {
    const index = spaces.findIndex((s) => s.id === space.id);
    const a = Number(space.position), nextRow = spaces[index + 1];
    const b = nextRow ? Number(nextRow.position) : null;
    const position = positionBetween(a, b);
    const fits = Number.isFinite(position) && position > a && (b === null || position < b);
    const last = spaces.reduce((max, s) => Math.max(max, Number(s.position) || 0), 0);
    const fields: Record<string, unknown> = { name: `${space.name} (copia)`.slice(0, 120), kind: space.kind, active: space.active, accessible: space.accessible, bookable: space.bookable !== false, position: fits ? position : positionBetween(last || null, null) };
    if (space.zone) fields.zone = space.zone;
    if (space.notes) fields.notes = space.notes;
    try {
      await client.commit(roomOperations(fields, own.map((bed) => ({ label: String(bed.label), kind: String(bed.kind), capacity: Number(bed.capacity), active: bed.active === true }))));
      toast(navigator.onLine ? 'Habitación duplicada.' : 'Habitación duplicada. Se enviará al reconectar.');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function createInitial(): Promise<void> {
    const rooms = INITIAL_LAYOUT.length, beds = INITIAL_LAYOUT.reduce((sum, r) => sum + r.beds + r.extras, 0);
    const go = await confirmDialog({
      title: 'Crear distribución inicial',
      text: `Se crean ${plural(rooms, 'habitación', 'habitaciones')} de ejemplo con ${plural(beds, 'cama', 'camas')} en total: «Habitación doble» (2 camas, no reservable), tres «Habitación grande» (12 camas y 4 supletorias) y dos «Habitación pequeña» (2 camas y 2 supletorias). Después puedes renombrarlas, añadir o quitar camas.`,
      confirmLabel: 'Crear',
    });
    if (!go) return;
    const operations = INITIAL_LAYOUT.flatMap((plan, i) => roomOperations(
      { name: plan.name, kind: 'habitacion', active: true, accessible: false, bookable: plan.bookable, position: (i + 1) * 1024 },
      quickBeds(plan.beds, plan.extras)));
    try {
      await client.commit(operations);
      toast(navigator.onLine ? 'Distribución creada.' : 'Distribución creada. Se enviará al reconectar.');
    } catch (error) {
      toast(describeError(error));
    }
  }

  function openBed(space: Row, bed: Row | null): void {
    const blocking = bed ? assignments.filter((a) => a.bed_id === bed.id) : [];
    const last = beds.filter((b) => b.space_id === space.id).reduce((max, b) => Math.max(max, Number(b.position) || 0), 0);
    openRowSheet({
      client, title: bed ? `Cama de ${space.name}` : `Nueva cama en ${space.name}`, table: BEDS, row: bed, specs: BED_SPECS, feedbackId: bed ? 'booking.espacios.cama' : 'booking.espacios.nueva_cama', feedbackLabel: bed ? 'Editar cama' : 'Nueva cama',
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

  const editButton = (name: string, fbId: string, fbLabel: string, onclick: () => void) => (writable
    ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': name, 'data-feedback-id': fbId, 'data-feedback-label': fbLabel, onclick }, icon('edit', 16)) : null);

  function bedItem(space: Row, bed: Row): HTMLElement {
    return el('div', { class: 'space-item bed-item', dataset: { pending: String(bed._pending === true) }, 'data-feedback-id': 'booking.espacios.camas.cama', 'data-feedback-label': 'Cama' },
      el('div', { class: 'space-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, bed.label), el('span', { class: 'chip', dataset: { role: 'bed-kind' } }, label(bed.kind)), bed.active ? null : el('span', { class: 'chip' }, 'Inactiva')),
        el('div', { class: 'row-meta' }, plural(Number(bed.capacity), 'plaza', 'plazas'))),
      editButton(`Editar cama ${bed.label} de ${space.name}`, 'booking.espacios.camas.editar', 'Editar cama', () => openBed(space, bed)));
  }

  /** Camas plegables: con muchas camas la lista sería larguísima; se recuerda qué habitaciones están abiertas. */
  function bedsDetails(space: Row, own: Row[]): HTMLElement {
    const details = el('details', { class: 'bed-details', dataset: { space: String(space.name) }, 'data-feedback-id': 'booking.espacios.camas', 'data-feedback-label': 'Camas de la habitación' },
      el('summary', { class: 'sectionlabel' }, 'Camas', el('span', { class: 'count' }, String(own.length))),
      list(`beds:${space.id}`, own, `Camas de ${space.name}`, (bed) => bedItem(space, bed), (ordered, moved, to) => reorder(BEDS, ordered, moved, to, 'Orden de las camas guardado.'))) as HTMLDetailsElement;
    details.open = openBeds.has(space.id) || (!closedBeds.has(space.id) && own.length <= 4);
    details.addEventListener('toggle', () => {
      if (details.open) { openBeds.add(space.id); closedBeds.delete(space.id); } else { openBeds.delete(space.id); closedBeds.add(space.id); }
    });
    return details;
  }

  function spaceItem(space: Row): HTMLElement {
    const own = beds.filter((b) => b.space_id === space.id && b.deleted_at === null).sort(byPosition);
    const places = spaceCapacity(space as any, own as any), extra = extraCapacity(space as any, own as any);
    const isRoom = space.kind === 'habitacion';
    return el('div', { class: 'space-item', dataset: { pending: String(space._pending === true), kind: space.kind }, 'data-feedback-id': 'booking.espacios.espacio_fila', 'data-feedback-label': 'Espacio' },
      el('div', { class: 'space-main' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, space.name), el('span', { class: 'chip' }, label(space.kind)),
          space.accessible ? el('span', { class: 'chip' }, 'Accesible') : null, space.active ? null : el('span', { class: 'chip' }, 'Inactivo'),
          space.bookable === false ? el('span', { class: 'chip' }, 'No reservable') : null),
        el('div', { class: 'row-meta', dataset: { role: 'places' } }, plural(places, 'plaza', 'plazas'), extra > 0 ? ` + ${plural(extra, 'supletoria', 'supletorias')}` : '', space.notes ? ` · ${space.notes}` : ''),
        editButton(`Editar ${space.name}`, 'booking.espacios.espacio_fila.editar', 'Editar espacio', () => openSpace(space))),
      isRoom ? el('div', { class: 'bed-block' },
        own.length === 0 ? el('div', { class: 'sectionlabel' }, 'Camas', el('span', { class: 'count' }, '0'))
          : bedsDetails(space, own),
        own.length === 0 ? el('p', { class: 'hint' }, 'Sin camas todavía.') : null,
        writable ? el('div', { class: 'btnrow' },
          el('button', { class: 'ghost small', type: 'button', 'data-feedback-id': 'booking.espacios.espacio_fila.anadir_cama', 'data-feedback-label': 'Añadir cama', onclick: () => openBed(space, null) }, 'Añadir cama', el('span', { class: 'vh' }, ` a ${space.name}`)),
          el('button', { class: 'ghost small', type: 'button', 'data-feedback-id': 'booking.espacios.espacio_fila.duplicar', 'data-feedback-label': 'Duplicar', onclick: () => void duplicate(space, own) }, 'Duplicar', el('span', { class: 'vh' }, ` ${space.name}`))) : null) : null);
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
      return el('section', { class: 'zone', dataset: { zone }, 'data-feedback-id': 'booking.espacios.zonas', 'data-feedback-label': 'Zona' },
        el('div', { class: 'sectionlabel' }, zone, el('span', { class: 'count' }, String(items.length))),
        list(key, items, `Espacios de ${zone}`, spaceItem, (ordered, moved, to) => reorder(SPACES, ordered, moved, to, 'Orden de los espacios guardado.'), bedsSig));
    });
    for (const space of spaces) live.add(`beds:${space.id}`);
    for (const [key, entry] of lists) if (!live.has(key)) { entry.sortable.destroy(); lists.delete(key); }

    replace(host, groups.length === 0
      ? el('div', { class: 'empty', 'data-feedback-id': 'booking.espacios.vacio', 'data-feedback-label': 'Sin espacios' }, el('strong', null, 'Todavía no hay espacios'), writable ? 'Crea la primera habitación, sala o zona exterior.' : 'Aún no se ha registrado ningún espacio.',
        writable ? el('p', null, el('button', { class: 'ghost', type: 'button', id: 'createLayout', 'data-feedback-id': 'booking.espacios.vacio.distribucion', 'data-feedback-label': 'Crear distribución inicial', onclick: () => void createInitial() }, 'Crear distribución inicial')) : null)
      : groups);
    if (focused) {
      const target = Array.from(host.querySelectorAll<HTMLElement>('ul.sortable')).find((ul) => ul.getAttribute('aria-label') === focused.list);
      target?.querySelector<HTMLElement>(`:scope > .sortable-row[data-key="${focused.key}"] > .sortable-handle`)?.focus({ preventScroll: true });
    }
  }

  replace(
    main,
    el('p', null, el('button', { class: 'linkbtn', type: 'button', id: 'backToHome', 'data-feedback-id': 'booking.espacios.cabecera.volver', 'data-feedback-label': 'Volver a Inicio', onclick: () => navigate('#/') }, '← Inicio')),
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Espacios y camas'), el('p', null, 'Habitaciones con sus camas, salas y zonas exteriores. Se asignan desde la ficha de cada reserva.'))),
    host,
    writable ? el('div', { class: 'fab-gap', 'aria-hidden': 'true' }) : null,
    writable ? el('button', { class: 'fab', type: 'button', id: 'newSpace', 'data-feedback-id': 'booking.espacios.nuevo_espacio', 'data-feedback-label': 'Nuevo espacio', onclick: () => openSpace(null) }, icon('plus'), 'Nuevo espacio') : null,
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
