/**
 * Selector visual de espacio (encargo de VG del 6-11; para la ficha de la tarea de Tasks, y para Food, Booking y Central):
 * se elige en pasos y cada paso se pinta al momento.
 * 1. **Altura:** las alturas de la finca, un toque.
 * 2. **Interior o exterior:** dentro de la altura, sus edificios o sus zonas de fuera (un exterior puede no tener dibujo:
 *    entonces sus zonas salen como chips).
 * 3. **Habitación o zona:** el plano solo de ese edificio (`createSpaceMap`), tocando la estancia. Sin dibujo, su lista.
 * 4. **Cuadrante de 1 m²** (`cell: true`, opcional): la retícula de la habitación, en celdas del dibujo (las de la decoración).
 * **Dos planos a la vez** (`layout: 'stacked'`, borrador de la ficha de Tasks aprobado por VG el 06-11): encima, la altura
 * y el interior o exterior en chips («Interior · Albergue»), siempre a la vista; debajo, el plano del edificio o zona,
 * donde se toca la estancia (ya es el valor), y a su lado o debajo la estancia con su retícula de 1 m², con los cuadrantes
 * nombrados («B3») y «Toda la estancia». Tocar otra estancia arriba cambia la de abajo. Sin migas: la app pinta `path()`.
 * La **ruta** (modo por pasos) se ve siempre arriba y cada paso se puede tocar para volver: «Alturas › Altura 3 › Interior ›
 * Albergue › Hab 1 › Cuadrante B3». `placePath` la da en texto para la ficha: «Altura 3 › Interior · Albergue › Hab 1 ›
 * cuadrante B3» (el lado solo si la altura tiene más de una zona).
 * Ligero: nunca se carga la casa entera. Cada plano se pide al llegar a él y los enlaces firmados se guardan en una caché
 * común a todas las instancias. Devuelve `{ spaceId, cell? }` y acepta un valor inicial (abre en su sitio).
 * Prefijo de clases: `place-`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { cellSize, cellToRel, relToCell, validGrid } from './decor.ts';
import { createSpaceMap, type FloorPlan, type FloorPlanSource, type SpaceMap } from './map.ts';
import { ancestorsOf, indexSpaces, spaceDescendants, type SpaceRow, type SpaceSource } from './model.ts';

export interface PlaceCell { cellX: number; cellY: number; scale: 1 }
export interface PlaceValue { spaceId: string; cell?: PlaceCell | null }

export interface PlacePickerOptions {
  label: string;
  source: SpaceSource;
  plans: FloorPlan[] | FloorPlanSource;
  /** El cliente de la app (`SyncClient` o cualquiera con `fileUrl`): el selector pide él el enlace de cada dibujo. */
  files?: { fileUrl(fileId: string): Promise<string> };
  /** O el enlace ya resuelto (manda sobre `files`). */
  planUrl?: (fileId: string) => string | Promise<string>;
  value?: PlaceValue | null;
  /** Paso 4: el cuadrante de 1 m² dentro de la habitación. */
  cell?: boolean;
  /** `'steps'` (por defecto): un paso cada vez. `'stacked'`: el plano arriba y los cuadrantes de la estancia debajo. */
  layout?: 'steps' | 'stacked';
  onChange?: (value: PlaceValue | null) => void;
  /** Solo se pueden elegir los que cumplan esto (en los pasos 3 y 4). */
  filter?: (space: SpaceRow) => boolean;
  feedbackId?: string;
}

export interface PlacePicker {
  element: HTMLElement;
  get(): PlaceValue | null;
  /** La ruta de lo elegido en texto (`placePath`); vacía sin valor. */
  path(): string;
  /** Cambia el valor sin llamar a `onChange`. */
  set(value: PlaceValue | null): void;
  destroy(): void;
}

export const PLACE_PICKER_MARKS = {
  step: ['paso', 'Volver a un paso'],
  altura: ['altura', 'Elegir altura'],
  side: ['lado', 'Interior o exterior'],
  zone: ['zona', 'Elegir edificio o zona'],
  room: ['estancia', 'Elegir estancia'],
  cell: ['cuadrante', 'Elegir cuadrante'],
  clear: ['quitar', 'Quitar el sitio'],
} as const;

