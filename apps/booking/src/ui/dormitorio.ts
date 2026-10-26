/**
 * «Monta el dormitorio» (tanda 36, MUELA-049): la estancia en cuadrantes con sus camas, dentro de su ficha.
 * - Todos ven la distribución y el estado de cada cama esta noche (en palabras, no solo en color).
 * - «Editar la distribución», solo dirección (owner): ancho y fondo con «−» y «+»; añadir Litera, Individual, Doble o
 *   Supletoria; mover (flechas, arrastrar con encaje), girar 90° (R o «↻ Girar») y quitar (Supr o «Quitar»). Se trabaja
 *   sobre un borrador y «Guardar» lo envía en un lote (sin red, al reconectar, como el resto de Booking).
 * - No deja salirse ni montarse sobre otra cama, ni quitar una con asignaciones vivas, y lo dice.
 * - Con los espacios en Recursos, las camas se añaden y se quitan allí; aquí solo se colocan.
 * - Se dibujan piezas (`dorm.pieces`): una cama de Recursos partida en fija y supletoria es una sola pieza, y las
 *   inactivas no se dibujan (FB_2026_047, 050 y 051). El texto va siempre en horizontal (FB_2026_046).
 */
import type { RowOperation, SyncClient, SyncedRow } from '@ikisai/sync-client';
import { el, plural, replace, toast } from '@ikisai/ui-kit';
import { dorm } from '@ikisai/domain-booking';
import { BEDS, SPACES, describeError } from '../app/client.ts';
import { label } from '../app/labels.ts';

type Row = SyncedRow & Record<string, any>;
type Cell = dorm.Cell;

export interface DormOptions {
  client: SyncClient;
  space: Row;
  /** Camas vivas de la estancia, en orden. */
  beds: Row[];
  /** Asignaciones vivas (para no quitar una cama ocupada). */
  assignments: Row[];
  /** Camas ocupadas esta noche. */
  occupied: ReadonlySet<string>;
  /** Solo dirección. */
  canEdit: boolean;
  /** Con los espacios en Recursos, las camas se añaden y se quitan allí. */
  fromResources: boolean;
}

/** Tipos que se añaden desde aquí, con sus plazas (la litera: dos plazas que se asignan por separado). */
const NEW_BEDS: Array<{ kind: string; text: string; capacity: number }> = [
  { kind: 'litera', text: 'Litera', capacity: 2 },
  { kind: 'individual', text: 'Individual', capacity: 1 },
  { kind: 'doble', text: 'Doble', capacity: 2 },
  { kind: 'supletoria', text: 'Supletoria', capacity: 1 },
];
const DIRS: Array<{ dir: dorm.Direction; text: string; arrow: string; key: string }> = [
  { dir: 'left', text: 'Mover a la izquierda', arrow: '←', key: 'ArrowLeft' },
  { dir: 'up', text: 'Mover hacia arriba', arrow: '↑', key: 'ArrowUp' },
  { dir: 'down', text: 'Mover hacia abajo', arrow: '↓', key: 'ArrowDown' },
  { dir: 'right', text: 'Mover a la derecha', arrow: '→', key: 'ArrowRight' },
];

interface DraftBed { id: string; label: string; kind: string; seats: number; extras: number; parts: Row[]; isNew: boolean }

