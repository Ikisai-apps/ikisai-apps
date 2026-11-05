/**
 * «Monta el dormitorio» (tanda 36, MUELA-049): la estancia en cuadrantes con sus camas, dentro de su ficha.
 * - Todos ven la distribución y el estado de cada cama esta noche (en palabras, no solo en color).
 * - «Editar la distribución», solo dirección (owner): ancho y fondo con «−» y «+»; añadir Litera, Individual, Doble o
 *   Supletoria; mover (flechas, arrastrar con encaje), girar 90° (R o «↻ Girar») y quitar (Supr o «Quitar»). Cada cambio
 *   se guarda solo al momento, sin botón (B-40, VG 05-11; sin red, al reconectar, como el resto de Booking); «Hecho» cierra.
 * - No deja salirse ni montarse sobre otra cama, ni quitar una con asignaciones vivas, y lo dice.
 * - Con los espacios en Recursos (vg-52, VG 28-10: los espacios se gestionan en Central, las camas en Booking), las camas
 *   también se añaden, se quitan y se cambian de tipo y de plazas desde aquí: se guardan primero en Recursos (`resources.spaces`,
 *   tipo `cama`, con `bed_kind`, `capacity` y `extra_capacity`), y su sitio en el dibujo cuando el espejo las trae a Booking.
 * - Se dibujan piezas (`dorm.pieces`): una cama de Recursos partida en fija y supletoria es una sola pieza, y las
 *   inactivas no se dibujan (FB_2026_047, 050 y 051). El texto va siempre en horizontal (FB_2026_046).
 * - La doble ocupa 2×2 cuadrantes; las demás, 2×1 (FB_2026_052).
 */
import type { RowOperation, SyncClient, SyncedRow } from '@ikisai/sync-client';
import { createSyncClient } from '@ikisai/sync-client';
import { el, fieldAttrs, plural, replace, toast } from '@ikisai/ui-kit';
import { dorm } from '@ikisai/domain-booking';
import { BEDS, SPACES, describeError } from '../app/client.ts';
import { label } from '../app/labels.ts';
import { syncMirror } from './spacesResources.ts';

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
  /** Con los espacios en Recursos, las camas se guardan allí (y su sitio, aquí). */
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