/** Enlaces firmados de los dibujos, comunes a todas las instancias (10 min): volver a un plano no espera. */
const URLS = new Map<string, { at: number; url: Promise<string> }>();
const TTL = 10 * 60_000;
function cachedUrl(fileId: string, resolve: (id: string) => string | Promise<string>): Promise<string> {
  const hit = URLS.get(fileId);
  if (hit && Date.now() - hit.at < TTL) return hit.url;
  const url = Promise.resolve(resolve(fileId));
  URLS.set(fileId, { at: Date.now(), url });
  url.catch(() => URLS.delete(fileId));
  return url;
}

const CONTAINERS = new Set(['edificio', 'exterior']);
const byPos = (a: SpaceRow, b: SpaceRow) => a.position - b.position || a.name.localeCompare(b.name);

/** La retícula de 1 m² de una habitación: primera celda del dibujo y tamaño (hasta 40 × 40). Sin escala o sin forma, null. */
function roomGrid(plans: readonly FloorPlan[], r: SpaceRow | undefined): { plan: FloorPlan; c0: { cellX: number; cellY: number }; cols: number; rws: number } | null {
  const plan = r?.planId ? plans.find((p) => p.id === r.planId) ?? null : null;
  const pts = r?.planShape?.points ?? [];
  if (!plan || !validGrid(plan.grid) || pts.length < 3) return null;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const c0 = relToCell(plan, 1, Math.min(...xs), Math.min(...ys));
  const c1 = relToCell(plan, 1, Math.max(...xs) - 1e-6, Math.max(...ys) - 1e-6);
  if (!c0 || !c1) return null;
  return { plan, c0, cols: Math.min(c1.cellX - c0.cellX + 1, 40), rws: Math.min(c1.cellY - c0.cellY + 1, 40) };
}

/** Nombre del cuadrante dentro de su estancia: la fila en letra y la columna en número, desde la esquina («B3»). */
export function cellName(x: number, y: number): string {
  const row = y < 26 ? String.fromCharCode(65 + y) : String.fromCharCode(64 + Math.floor(y / 26)) + String.fromCharCode(65 + (y % 26));
  return `${row}${x + 1}`;
}

/** Columna y fila (desde 1) del cuadrante dentro de su habitación; sin retícula, las celdas del dibujo. */
function cellInRoom(plans: readonly FloorPlan[], r: SpaceRow | undefined, cell: PlaceCell): { x: number; y: number } {
  const g = roomGrid(plans, r);
  return g ? { x: cell.cellX - g.c0.cellX + 1, y: cell.cellY - g.c0.cellY + 1 } : { x: cell.cellX, y: cell.cellY };
}

/** «Interior · Albergue» o «Exterior · Patio»: el edificio o la zona con su lado. */
function zoneLabel(z: SpaceRow): string {
  return `${z.kind === 'exterior' ? kt('Exterior') : kt('Interior')} · ${z.name}`;
}

/**
 * La ruta de un sitio en texto: «Altura 3 › Interior · Albergue › Hab 1 › cuadrante B3». El lado solo sale si la altura
 * tiene más de un edificio o zona. Vacía si el espacio no está.
 */
export function placePath(rows: readonly SpaceRow[], plans: readonly FloorPlan[], value: PlaceValue | null | undefined): string {
  if (!value) return '';
  const byId = indexSpaces(rows);
  const r = byId.get(value.spaceId);
  if (!r) return '';
  const parts = [...ancestorsOf(byId, r.id), r].map((s) => {
    if (!CONTAINERS.has(s.kind)) return s.name;
    const siblings = rows.filter((x) => x.parentId === s.parentId && x.active && CONTAINERS.has(x.kind)).length;
    return s.parentId && siblings > 1 ? zoneLabel(s) : s.name;
  });
  if (value.cell) { const c = cellInRoom(plans, r, value.cell); parts.push(kt('cuadrante {name}', { name: cellName(c.x - 1, c.y - 1) })); }
  return parts.join(' › ');
}