/** Pinta «Monta el dormitorio» en un contenedor propio y lo devuelve. */
export function createDormitorio(o: DormOptions): { element: HTMLElement; editing(): boolean; destroy(): void } {
  const host = el('div', { class: 'bk-dorm', id: 'dormitorio', 'data-feedback-id': 'booking.espacios.dormitorio', 'data-feedback-label': 'Monta el dormitorio' });
  const live = el('p', { class: 'hint bk-dorm-msg', id: 'dormMessage', role: 'status', 'aria-live': 'polite' });
  let editing = false;
  let selected: string | null = null;
  let grid: dorm.Grid;
  let cells: Map<string, Cell>;
  let beds: DraftBed[];
  let removed: Row[] = [];
  let inactive: Row[] = [];
  let drag: { id: string; pointer: number; startX: number; startY: number; from: Cell } | null = null;
  let dragged = false;

  function reset(): void {
    const p = dorm.pieces(o.beds as Array<Row & dorm.BedPart>);
    const a = dorm.arrange(o.space.layout, p.pieces.map((x) => ({ id: x.id, cell: x.main.cell })));
    grid = a.grid; cells = a.cells; removed = []; inactive = p.inactive;
    beds = p.pieces.map((x) => ({ id: x.id, label: String(x.main.label), kind: String(x.main.kind), seats: x.seats, extras: x.extras, parts: x.parts, isNew: false }));
    selected = null;
  }
  reset();

  const bedOf = (id: string) => beds.find((b) => b.id === id);
  const partIds = (id: string) => new Set(bedOf(id)?.parts.map((r) => r.id) ?? [id]);
  const blockers = (id: string) => { const ids = partIds(id); return o.assignments.filter((a) => ids.has(a.bed_id)).length; };
  const isOccupied = (b: DraftBed) => b.parts.some((r) => o.occupied.has(r.id));
  const onlyExtra = (b: DraftBed) => b.seats === 0 && b.extras > 0;
  /** «1 plaza + 1 supletoria»; una supletoria sola, «1 plaza». */
  const placesText = (b: DraftBed) => onlyExtra(b) ? plural(b.extras, 'plaza', 'plazas')
    : `${plural(b.seats, 'plaza', 'plazas')}${b.extras ? ` + ${plural(b.extras, 'supletoria', 'supletorias')}` : ''}`;
  const say = (text: string) => { live.textContent = text; };
  const nameOf = (id: string) => bedOf(id)?.label ?? 'otra cama';

  function stateText(b: DraftBed): string {
    if (b.isNew) return 'Nueva, sin guardar';
    return isOccupied(b) ? 'Ocupada esta noche' : 'Libre esta noche';
  }

  function tryPlace(id: string, cell: Cell, done: string): boolean {
    const problem = dorm.placeProblem(grid, cells, id, cell);
    if (problem?.reason === 'fuera') { say('No cabe ahí: se saldría de la estancia.'); return false; }
    if (problem?.reason === 'encima') { say(`No cabe ahí: se montaría sobre ${nameOf(problem.other)}.`); return false; }
    cells.set(id, cell);
    say(done);
    return true;
  }

  function move(id: string, dir: dorm.Direction): void {
    const cell = cells.get(id);
    if (cell && tryPlace(id, dorm.moved(cell, dir), `${nameOf(id)}: x ${dorm.moved(cell, dir).x + 1}, y ${dorm.moved(cell, dir).y + 1}.`)) paint(id);
  }
  function rotate(id: string): void {
    const cell = cells.get(id);
    if (!cell) return;
    const next = dorm.rotated(grid, cells, id, cell);
    if (tryPlace(id, next, `${nameOf(id)}: ${next.rot === 90 ? 'a lo largo' : 'a lo ancho'}.`)) paint(id);
  }
  function remove(id: string): void {
    const b = bedOf(id);
    if (!b) return;
    if (!b.isNew && blockers(id) > 0) return say(`No se puede quitar ${b.label}: tiene ${plural(blockers(id), 'asignación viva', 'asignaciones vivas')}. Quítalas primero desde la ficha de cada reserva.`);
    beds = beds.filter((x) => x.id !== id);
    cells.delete(id);
    if (!b.isNew) removed.push(...b.parts);
    selected = null;
    say(`${b.label} quitada. Se guarda al pulsar «Guardar».`);
    paint();
  }
  function add(kind: string, text: string, capacity: number): void {
    const same = beds.filter((b) => b.kind === kind).length + 1;
    const id = crypto.randomUUID();
    let cell = dorm.firstFree(grid, cells, id);
    while (!cell && grid.rows < dorm.GRID_LIMITS.maxRows) { grid = { ...grid, rows: grid.rows + 1 }; cell = dorm.firstFree(grid, cells, id); }
    if (!cell) return say('No cabe otra cama: la estancia ya tiene el fondo máximo.');
    const extra = kind === 'supletoria';
    beds.push({ id, label: `${text} ${same}`, kind, seats: extra ? 0 : capacity, extras: extra ? capacity : 0, parts: [], isNew: true });
    cells.set(id, cell);
    say(`${text} ${same} añadida en el primer hueco.`);
    paint(id);
  }
  function resize(axis: 'cols' | 'rows', delta: number): void {
    const next = { ...grid, [axis]: grid[axis] + delta };
    if (!dorm.validGrid(next)) return say(axis === 'cols' ? `El ancho va de ${dorm.GRID_LIMITS.minCols} a ${dorm.GRID_LIMITS.maxCols} cuadrantes.` : `El fondo va de ${dorm.GRID_LIMITS.minRows} a ${dorm.GRID_LIMITS.maxRows} cuadrantes.`);
    if (!dorm.fitsIn(next, cells)) return say('No se puede encoger: alguna cama se quedaría fuera. Muévela antes.');
    grid = next;
    say(`${axis === 'cols' ? 'Ancho' : 'Fondo'}: ${next[axis]} cuadrantes.`);
    paint();
  }

  async function save(): Promise<void> {
    const ops: RowOperation[] = [];
    const layoutChanged = !dorm.validGrid(o.space.layout) || o.space.layout.cols !== grid.cols || o.space.layout.rows !== grid.rows;
    if (layoutChanged) ops.push({ op: 'update', table: SPACES, id: o.space.id, expectedRevision: o.space.revision, fields: { layout: grid } });
    const last = o.beds.reduce((max, b) => Math.max(max, Number(b.position) || 0), 0);
    let pos = last;
    for (const b of beds) {
      const cell = cells.get(b.id) ?? null;
      if (b.isNew) {
        pos += 1024;
        ops.push({ op: 'insert', table: BEDS, id: b.id, fields: { space_id: o.space.id, label: b.label, kind: b.kind, capacity: b.seats + b.extras, active: true, position: pos, cell } });
        continue;
      }
      // Todas las partes de la pieza guardan el mismo sitio.
      for (const row of b.parts) {
        const before = dorm.validCell(row.cell) ? row.cell : null;
        if (!before || !cell || before.x !== cell.x || before.y !== cell.y || before.rot !== cell.rot) {
          ops.push({ op: 'update', table: BEDS, id: row.id, expectedRevision: row.revision, fields: { cell } });
        }
      }
    }
    for (const row of removed) ops.push({ op: 'delete', table: BEDS, id: row.id, expectedRevision: row.revision });
    if (!ops.length) { editing = false; say('Sin cambios.'); return paint(); }
    try {
      await o.client.commit(ops);
      editing = false;
      toast(navigator.onLine ? 'Distribución guardada.' : 'Distribución guardada. Se enviará al reconectar.');
    } catch (error) {
      say(`No se ha guardado: ${describeError(error)}`);
    }
  }

  function bedButton(b: DraftBed): HTMLElement {
    const cell = cells.get(b.id)!;
    const r = dorm.footprint(cell);
    const state = stateText(b);
    const occupied = isOccupied(b);
    const button = el('button', {
      type: 'button', class: `bk-dorm-bed${onlyExtra(b) ? ' extra' : b.extras ? ' mixed' : ''}${occupied ? ' occupied' : ''}${selected === b.id ? ' picked' : ''}`,
      id: `dormBed-${b.id}`, dataset: { bed: b.id, kind: b.kind, rot: String(cell.rot) },
      style: `grid-column: ${r.x + 1} / span ${r.w}; grid-row: ${r.y + 1} / span ${r.h}`,
      'aria-label': `${b.label}, ${label(b.kind)}, ${placesText(b)}, ${state}${cell.rot === 90 ? ', a lo largo' : ''}`,
      title: b.label,
      'aria-pressed': editing ? String(selected === b.id) : null,
      tabindex: editing ? '0' : '-1',
      'data-feedback-id': 'booking.espacios.dormitorio.cama', 'data-feedback-label': 'Cama en el dormitorio',
      onclick: () => { if (!editing) return; if (dragged) { dragged = false; return; } selected = selected === b.id ? null : b.id; paint(selected); },
      onkeydown: ((event: KeyboardEvent) => {
        if (!editing) return;
        const d = DIRS.find((x) => x.key === event.key);
        if (d) { event.preventDefault(); selected = b.id; move(b.id, d.dir); }
        else if (event.key === 'r' || event.key === 'R') { event.preventDefault(); selected = b.id; rotate(b.id); }
        else if ((event.key === 'Delete' || event.key === 'Supr') && !o.fromResources) { event.preventDefault(); remove(b.id); }
      }) as EventListener,
      onpointerdown: ((event: PointerEvent) => {
        if (!editing || event.button !== 0) return;
        drag = { id: b.id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, from: cell };
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      }) as EventListener,
      onpointerup: ((event: PointerEvent) => {
        if (!drag || drag.pointer !== event.pointerId) return;
        const board = (event.currentTarget as HTMLElement).parentElement!;
        const rect = board.getBoundingClientRect();
        const dx = Math.round((event.clientX - drag.startX) / (rect.width / grid.cols));
        const dy = Math.round((event.clientY - drag.startY) / (rect.height / grid.rows));
        const from = drag.from, id = drag.id;
        drag = null;
        if (dx === 0 && dy === 0) return;
        dragged = true;
        selected = id;
        const to = { ...from, x: from.x + dx, y: from.y + dy };
        if (tryPlace(id, to, `${nameOf(id)}: x ${to.x + 1}, y ${to.y + 1}.`)) paint(id);
        else paint(id);
      }) as EventListener,
    }, el('span', { class: 'bk-dorm-bed-name', 'aria-hidden': 'true' }, dorm.shortName(b.label)),
      el('span', { class: 'bk-dorm-bed-kind', 'aria-hidden': 'true' }, `${b.extras && b.seats ? `${b.seats} + ${b.extras}` : label(b.kind)} · ${state.split(' ')[0]}`));
    return button;
  }

  function paint(focus: string | null = null): void {
    const placed = beds.filter((b) => cells.has(b.id));
    const outside = beds.filter((b) => !cells.has(b.id));
    const board = el('div', {
      class: `bk-dorm-board${editing ? ' editing' : ''}`, role: 'group', 'aria-label': `${o.space.name}: ${grid.cols} de ancho por ${grid.rows} de fondo`,
      style: `grid-template-columns: repeat(${grid.cols}, 1fr); grid-template-rows: repeat(${grid.rows}, var(--bk-dorm-cell))`,
    },
      ...Array.from({ length: grid.cols * grid.rows }, (_, i) => el('span', { class: 'bk-dorm-cell', 'aria-hidden': 'true', style: `grid-column: ${(i % grid.cols) + 1}; grid-row: ${Math.floor(i / grid.cols) + 1}` })),
      ...placed.map(bedButton));
    const sel = selected ? bedOf(selected) : null;
    const total = beds.reduce((s, b) => s + b.seats, 0);
    const extras = beds.reduce((s, b) => s + b.extras, 0);
    replace(host,
      el('p', { class: 'bk-dorm-summary' }, beds.length === 0 ? 'Sin camas.' : `${plural(beds.length, 'cama', 'camas')} · ${plural(total, 'plaza', 'plazas')}${extras ? ` + ${plural(extras, 'supletoria', 'supletorias')}` : ''}`),
      beds.length === 0 && !editing
        ? el('p', { class: 'hint', id: 'dormEmpty' }, o.canEdit && !o.fromResources ? 'Sin camas: añade la primera para usarla como dormitorio.' : o.fromResources ? 'Sin camas. Se añaden en Recursos.' : 'Sin camas.')
        : board,
      outside.length ? el('p', { class: 'hint' }, `Sin sitio en el dibujo: ${outside.map((b) => b.label).join(', ')}.`) : null,
      inactive.length ? el('p', { class: 'hint', id: 'dormInactive' }, `${inactive.length === 1 ? 'Archivada, no se dibuja' : 'Archivadas, no se dibujan'}: ${inactive.map((b) => String(b.label)).join(', ')}.`) : null,
      beds.some((b) => b.extras) ? el('ul', { class: 'bk-dorm-legend', 'aria-hidden': 'true' },
        el('li', { class: 'fixed' }, el('i'), 'Fija'), el('li', { class: 'extra' }, el('i'), 'Supletoria'), el('li', { class: 'mixed' }, el('i'), 'Fija + supletoria')) : null,
      editing ? el('div', { class: 'bk-dorm-tools', id: 'dormTools' },
        el('div', { class: 'bk-dorm-size' },
          sizer('Ancho', 'cols'), sizer('Fondo', 'rows')),
        o.fromResources ? el('p', { class: 'hint' }, 'Las camas se añaden y se quitan en Recursos; aquí se colocan.')
          : el('div', { class: 'btnrow', id: 'dormAdd' }, el('span', { class: 'hint' }, 'Añadir:'), ...NEW_BEDS.map((n) => el('button', {
            type: 'button', class: 'ghost small', id: `dormAdd-${n.kind}`, 'data-feedback-id': 'booking.espacios.dormitorio.anadir', 'data-feedback-label': 'Añadir cama',
            onclick: () => add(n.kind, n.text, n.capacity),
          }, n.text))),
        sel ? el('div', { class: 'btnrow bk-dorm-bar', id: 'dormBar', role: 'toolbar', 'aria-label': `Mover ${sel.label}` },
          el('strong', null, sel.label),
          el('button', { type: 'button', class: 'ghost small', id: 'dormRotate', 'data-feedback-id': 'booking.espacios.dormitorio.girar', 'data-feedback-label': 'Girar', onclick: () => rotate(sel.id) }, '↻ Girar'),
          ...DIRS.map((d) => el('button', { type: 'button', class: 'ghost small bk-dorm-arrow', 'aria-label': `${d.text}: ${sel.label}`, 'data-feedback-id': 'booking.espacios.dormitorio.mover', 'data-feedback-label': 'Mover', onclick: () => move(sel.id, d.dir) }, d.arrow)),
          o.fromResources ? null : el('button', { type: 'button', class: 'ghost small danger', id: 'dormRemove', 'data-feedback-id': 'booking.espacios.dormitorio.quitar', 'data-feedback-label': 'Quitar', onclick: () => remove(sel.id) }, 'Quitar'))
          : el('p', { class: 'hint' }, 'Toca una cama para moverla o girarla. En el ordenador: flechas, R para girar y Supr para quitar; también se arrastra.'),
        el('div', { class: 'btnrow' },
          el('button', { type: 'button', class: 'primary', id: 'dormSave', 'data-feedback-id': 'booking.espacios.dormitorio.guardar', 'data-feedback-label': 'Guardar la distribución', onclick: () => void save() }, 'Guardar'),
          el('button', { type: 'button', class: 'ghost', id: 'dormDiscard', 'data-feedback-id': 'booking.espacios.dormitorio.descartar', 'data-feedback-label': 'Descartar los cambios', onclick: () => { editing = false; reset(); say('Cambios descartados.'); paint(); } }, 'Descartar')))
        : o.canEdit ? el('p', null, el('button', { type: 'button', class: 'ghost small', id: 'dormEdit', 'data-feedback-id': 'booking.espacios.dormitorio.editar', 'data-feedback-label': 'Editar la distribución', onclick: () => { editing = true; say(''); paint(); } }, 'Editar la distribución')) : null,
      live);
    if (focus) host.querySelector<HTMLElement>(`#dormBed-${CSS.escape(focus)}`)?.focus({ preventScroll: true });
  }

  function sizer(text: string, axis: 'cols' | 'rows'): HTMLElement {
    return el('span', { class: 'bk-dorm-sizer', id: `dormSize-${axis}` },
      el('span', null, text),
      el('button', { type: 'button', class: 'ghost small', 'aria-label': `${text}: menos`, 'data-feedback-id': 'booking.espacios.dormitorio.tamano', 'data-feedback-label': 'Tamaño de la estancia', onclick: () => resize(axis, -1) }, '−'),
      el('strong', null, String(grid[axis])),
      el('button', { type: 'button', class: 'ghost small', 'aria-label': `${text}: más`, 'data-feedback-id': 'booking.espacios.dormitorio.tamano', 'data-feedback-label': 'Tamaño de la estancia', onclick: () => resize(axis, 1) }, '+'));
  }

  paint();
  return { element: host, editing: () => editing, destroy: () => { drag = null; } };
}