/** `inResources`: la cama nueva ya está en Recursos y espera al espejo para guardar su sitio (no se vuelve a crear). */
interface DraftBed { id: string; label: string; kind: string; seats: number; extras: number; parts: Row[]; isNew: boolean; edited?: boolean; team: boolean; inResources?: boolean }
/** Tipos de cama de Recursos (la supletoria sola es una individual de 0 fijas y 1 supletoria). */
/** Se apilan en el mismo sitio: una litera doble son dos camas, abajo y arriba (VG, 28-10). */
const STACKABLE = new Set(['litera', 'doble']);
const RESOURCE_KINDS: Array<[string, string]> = [['litera', 'Litera'], ['individual', 'Individual'], ['doble', 'Doble (de matrimonio)'], ['sofa_cama', 'Sofá cama']];

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
  /** Tamaño de cada pieza en el dibujo (la doble, 2×2). */
  const sizes = new Map<string, dorm.BedSize>();
  let drag: { id: string; pointer: number; startX: number; startY: number; from: Cell } | null = null;
  let dragged = false;
  // Guardado solo: cada cambio programa un guardado; uno a la vez, y si llega otro cambio mientras, se repite.
  const status = el('p', { class: 'hint bk-dorm-saved', id: 'dormSaved', role: 'status', 'aria-live': 'polite' });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null;
  let again = false;
  let waits = 0;
  let resources: SyncClient | null = null;

  function reset(): void {
    const p = dorm.pieces(o.beds as Array<Row & dorm.BedPart>);
    sizes.clear();
    for (const x of p.pieces) sizes.set(x.id, dorm.sizeOfKind(x.main.kind));
    const kinds = new Map(p.pieces.map((x) => [x.id, String(x.main.kind)]));
    const a = dorm.arrange(o.space.layout, p.pieces.map((x) => ({ id: x.id, cell: x.main.cell })), sizes, (x, y) => STACKABLE.has(kinds.get(x) ?? '') && STACKABLE.has(kinds.get(y) ?? ''));
    grid = a.grid; cells = a.cells; removed = []; inactive = p.inactive;
    beds = p.pieces.map((x) => ({ id: x.id, label: String(x.main.label), kind: String(x.main.kind), seats: x.seats, extras: x.extras, parts: x.parts, isNew: false, team: x.parts.some((r) => r.team_bed === true) }));
    selected = null;
  }
  reset();

  const bedOf = (id: string) => beds.find((b) => b.id === id);
  /** Dos literas o dos dobles del mismo tamaño se pueden apilar en el mismo sitio (litera doble). */
  const stackable = (a: string, b: string) => STACKABLE.has(bedOf(a)?.kind ?? '') && STACKABLE.has(bedOf(b)?.kind ?? '');
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
    if (b.isNew) return 'Nueva';
    return isOccupied(b) ? 'Ocupada esta noche' : 'Libre esta noche';
  }

  function tryPlace(id: string, cell: Cell, done: string): boolean {
    const problem = dorm.placeProblem(grid, cells, id, cell, sizes, stackable);
    if (problem?.reason === 'fuera') { say('No cabe ahí: se saldría de la estancia.'); return false; }
    if (problem?.reason === 'encima') { say(`No cabe ahí: se montaría sobre ${nameOf(problem.other)}.`); return false; }
    cells.set(id, cell);
    say(done);
    schedule();
    return true;
  }

  function move(id: string, dir: dorm.Direction): void {
    const cell = cells.get(id);
    if (cell && tryPlace(id, dorm.moved(cell, dir), `${nameOf(id)}: x ${dorm.moved(cell, dir).x + 1}, y ${dorm.moved(cell, dir).y + 1}.`)) paint(id);
  }
  function rotate(id: string): void {
    const cell = cells.get(id);
    if (!cell) return;
    const next = dorm.rotated(grid, cells, id, cell, sizes);
    if (tryPlace(id, next, `${nameOf(id)}: ${next.rot === 90 ? 'a lo largo' : 'a lo ancho'}.`)) paint(id);
  }
  function remove(id: string): void {
    const b = bedOf(id);
    if (!b) return;
    if (!b.isNew && blockers(id) > 0) return say(`No se puede quitar ${b.label}: tiene ${plural(blockers(id), 'asignación viva', 'asignaciones vivas')}. Quítalas primero desde la ficha de cada reserva.`);
    beds = beds.filter((x) => x.id !== id);
    cells.delete(id);
    if (!b.isNew) removed.push(...b.parts);
    // ya creada en Recursos pero aún sin traer: se archiva allí por su id
    else if (b.inResources) removed.push({ resource_id: b.id } as unknown as Row);
    selected = null;
    say(`${b.label} quitada.`);
    schedule();
    paint();
  }
  function add(kind: string, text: string, capacity: number): void {
    const same = beds.filter((b) => b.kind === kind).length + 1;
    const id = crypto.randomUUID();
    sizes.set(id, dorm.sizeOfKind(kind));
    let cell = dorm.firstFree(grid, cells, id, sizes);
    while (!cell && grid.rows < dorm.GRID_LIMITS.maxRows) { grid = { ...grid, rows: grid.rows + 1 }; cell = dorm.firstFree(grid, cells, id, sizes); }
    if (!cell) { sizes.delete(id); return say('No cabe otra cama: la estancia ya tiene el fondo máximo.'); }
    const extra = kind === 'supletoria';
    beds.push({ id, label: `${text} ${same}`, kind, seats: extra ? 0 : capacity, extras: extra ? capacity : 0, parts: [], isNew: true, team: false });
    cells.set(id, cell);
    say(`${text} ${same} añadida en el primer hueco.`);
    schedule();
    paint(id);
  }
  function resize(axis: 'cols' | 'rows', delta: number): void {
    const next = { ...grid, [axis]: grid[axis] + delta };
    if (!dorm.validGrid(next)) return say(axis === 'cols' ? `El ancho va de ${dorm.GRID_LIMITS.minCols} a ${dorm.GRID_LIMITS.maxCols} cuadrantes.` : `El fondo va de ${dorm.GRID_LIMITS.minRows} a ${dorm.GRID_LIMITS.maxRows} cuadrantes.`);
    if (!dorm.fitsIn(next, cells, sizes)) return say('No se puede encoger: alguna cama se quedaría fuera. Muévela antes.');
    grid = next;
    say(`${axis === 'cols' ? 'Ancho' : 'Fondo'}: ${next[axis]} cuadrantes.`);
    schedule();
    paint();
  }

  function schedule(delay = 400): void {
    if (timer) clearTimeout(timer);
    status.textContent = 'Guardando…';
    timer = setTimeout(() => { timer = null; void flush(); }, delay);
  }
  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (saving) { again = true; return saving; }
    saving = (o.fromResources ? saveToResources() : save()).finally(() => { saving = null; });
    await saving;
    if (again) { again = false; await flush(); }
  }
  /** Las filas tal como están ahora en el dispositivo: cada guardado compara y manda con la revisión del momento. */
  async function fresh(): Promise<{ space: Row; beds: Map<string, Row> }> {
    const space = ((await o.client.get(SPACES, o.space.id)) as Row | null) ?? o.space;
    const rows = ((await o.client.list(BEDS)) as Row[]).filter((r) => !r.deleted_at && r.space_id === o.space.id);
    return { space, beds: new Map(rows.map((r) => [String(r.id), r])) };
  }
  function layoutOps(space: Row): RowOperation[] {
    const changed = !dorm.validGrid(space.layout) || space.layout.cols !== grid.cols || space.layout.rows !== grid.rows;
    return changed ? [{ op: 'update', table: SPACES, id: space.id, expectedRevision: space.revision, fields: { layout: grid } }] : [];
  }
  /** Sitio y «de equipo» de las camas ya guardadas, frente a lo que hay ahora. */
  function placeOps(now: Map<string, Row>): RowOperation[] {
    const ops: RowOperation[] = [];
    for (const b of beds) {
      if (b.isNew) continue;
      const cell = cells.get(b.id) ?? null;
      // Todas las partes de la pieza guardan el mismo sitio (y si es de equipo).
      for (const part of b.parts) {
        const row = now.get(String(part.id)) ?? part;
        const before = dorm.validCell(row.cell) ? row.cell : null;
        const moved = !before || !cell || before.x !== cell.x || before.y !== cell.y || before.rot !== cell.rot;
        const team = (row.team_bed === true) !== b.team;
        if (moved || team) ops.push({ op: 'update', table: BEDS, id: row.id, expectedRevision: row.revision, fields: { ...(moved ? { cell } : {}), ...(team ? { team_bed: b.team } : {}) } });
      }
    }
    return ops;
  }
  function saved(): void { status.textContent = navigator.onLine ? 'Guardado.' : 'Guardado en este dispositivo. Se enviará al reconectar.'; }
  /** «Hecho»: guarda lo que quede, cierra la edición y vuelve a pintar con lo guardado. */
  async function done(): Promise<void> {
    await flush();
    editing = false;
    resources?.stop(); resources = null;
    const now = await fresh();
    o.space = now.space;
    o.beds = [...now.beds.values()].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
    reset();
    say('');
    paint();
  }

  /**
   * Con los espacios en Recursos: primero las camas en Recursos (nuevas, quitadas y con tipo o plazas cambiados); después el
   * espejo las trae a Booking y aquí se guarda la rejilla y el sitio de cada una (las nuevas, por su `resource_id`).
   */
  async function saveToResources(): Promise<void> {
    const parent = o.space.resource_id as string | null;
    if (!parent) { status.textContent = ''; return say('Esta estancia no está enlazada con Recursos: no se pueden guardar sus camas.'); }
    resources ??= createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: o.client, clearOnLogout: true });
    const resOps: RowOperation[] = [];
    const created: DraftBed[] = [];
    const sentRemoved = removed.slice();
    try {
      await resources.start();
      const res = resources;
      const rowOf = async (id: string) => (await res.get('resources.spaces' as never, id)) as Row | null;
      const attrs = (b: DraftBed) => ({ bed_kind: b.kind === 'supletoria' ? 'individual' : b.kind, capacity: b.seats, extra_capacity: b.extras });
      let pos = o.beds.reduce((max, b) => Math.max(max, Number(b.position) || 0), 0);
      for (const b of beds) {
        if (b.isNew && !b.inResources) {
          pos += 1024;
          resOps.push({ op: 'insert', table: 'resources.spaces' as never, id: b.id, fields: { kind: 'cama', name: b.label, parent_id: parent, position: pos, attributes: attrs(b) } });
          created.push(b);
        } else if (b.edited) {
          const rid = b.isNew ? b.id : b.parts.find((r) => r.resource_id)?.resource_id as string | undefined;
          const row = rid ? await rowOf(rid) : null;
          if (!row) { status.textContent = ''; return say(`No encuentro ${b.label} en Recursos. Sincroniza y vuelve a intentarlo.`); }
          const a = row.attributes ?? {};
          const want = attrs(b);
          if (a.bed_kind !== want.bed_kind || Number(a.capacity) !== want.capacity || Number(a.extra_capacity ?? 0) !== want.extra_capacity) {
            resOps.push({ op: 'update', table: 'resources.spaces' as never, id: row.id, expectedRevision: row.revision, fields: { attributes: { ...a, ...want } } });
          }
        }
      }
      for (const rid of new Set(sentRemoved.map((r) => r.resource_id as string | null).filter((x): x is string => !!x))) {
        const row = await rowOf(rid);
        if (row && row.active) resOps.push({ op: 'update', table: 'resources.spaces' as never, id: row.id, expectedRevision: row.revision, fields: { active: false } });
      }
      if (resOps.length) await res.commit(resOps);
      for (const b of created) b.inResources = true;
      removed = removed.filter((r) => !sentRemoved.includes(r));
      if (resOps.length && navigator.onLine) { await res.sync(); await syncMirror(o.client); await o.client.sync(); }
    } catch (error) {
      status.textContent = '';
      return say(`No se ha guardado en Recursos: ${describeError(error)}`);
    }
    // la rejilla y el sitio de cada cama en Booking; las nuevas, en cuanto el espejo las trae (por su `resource_id`)
    const now = await fresh();
    const ops: RowOperation[] = [...layoutOps(now.space), ...placeOps(now.beds)];
    const mirrored = new Map([...now.beds.values()].filter((r) => r.resource_id).map((r) => [String(r.resource_id), r]));
    const arrived: Array<[DraftBed, Row]> = [];
    for (const b of beds.filter((x) => x.isNew && x.inResources)) {
      const r = mirrored.get(b.id);
      if (!r) continue;
      arrived.push([b, r]);
      ops.push({ op: 'update', table: BEDS, id: r.id, expectedRevision: r.revision, fields: { cell: cells.get(b.id) ?? null, ...(b.team ? { team_bed: true } : {}) } });
    }
    try {
      if (ops.length) await o.client.commit(ops);
      for (const [b, r] of arrived) { b.isNew = false; b.parts = [r]; }
      const waiting = beds.filter((x) => x.isNew && x.inResources).length;
      if (waiting && waits < 5) { waits += 1; status.textContent = 'Camas guardadas en Recursos. Su sitio se guarda en cuanto lleguen a Booking…'; schedule(3000); }
      else { waits = 0; if (waiting) status.textContent = 'Camas guardadas en Recursos. Su sitio se guardará al volver a abrir el dormitorio.'; else saved(); }
    } catch (error) {
      status.textContent = '';
      say(`No se ha guardado el sitio de las camas: ${describeError(error)}`);
    }
  }

  async function save(): Promise<void> {
    const now = await fresh();
    const ops: RowOperation[] = [...layoutOps(now.space)];
    let pos = Math.max(0, ...o.beds.map((b) => Number(b.position) || 0), ...[...now.beds.values()].map((b) => Number(b.position) || 0));
    const created: DraftBed[] = [];
    for (const b of beds.filter((x) => x.isNew)) {
      pos += 1024;
      ops.push({ op: 'insert', table: BEDS, id: b.id, fields: { space_id: o.space.id, label: b.label, kind: b.kind, capacity: b.seats + b.extras, active: true, position: pos, cell: cells.get(b.id) ?? null, team_bed: b.team } });
      created.push(b);
    }
    ops.push(...placeOps(now.beds));
    const sentRemoved = removed.slice();
    for (const part of sentRemoved) {
      const row = now.beds.get(String(part.id));
      if (row) ops.push({ op: 'delete', table: BEDS, id: row.id, expectedRevision: row.revision });
    }
    if (!ops.length) { removed = removed.filter((r) => !sentRemoved.includes(r)); return saved(); }
    try {
      await o.client.commit(ops);
      for (const b of created) { b.isNew = false; b.parts = [{ id: b.id, cell: cells.get(b.id) ?? null, team_bed: b.team } as unknown as Row]; }
      removed = removed.filter((r) => !sentRemoved.includes(r));
      saved();
    } catch (error) {
      status.textContent = '';
      say(`No se ha guardado: ${describeError(error)}`);
    }
  }

  function bedButton(b: DraftBed): HTMLElement {
    const cell = cells.get(b.id)!;
    const r = dorm.footprint(cell, sizes.get(b.id));
    const state = stateText(b);
    const occupied = isOccupied(b);
    const button = el('button', {
      type: 'button', class: `bk-dorm-bed${onlyExtra(b) ? ' extra' : b.extras ? ' mixed' : ''}${occupied ? ' occupied' : ''}${selected === b.id ? ' picked' : ''}`,
      id: `dormBed-${b.id}`, dataset: { bed: b.id, kind: b.kind, rot: String(cell.rot) },
      style: `grid-column: ${r.x + 1} / span ${r.w}; grid-row: ${r.y + 1} / span ${r.h}`,
      'aria-label': `${b.label}, ${label(b.kind)}, ${placesText(b)}, ${b.team ? 'cama de equipo, ' : ''}${state}${cell.rot === 90 ? ', a lo largo' : ''}`,
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
        else if (event.key === 'Delete' || event.key === 'Supr') { event.preventDefault(); remove(b.id); }
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
      el('span', { class: 'bk-dorm-bed-kind', 'aria-hidden': 'true' }, `${b.extras && b.seats ? `${b.seats} + ${b.extras}` : label(b.kind)} · ${b.team ? 'Equipo · ' : ''}${state.split(' ')[0]}`));
    return button;
  }

  function paint(focus: string | null = null): void {
    const placed = beds.filter((b) => cells.has(b.id));
    const outside = beds.filter((b) => !cells.has(b.id));
    const board = el('div', {
      class: `bk-dorm-board${editing ? ' editing' : ''}`, role: 'group', 'aria-label': `${o.space.name}: ${grid.cols} de ancho por ${grid.rows} de fondo`,
      // cuadrantes cuadrados (1 m × 1 m): el ancho no estira las columnas; en el móvil, el cuadrante encoge para que quepa
      style: `--bk-dorm-cell: min(44px, calc((100vw - 72px) / ${grid.cols})); grid-template-columns: repeat(${grid.cols}, var(--bk-dorm-cell)); grid-template-rows: repeat(${grid.rows}, var(--bk-dorm-cell))`,
    },
      ...Array.from({ length: grid.cols * grid.rows }, (_, i) => el('span', { class: 'bk-dorm-cell', 'aria-hidden': 'true', style: `grid-column: ${(i % grid.cols) + 1}; grid-row: ${Math.floor(i / grid.cols) + 1}` })),
      ...placed.map((b, i) => {
        const button = bedButton(b);
        const c = cells.get(b.id)!;
        if (placed.slice(0, i).some((x) => { const d = cells.get(x.id)!; return d.x === c.x && d.y === c.y && d.rot === c.rot; })) button.classList.add('stacked');
        return button;
      }));
    const sel = selected ? bedOf(selected) : null;
    const total = beds.reduce((s, b) => s + b.seats, 0);
    const extras = beds.reduce((s, b) => s + b.extras, 0);
    replace(host,
      el('p', { class: 'bk-dorm-summary' }, beds.length === 0 ? 'Sin camas.' : `${plural(beds.length, 'cama', 'camas')} · ${plural(total, 'plaza', 'plazas')}${extras ? ` + ${plural(extras, 'supletoria', 'supletorias')}` : ''}`),
      beds.length === 0 && !editing
        ? el('p', { class: 'hint', id: 'dormEmpty' }, o.canEdit ? 'Sin camas: añade la primera para usarla como dormitorio.' : 'Sin camas.')
        : board,
      outside.length ? el('p', { class: 'hint' }, `Sin sitio en el dibujo: ${outside.map((b) => b.label).join(', ')}.`) : null,
      inactive.length ? el('p', { class: 'hint', id: 'dormInactive' }, `${inactive.length === 1 ? 'Archivada, no se dibuja' : 'Archivadas, no se dibujan'}: ${inactive.map((b) => String(b.label)).join(', ')}.`) : null,
      beds.some((b) => b.extras) ? el('ul', { class: 'bk-dorm-legend', 'aria-hidden': 'true' },
        el('li', { class: 'fixed' }, el('i'), 'Fija'), el('li', { class: 'extra' }, el('i'), 'Supletoria'), el('li', { class: 'mixed' }, el('i'), 'Fija + supletoria')) : null,
      editing ? el('div', { class: 'bk-dorm-tools', id: 'dormTools' },
        el('div', { class: 'bk-dorm-size' },
          sizer('Ancho', 'cols'), sizer('Fondo', 'rows')),
        el('div', { class: 'btnrow', id: 'dormAdd' }, el('span', { class: 'hint' }, 'Añadir:'), ...NEW_BEDS.map((n) => el('button', {
            type: 'button', class: 'ghost small', id: `dormAdd-${n.kind}`, 'data-feedback-id': 'booking.espacios.dormitorio.anadir', 'data-feedback-label': 'Añadir cama',
            onclick: () => add(n.kind, n.text, n.capacity),
          }, n.text))),
        sel ? el('div', { class: 'btnrow bk-dorm-bar', id: 'dormBar', role: 'toolbar', 'aria-label': `Mover ${sel.label}` },
          el('strong', null, sel.label),
          el('button', { type: 'button', class: 'ghost small', id: 'dormRotate', 'data-feedback-id': 'booking.espacios.dormitorio.girar', 'data-feedback-label': 'Girar', onclick: () => rotate(sel.id) }, '↻ Girar'),
          ...DIRS.map((d) => el('button', { type: 'button', class: 'ghost small bk-dorm-arrow', 'aria-label': `${d.text}: ${sel.label}`, 'data-feedback-id': 'booking.espacios.dormitorio.mover', 'data-feedback-label': 'Mover', onclick: () => move(sel.id, d.dir) }, d.arrow)),
          el('button', { type: 'button', class: 'ghost small danger', id: 'dormRemove', 'data-feedback-id': 'booking.espacios.dormitorio.quitar', 'data-feedback-label': 'Quitar', onclick: () => remove(sel.id) }, 'Quitar'))
          : el('p', { class: 'hint' }, 'Toca una cama para moverla, girarla, quitarla o cambiar sus plazas. En el ordenador: flechas, R para girar y Supr para quitar; también se arrastra.'),
        sel ? el('div', { class: 'bk-dorm-seats' }, o.fromResources ? seatsEditor(sel) : null, el('label', { class: 'field check', id: 'dormTeam', 'data-feedback-id': 'booking.espacios.dormitorio.equipo', 'data-feedback-label': 'Cama de equipo' },
          el('input', { type: 'checkbox', checked: sel.team, ...fieldAttrs({ id: 'booking.espacios.dormitorio.equipo', entity: 'booking.beds', prop: 'team_bed', label: 'Cama de equipo', confirm: 'event' }),
            onchange: (e: Event) => { sel.team = (e.target as HTMLInputElement).checked; say(`${sel.label}: ${sel.team ? 'cama de equipo' : 'para huéspedes'}.`); schedule(); paint(sel.id); } }),
          el('span', { title: 'Solo el organizador, el personal y dirección; los huéspedes no la ven' }, 'Equipo'))) : null,
        el('div', { class: 'btnrow' },
          el('button', { type: 'button', class: 'primary', id: 'dormDone', 'data-feedback-id': 'booking.espacios.dormitorio.hecho', 'data-feedback-label': 'Terminar de editar', onclick: () => void done() }, 'Hecho'),
          el('span', { class: 'hint' }, 'Los cambios se guardan solos.'), status))
        : o.canEdit ? el('p', null, el('button', { type: 'button', class: 'ghost small', id: 'dormEdit', 'data-feedback-id': 'booking.espacios.dormitorio.editar', 'data-feedback-label': 'Editar la distribución', onclick: () => { editing = true; say(''); status.textContent = ''; paint(); } }, 'Editar la distribución')) : null,
      live);
    if (focus) host.querySelector<HTMLElement>(`#dormBed-${CSS.escape(focus)}`)?.focus({ preventScroll: true });
  }

  /** Tipo y plazas fijas y supletorias de la cama elegida (con los espacios en Recursos). */
  function seatsEditor(b: DraftBed): HTMLElement {
    const kindNow = b.kind === 'supletoria' ? 'individual' : b.kind;
    const kind = el('select', { id: 'dormKind', ...fieldAttrs({ id: 'booking.espacios.dormitorio.tipo', entity: 'resources.spaces', prop: 'attributes', label: 'Tipo de cama', confirm: 'event' }),
      onchange: () => change() }, RESOURCE_KINDS.map(([v, t]) => el('option', { value: v }, t))) as HTMLSelectElement;
    kind.value = RESOURCE_KINDS.some(([v]) => v === kindNow) ? kindNow : 'individual';
    const num = (id: string, fid: string, text: string, value: number) => el('input', { id, type: 'number', min: 0, max: 2, step: 1, inputmode: 'numeric', value: String(value),
      ...fieldAttrs({ id: fid, entity: 'resources.spaces', prop: 'attributes', label: text, confirm: 'event' }), onchange: () => change() }) as HTMLInputElement;
    const seats = num('dormSeats', 'booking.espacios.dormitorio.fijas', 'Plazas fijas', b.seats);
    const extras = num('dormExtras', 'booking.espacios.dormitorio.supletorias', 'Plazas supletorias', b.extras);
    function change(): void {
      const f = Math.round(Number(seats.value)); const x = Math.round(Number(extras.value));
      if (![f, x].every((n) => Number.isInteger(n) && n >= 0 && n <= 2) || f + x < 1) return say('Las plazas van de 0 a 2, y al menos una en total.');
      b.kind = kind.value; b.seats = f; b.extras = x; b.edited = true;
      sizes.set(b.id, dorm.sizeOfKind(b.kind));
      say(`${b.label}: ${label(b.kind)}, ${placesText(b)}.`);
      schedule();
      paint(b.id);
    }
    return el('div', { class: 'bk-dorm-seats-fields', id: 'dormSeatsEditor', 'data-feedback-id': 'booking.espacios.dormitorio.plazas', 'data-feedback-label': 'Tipo y plazas de la cama' },
      el('label', { class: 'field' }, el('span', null, 'Tipo'), kind),
      el('label', { class: 'field' }, el('span', null, 'Fijas'), seats),
      el('label', { class: 'field' }, el('span', null, 'Supletorias'), extras));
  }

  function sizer(text: string, axis: 'cols' | 'rows'): HTMLElement {
    return el('span', { class: 'bk-dorm-sizer', id: `dormSize-${axis}` },
      el('span', null, text),
      el('button', { type: 'button', class: 'ghost small', 'aria-label': `${text}: menos`, 'data-feedback-id': 'booking.espacios.dormitorio.tamano', 'data-feedback-label': 'Tamaño de la estancia', onclick: () => resize(axis, -1) }, '−'),
      el('strong', null, String(grid[axis])),
      el('button', { type: 'button', class: 'ghost small', 'aria-label': `${text}: más`, 'data-feedback-id': 'booking.espacios.dormitorio.tamano', 'data-feedback-label': 'Tamaño de la estancia', onclick: () => resize(axis, 1) }, '+'));
  }

  paint();
  // al irse sin «Hecho», lo que quede por guardar se guarda igual
  const release = () => { resources?.stop(); resources = null; };
  return { element: host, editing: () => editing, destroy: () => { drag = null; if (timer || saving) void flush().finally(release); else release(); } };
}