export function createPlacePicker(options: PlacePickerOptions): PlacePicker {
  const base = options.feedbackId;
  const mark = (key: keyof typeof PLACE_PICKER_MARKS) => (base ? { 'data-feedback-id': `${base}.${PLACE_PICKER_MARKS[key][0]}`, 'data-feedback-label': PLACE_PICKER_MARKS[key][1] } : {});
  const stacked = options.layout === 'stacked';
  const withCells = !!options.cell || stacked;
  const resolveUrl = options.planUrl ?? (options.files ? (id: string) => options.files!.fileUrl(id) : null);
  let rows: SpaceRow[] = [];
  let byId = indexSpaces(rows);
  let plans: FloorPlan[] = Array.isArray(options.plans) ? options.plans : [];
  let value: PlaceValue | null = options.value ?? null;
  // Dónde se está: altura → lado → edificio/zona → (estancia elegida) → cuadrante.
  let altura: string | null = null;
  let side: 'interior' | 'exterior' = 'interior';
  let zone: string | null = null;
  let room: string | null = null;
  let map: SpaceMap | null = null;
  let mapZone: string | null = null;
  let destroyed = false;

  const crumbs = el('nav', { class: 'place-crumbs', 'aria-label': kt('Dónde estás') });
  const body = el('div', { class: 'place-body' });
  const live = el('p', { class: 'vh', role: 'status', 'aria-live': 'polite' });
  const element = el('section', { class: `place-picker${stacked ? ' stacked' : ''}`, 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) },
    el('h3', { class: 'place-title' }, options.label), crumbs, body, live);

  const live_ = (s: SpaceRow) => s.active;
  const kids = (pid: string) => rows.filter((r) => r.parentId === pid && live_(r)).sort(byPos);
  // Un edificio puede tener un dibujo por planta (Recursos 0818): el primero por `position` y, en el mapa, el selector de plantas.
  const plansOf = (id: string) => plans.filter((p) => p.buildingId === id).sort((a, b) => a.position - b.position);
  const planOf = (id: string) => plansOf(id)[0] ?? null;
  const bothSides = (aid: string) => kids(aid).some((s) => s.kind === 'edificio') && kids(aid).some((s) => s.kind === 'exterior');
  const pickable = (s: SpaceRow) => live_(s) && !CONTAINERS.has(s.kind) && s.kind !== 'altura' && s.kind !== 'cama' && (!options.filter || options.filter(s));

  function emit(next: PlaceValue | null): void {
    value = next;
    options.onChange?.(next ? { ...next } : null);
  }

  /** Coloca los pasos según el valor (abre en su sitio). */
  function placeFromValue(): void {
    altura = null; zone = null; room = null; side = 'interior';
    if (!value) return;
    const chain = [...ancestorsOf(byId, value.spaceId), byId.get(value.spaceId)].filter((x): x is SpaceRow => !!x);
    altura = chain.find((s) => s.kind === 'altura')?.id ?? null;
    const z = chain.find((s) => CONTAINERS.has(s.kind));
    if (z) { zone = z.id; side = z.kind === 'exterior' ? 'exterior' : 'interior'; }
    const r = byId.get(value.spaceId);
    if (r && pickable(r)) room = r.id;
  }

  function chip(text: string, on: boolean, key: keyof typeof PLACE_PICKER_MARKS, act: () => void, extra: Record<string, string> = {}): HTMLElement {
    return el('button', { type: 'button', class: `filterchip place-chip${on ? ' on' : ''}`, 'aria-pressed': String(on), ...mark(key), ...extra, onclick: act }, text);
  }

  function paintCrumbs(): void {
    if (stacked) { crumbs.hidden = true; return; }
    const steps: Array<[string, () => void]> = [[kt('Alturas'), () => { altura = null; zone = null; room = null; paint(true); }]];
    if (altura) steps.push([byId.get(altura)?.name ?? '', () => { zone = null; room = null; paint(true); }]);
    // Interior o exterior, solo si la altura tiene de los dos (si no, no hay nada que elegir).
    if (altura && zone && bothSides(altura)) steps.push([side === 'interior' ? kt('Interior') : kt('Exterior'), () => { zone = null; room = null; paint(true); }]);
    if (zone) steps.push([byId.get(zone)?.name ?? '', () => { room = null; paint(true); }]);
    if (room) steps.push([byId.get(room)?.name ?? '', () => paint(true)]);
    const cell = room && value?.spaceId === room ? value.cell ?? null : null;
    if (cell) { const c = cellInRoom(plans, byId.get(room!), cell); steps.push([kt('Cuadrante {name}', { name: cellName(c.x - 1, c.y - 1) }), () => paint(true)]); }
    replace(crumbs, ...steps.map(([text, go], i) => i === steps.length - 1
      ? el('span', { class: 'place-crumb place-here', 'aria-current': 'step' }, text)
      : el('button', { type: 'button', class: 'linkbtn place-crumb', ...mark('step'), onclick: go }, text)),
    value ? el('button', { type: 'button', class: 'ghost small place-clear', ...mark('clear'), onclick: () => { emit(null); altura = null; zone = null; room = null; paint(true); } }, kt('Quitar')) : null);
  }

  function prefetch(ids: string[]): void {
    if (!resolveUrl) return;
    for (const id of ids) { const p = planOf(id); if (p?.fileId) void cachedUrl(p.fileId, resolveUrl).then((u) => { const img = new Image(); img.src = u; }, () => undefined); }
  }

  function paint(focus = false): void {
    if (destroyed) return;
    if (stacked) { paintStacked(focus); return; }
    paintCrumbs();
    if (!altura) {
      const alturas = rows.filter((r) => r.kind === 'altura' && live_(r)).sort(byPos);
      replace(body, el('div', { class: 'place-chips', role: 'group', 'aria-label': kt('Altura') },
        ...alturas.map((a) => chip(a.name, value ? ancestorsOf(byId, value.spaceId).some((x) => x.id === a.id) : false, 'altura', () => { altura = a.id; paint(true); }))));
      if (!alturas.length) replace(body, el('p', { class: 'hint' }, kt('No hay alturas en Recursos.')));
    } else if (!zone) {
      const inside = kids(altura).filter((s) => s.kind === 'edificio');
      const outside = kids(altura).filter((s) => s.kind === 'exterior');
      if (!inside.length && outside.length) side = 'exterior';
      if (!outside.length && inside.length) side = 'interior';
      const list = side === 'interior' ? inside : outside;
      prefetch(list.map((s) => s.id));
      replace(body,
        inside.length && outside.length ? el('div', { class: 'segmented place-side', role: 'group', 'aria-label': kt('Interior o exterior') },
          ...(['interior', 'exterior'] as const).map((k) => el('button', { type: 'button', class: side === k ? 'on' : '', 'aria-pressed': String(side === k), ...mark('side'), onclick: () => { side = k; paint(true); } },
            k === 'interior' ? kt('Interior') : kt('Exterior')))) : null,
        el('div', { class: 'place-chips', role: 'group', 'aria-label': side === 'interior' ? kt('Edificio') : kt('Zona de fuera') },
          ...list.map((z) => chip(z.name, false, 'zone', () => { zone = z.id; side = z.kind === 'exterior' ? 'exterior' : 'interior'; paint(true); }))),
        !list.length ? el('p', { class: 'hint' }, kt('Nada en esta altura.')) : null);
    } else if (room && withCells && !stacked) {
      paintCells(room, body);
    } else {
      paintZone(zone, body);
    }
    if (focus) body.querySelector<HTMLElement>('button[aria-pressed="true"], button, [tabindex="0"]')?.focus({ preventScroll: true });
  }

  /** `layout: 'stacked'`: chips de altura y de lado arriba; el plano y la estancia con su retícula, a la vez. */
  function paintStacked(focus: boolean): void {
    paintCrumbs();
    const alturas = rows.filter((r) => r.kind === 'altura' && live_(r)).sort(byPos);
    const zones = altura ? kids(altura).filter((s) => CONTAINERS.has(s.kind)) : [];
    const where = el('div', { class: 'place-where' },
      alturas.length ? el('div', { class: 'place-chips', role: 'group', 'aria-label': kt('Altura') },
        ...alturas.map((a) => chip(a.name, a.id === altura, 'altura', () => {
          // Al elegir la altura se abre ya su edificio (o su única zona): un toque menos.
          const z = kids(a.id).filter((s) => CONTAINERS.has(s.kind));
          altura = a.id; zone = (z.length === 1 ? z[0] : z.find((s) => s.kind === 'edificio') ?? z[0])?.id ?? null; room = null;
          prefetch(z.map((s) => s.id));
          paint(true);
        }))) : el('p', { class: 'hint' }, kt('No hay alturas en Recursos.')),
      zones.length > 1 ? el('div', { class: 'place-chips', role: 'group', 'aria-label': kt('Interior o exterior') },
        ...zones.map((z) => chip(zoneLabel(z), z.id === zone, 'side', () => { zone = z.id; room = null; paint(true); }))) : null);
    const top = el('div', { class: 'place-top' });
    const below = el('div', { class: 'place-below' });
    if (!altura) top.append(el('p', { class: 'hint' }, kt('Elige la altura.')));
    else if (!zone) top.append(el('p', { class: 'hint' }, kt('Nada en esta altura.')));
    else paintZone(zone, top);
    if (room) paintCells(room, below);
    else below.append(el('p', { class: 'place-map-title' }, kt('Elige una estancia en el plano de arriba y aquí sale con sus cuadrantes de 1 m².')));
    replace(body, where, el('div', { class: 'place-maps' }, top, below));
    if (focus) where.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }

  /** Paso 3: el plano de ese edificio o zona (solo ese) o, sin dibujo, sus estancias como chips. */
  function paintZone(zid: string, host: HTMLElement): void {
    const plan = planOf(zid);
    const inZone = new Set(spaceDescendants(rows, zid));
    const choose = (s: SpaceRow) => {
      room = s.id;
      // En `stacked` la estancia ya es el valor; el cuadrante, si hace falta, la afina.
      if (!withCells || stacked) emit({ spaceId: s.id });
      live.textContent = kt('Elegido: {name}', { name: s.name });
      paint(!stacked);
    };
    const title = stacked ? el('p', { class: 'place-map-title' }, kt('{name}: toca la estancia', { name: byId.get(zid)?.name ?? '' })) : null;
    if (!plan) {
      replace(host, title, el('div', { class: 'place-chips', role: 'group', 'aria-label': kt('Estancia') },
        ...rows.filter((r) => inZone.has(r.id) && pickable(r)).sort(byPos).map((r) => chip(r.name, (room ?? value?.spaceId) === r.id, 'room', () => choose(r)))));
      return;
    }
    if (!map || mapZone !== zid) {
      map?.destroy();
      mapZone = zid;
      map = createSpaceMap({
        source: options.source, plans: plansOf(zid), plan: plan.id, mode: 'map', label: kt('Plano de {name}', { name: byId.get(zid)?.name ?? '' }),
        ...(resolveUrl ? { planUrl: (id: string) => cachedUrl(id, resolveUrl) } : {}),
        filter: (s) => inZone.has(s.id) && pickable(s),
        layer: (s) => ((stacked ? room ?? value?.spaceId : value?.spaceId) === s.id ? { tone: 'accent', label: kt('Elegido') } : null),
        onPick: (s) => { if (inZone.has(s.id) && pickable(s)) choose(s); },
        feedbackId: base ? `${base}.plano` : undefined,
      });
    } else map.repaint();
    replace(host, title, map.element);
  }

  /** Paso 4: la retícula de 1 m² de la habitación, en celdas del dibujo. Se pinta sola, sin la imagen del plano. */
  function paintCells(rid: string, host: HTMLElement): void {
    const r = byId.get(rid)!;
    const pts = r.planShape?.points ?? [];
    const grid = roomGrid(plans, r);
    const done = () => { emit({ spaceId: rid }); paintCrumbs(); if (stacked) paintCells(rid, host); };
    if (!grid) {
      replace(host, el('p', { class: 'hint' }, kt('Este dibujo no tiene escala: el sitio se queda en la habitación.')),
        stacked ? null : el('button', { type: 'button', class: 'primary small', onclick: done }, kt('Elegir {name}', { name: r.name })));
      return;
    }
    const { plan, c0, cols, rws } = grid;
    const w = plan.width > 0 ? plan.width : 1000; const h = plan.height > 0 ? plan.height : 700;
    const cs = cellSize(plan, 1)!;
    const at0 = cellToRel(plan, 1, c0.cellX, c0.cellY)!;
    const vb = [at0.x * w, at0.y * h, cols * cs, rws * cs];
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', vb.map((n) => n.toFixed(2)).join(' '));
    svg.setAttribute('class', 'place-cells');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', kt('Cuadrantes de 1 m² de {name}', { name: r.name }));
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', pts.map((p) => `${(p[0] * w).toFixed(2)},${(p[1] * h).toFixed(2)}`).join(' '));
    poly.setAttribute('class', 'place-room');
    svg.append(poly);
    const sel = value?.spaceId === rid ? value.cell ?? null : null;
    for (let y = 0; y < rws; y++) for (let x = 0; x < cols; x++) {
      const cx = c0.cellX + x; const cy = c0.cellY + y;
      const on = !!sel && sel.cellX === cx && sel.cellY === cy;
      const name = cellName(x, y);
      const rect = document.createElementNS(NS, 'rect');
      const a = cellToRel(plan, 1, cx, cy)!;
      // En `stacked`, cada cuadrante algo separado y redondeado, con su nombre dentro (como el borrador).
      const inset = stacked ? cs * 0.04 : 0;
      for (const [k, v] of Object.entries({ x: (a.x * w + inset).toFixed(2), y: (a.y * h + inset).toFixed(2), width: (cs - 2 * inset).toFixed(2), height: (cs - 2 * inset).toFixed(2), ...(stacked ? { rx: (cs * 0.08).toFixed(2) } : {}) })) rect.setAttribute(k, v);
      rect.setAttribute('class', `place-cell${on ? ' on' : ''}`);
      rect.setAttribute('role', 'button');
      rect.setAttribute('tabindex', on || (!sel && x === 0 && y === 0) ? '0' : '-1');
      rect.setAttribute('aria-pressed', String(on));
      rect.setAttribute('aria-label', kt('Cuadrante {name}', { name }));
      if (base) { rect.setAttribute('data-feedback-id', `${base}.${PLACE_PICKER_MARKS.cell[0]}`); rect.setAttribute('data-feedback-label', PLACE_PICKER_MARKS.cell[1]); }
      rect.dataset.cell = `${x},${y}`;
      // En `stacked`, tocar el cuadrante elegido lo quita (vuelve a toda la estancia).
      const pick = () => { emit(stacked && on ? { spaceId: rid } : { spaceId: rid, cell: { cellX: cx, cellY: cy, scale: 1 } }); live.textContent = stacked && on ? kt('Toda la estancia') : kt('Cuadrante {name}', { name }); paintCrumbs(); paintCells(rid, host); host.querySelector<SVGElement>(`[data-cell="${x},${y}"]`)?.focus(); };
      rect.addEventListener('click', pick);
      rect.addEventListener('keydown', (e) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(); return; }
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
        if (!d) return;
        e.preventDefault();
        const nx = Math.max(0, Math.min(cols - 1, x + d[0]!)); const ny = Math.max(0, Math.min(rws - 1, y + d[1]!));
        const next = body.querySelector<SVGElement>(`[data-cell="${nx},${ny}"]`);
        if (next) { rect.setAttribute('tabindex', '-1'); next.setAttribute('tabindex', '0'); next.focus(); }
      });
      svg.append(rect);
      if (stacked) {
        const label = document.createElementNS(NS, 'text');
        for (const [k, v] of Object.entries({ x: (a.x * w + cs * 0.12).toFixed(2), y: (a.y * h + cs * 0.3).toFixed(2), 'font-size': (cs * 0.2).toFixed(2), 'aria-hidden': 'true' })) label.setAttribute(k, v);
        label.setAttribute('class', 'place-cell-name');
        label.textContent = name;
        svg.append(label);
      }
    }
    if (stacked) {
      const selName = sel ? cellName(sel.cellX - c0.cellX, sel.cellY - c0.cellY) : null;
      replace(host, el('p', { class: 'place-map-title' }, kt('{name} ({w} × {h} m): toca un cuadrante si hace falta', { name: r.name, w: String(cols), h: String(rws) })), svg,
        el('div', { class: 'place-cell-foot' }, el('span', null, selName ? kt('Cuadrante {name}', { name: selName }) : kt('Toda la estancia')),
          selName ? el('button', { type: 'button', class: 'ghost small place-room-only', onclick: done }, kt('Toda la estancia')) : null));
      return;
    }
    replace(host, el('p', { class: 'hint place-hint' }, kt('Toca el cuadrante de 1 m², o quédate en la habitación.')), svg,
      el('button', { type: 'button', class: 'ghost small place-room-only', onclick: done }, kt('Solo la habitación')));
  }

  const offRows = options.source.subscribe((next) => { rows = next; byId = indexSpaces(rows); paint(); });
  const offPlans = !Array.isArray(options.plans) && options.plans.subscribe ? options.plans.subscribe((next) => { plans = next; paint(); }) : () => undefined;
  void Promise.all([options.source.list(), Array.isArray(options.plans) ? options.plans : options.plans.list()]).then(([r, p]) => {
    if (destroyed) return;
    rows = r; byId = indexSpaces(rows); plans = p;
    placeFromValue();
    paint();
  });

  return {
    element,
    get: () => (value ? { ...value } : null),
    path: () => placePath(rows, plans, value),
    set(next) { value = next; placeFromValue(); paint(); },
    destroy() { destroyed = true; offRows(); offPlans(); map?.destroy(); element.remove(); },
  };
}
