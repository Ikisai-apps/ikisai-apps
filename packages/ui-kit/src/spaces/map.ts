/**
 * Mapa de zonas (MUELA-024, tanda 34): el dibujo de cada edificio y planta (`resources.floor_plans`) y, encima, la capa
 * de estancias con su forma (`resources.spaces.plan_shape`, puntos 0..1 relativos a la imagen). Cada app pone su capa
 * (`layer`): color, estado en palabras y, en las camas, libre, ocupada, elegida o no se puede.
 *
 * ```ts
 * const source = createSyncSpaceSource(resources);
 * const map = createSpaceMap({
 *   source, plans: source.plans, planUrl: (fileId) => `/api/v1/resources/files/${fileId}`,
 *   layer: (space) => (space.kind === 'cama' ? { state: bedState(space) } : null),
 *   onPick: (space) => openRoomSheet(space),
 * });
 * ```
 *
 * - El dibujo va como `<image>` dentro de un SVG con `viewBox` = `width` × `height`: entero, sin zoom ni arrastre
 *   (VG), pequeño en el móvil. El SVG subido nunca se mete en la página, así que no ejecuta nada.
 * - Tocar una estancia (o pulsar Intro o Espacio sobre ella) resalta su contorno exacto y llama a `onPick`: la app
 *   abre su ficha.
 * - **Lista equivalente siempre**, con la ruta de cada espacio (`spacePath`): conmutador Plano/Lista en el móvil, y al
 *   lado en el ordenador. Sin dibujo o sin formas, solo la lista.
 * - El estado va siempre en texto (en el plano, en la lista y en el nombre accesible), no solo en el color. La cama
 *   ocupada lleva rayado además del azul.
 * - Sin red se ve la última copia (lo que tenga la fuente y el dibujo que ya cargó) con un aviso; la app decide qué no
 *   deja hacer (`onPick` recibe `offline`).
 * - **La elegida ampliada** (`focus`, MUELA-056): el mismo dibujo recortado a un espacio (la habitación elegida), con
 *   su contorno y lo de dentro encima (las camas con su número y su color), y la lista de solo eso. Sin forma, la lista.
 * - «Colocar» (Central) irá sobre esta pieza: `onShape` y `setShape` dejan preparada la forma, sin pantalla todavía.
 * Prefijo de clases: `map-`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { ancestorsOf, indexSpaces, spacePath, type SpaceRow, type SpaceSource } from './model.ts';

/** Dibujo de un edificio y planta (`resources.floor_plans`). */
export interface FloorPlan {
  id: string;
  /** El edificio (un espacio). */
  buildingId: string;
  /** «Planta baja». */
  floor: string | null;
  position: number;
  /** Archivo del dibujo (SVG, PNG o JPG); sin él, la capa sobre papel. */
  fileId: string | null;
  /** Unidades de la imagen: fijan el `viewBox` y la proporción. */
  width: number;
  height: number;
  notes?: string | null;
}

/** Forma de un espacio en su dibujo: puntos `[x, y]` entre 0 y 1, relativos a la imagen. */
export interface PlanShape {
  points: Array<[number, number]>;
}

export interface FloorPlanSource {
  list(): FloorPlan[] | Promise<FloorPlan[]>;
  subscribe?(listener: (plans: FloorPlan[]) => void): () => void;
}

/** Color de una estancia según la capa de la app (con `label` en palabras: el color nunca va solo). */
export type SpaceMapTone = 'accent' | 'ok' | 'warn' | 'alert' | 'muted';
/** Camas (VG): gris si no se puede, azul con rayado si está ocupada, verde claro libre, verde intenso elegida. */
export type SpaceMapBedState = 'off' | 'occupied' | 'free' | 'picked';

export interface SpaceMapLayer {
  tone?: SpaceMapTone | null;
  /** Estado en palabras («2 tareas abiertas, 1 vencida»): lista y nombre accesible. En las camas, por defecto el de `state`. */
  label?: string | null;
  /** Lo que se pinta en el dibujo, corto («2»); sin él, `label`. El lector de pantalla y la lista dicen `label`. */
  short?: string | null;
  /** Solo camas. */
  state?: SpaceMapBedState | null;
  /** Se ve, apagado, pero no se toca (y en la lista sale desactivado). */
  disabled?: boolean;
}

export interface SpaceMapPickContext {
  from: 'map' | 'list';
  offline: boolean;
}

export interface SpaceMapOptions {
  source: SpaceSource;
  /** Dibujos: una lista o una fuente (`createSyncSpaceSource(...).plans`). */
  plans?: FloorPlan[] | FloorPlanSource;
  /** Formas propias por id de espacio; por defecto, `planId` y `planShape` de cada fila. */
  shapes?: Record<string, { planId: string; shape: PlanShape }>;
  /** Qué espacios son de este uso (p. ej. solo las salas). Los demás con forma salen apagados y sin tocar, y no van a la lista. */
  filter?: (space: SpaceRow) => boolean;
  /** La capa de la app para cada espacio. */
  layer?: (space: SpaceRow) => SpaceMapLayer | null | undefined;
  onPick?: (space: SpaceRow, context: SpaceMapPickContext) => void;
  /** `both` (por defecto): conmutador en el móvil y lado a lado en el ordenador. `map`: el plano primero y la lista con el conmutador. `list`: solo la lista. */
  /**
   * `plan` (solo plano): sin lista ni conmutador propios, para la app que ya enseña su lista equivalente (Tasks, su
   * árbol). **La app tiene que poner esa lista**: el plano solo no basta. Sin dibujo, la pieza enseña su lista igualmente.
   */
  mode?: 'map' | 'list' | 'both' | 'plan';
  /** `all`: todos los dibujos a la vez (dos por fila en el ordenador, uno en el móvil). Por defecto `switch`, el selector. */
  layout?: 'switch' | 'all';
  /** URL del dibujo (`/api/v1/resources/files/:id`); puede ser una promesa (p. ej. un `blob:` con el token). */
  planUrl?: (fileId: string) => string | Promise<string>;
  /** Nombre que se pinta; por defecto `name` (en los portales, `publicName ?? name`). */
  nameOf?: (space: SpaceRow) => string;
  /** Espacio resaltado al empezar. */
  selected?: string | null;
  /**
   * La elegida ampliada (MUELA-056): solo este espacio y lo de dentro, con el dibujo recortado a su forma. Sin forma,
   * la lista de lo mismo. `setFocus` lo cambia.
   */
  focus?: string | null;
  /**
   * `false` (Guests, MUELA-056): camas solo por color, sin el número pintado en el plano ni en la lista. El nombre
   * accesible («Cama 1, Hab 3 · Libre») y el estado en palabras se quedan; la leyenda dice qué es cada color.
   */
  bedNumbers?: boolean;
  /** Nombre accesible de la pieza. */
  label?: string;
  /** Base de las marcas de feedback y uso (`SPACE_MAP_MARKS`). */
  feedbackId?: string;
  /** Sin red; por defecto sigue a `navigator.onLine`. */
  offline?: boolean;
  /** Preparado para «Colocar» (Central): avisa cuando cambia una forma con `setShape`. Sin pantalla todavía. */
  onShape?: (space: SpaceRow, planId: string, shape: PlanShape) => void;
}

export interface SpaceMap {
  element: HTMLElement;
  refresh(): Promise<void>;
  /** Resalta un espacio (y cambia de dibujo si hace falta); `null` quita el resalte. No llama a `onPick`. */
  select(id: string | null): void;
  /** La elegida ampliada: recorta a este espacio; `null` vuelve al plano entero. */
  setFocus(id: string | null): void;
  /** Repinta con la capa de nuevo (cuando cambian los datos de la app). */
  repaint(): void;
  setOffline(offline: boolean): void;
  /** Cambia la forma de un espacio en local y avisa con `onShape` (base de «Colocar»). */
  setShape(id: string, planId: string, shape: PlanShape): void;
  destroy(): void;
}

/** Sufijos y etiquetas de las marcas (los lee también el catálogo, `feature-catalog.mjs`). */
export const SPACE_MAP_MARKS = {
  view: ['vista', 'Plano o lista'],
  plan: ['dibujo', 'Elegir dibujo'],
  space: ['espacio', 'Espacio en el plano'],
  row: ['fila', 'Espacio en la lista'],
} as const;

const NS = 'http://www.w3.org/2000/svg';
const BED_TEXT: Record<SpaceMapBedState, string> = { off: 'No se puede elegir', occupied: 'Ocupada', free: 'Libre', picked: 'Elegida' };
const BED_ORDER: SpaceMapBedState[] = ['free', 'occupied', 'picked', 'off'];
let uid = 0;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | null | undefined> = {}, ...children: Array<Node | string | null>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  for (const c of children) if (c !== null) node.append(c);
  return node;
}

/** Forma válida: de 3 a 200 puntos entre 0 y 1. */
export function validShape(shape: unknown): shape is PlanShape {
  const pts = (shape as PlanShape | null)?.points;
  return Array.isArray(pts) && pts.length >= 3 && pts.length <= 200
    && pts.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1));
}

/** Centro de la forma (centroide del polígono; si es degenerado, el del rectángulo que la contiene), en unidades 0..1. */
export function shapeCenter(shape: PlanShape): { x: number; y: number; w: number; h: number } {
  const xs = shape.points.map((p) => p[0]);
  const ys = shape.points.map((p) => p[1]);
  const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  let a = 0; let cx = 0; let cy = 0;
  shape.points.forEach(([x0, y0], i) => {
    const [x1, y1] = shape.points[(i + 1) % shape.points.length]!;
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  });
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (Math.abs(a) < 1e-9) return { x: box.minX + w / 2, y: box.minY + h / 2, w, h };
  return { x: cx / (3 * a), y: cy / (3 * a), w, h };
}

/** Número de la cama: su código, el número de su nombre («Cama 3» → 3) o su orden entre las camas de la habitación. */
function bedNumber(bed: SpaceRow, rows: readonly SpaceRow[]): string {
  if (bed.code) return bed.code;
  const n = /(\d+)\s*$/.exec(bed.name)?.[1];
  if (n) return n;
  const siblings = rows.filter((r) => r.parentId === bed.parentId && r.kind === 'cama' && r.active).sort((a, b) => a.position - b.position);
  return String(siblings.findIndex((r) => r.id === bed.id) + 1);
}

export function createSpaceMap(options: SpaceMapOptions): SpaceMap {
  const id = `map-${++uid}`;
  const base = options.feedbackId;
  const mark = (key: keyof typeof SPACE_MAP_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${SPACE_MAP_MARKS[key][0]}`, 'data-feedback-label': SPACE_MAP_MARKS[key][1] } : {});
  const nameOf = options.nameOf ?? ((s: SpaceRow) => s.name);
  const mode = options.mode ?? 'both';
  const autoOnline = options.offline === undefined;
  let offline = options.offline ?? (typeof navigator !== 'undefined' && navigator.onLine === false);

  let rows: SpaceRow[] = [];
  let plans: FloorPlan[] = Array.isArray(options.plans) ? options.plans.slice() : [];
  const localShapes = new Map<string, { planId: string; shape: PlanShape }>(Object.entries(options.shapes ?? {}));
  let selected: string | null = options.selected ?? null;
  let planId: string | null = null;
  let follow = !!selected;
  let focus: string | null = options.focus ?? null;
  /** Lo que eligió la persona; sin dibujo, se ve la lista igualmente (y al llegar el dibujo, vuelve a lo elegido). */
  let wanted: 'plan' | 'list' = mode === 'list' ? 'list' : 'plan';
  let view: 'plan' | 'list' = wanted;
  const urls = new Map<string, Promise<string>>();
  /** Píxeles de pantalla por unidad de cada dibujo: los rótulos no bajan de 11 px aunque el plano se vea pequeño. */
  const scales = new Map<string, number>();
  const failed = new Set<string>();

  const head = el('div', { class: 'map-head' });
  const notice = el('p', { class: 'map-offline', role: 'status', hidden: true });
  const stage = el('div', { class: 'map-stage' });
  const legend = el('ul', { class: 'map-legend', 'aria-label': kt('Leyenda') });
  const planBox = el('div', { class: 'map-plan' }, stage, legend);
  const list = el('div', { class: 'map-list' });
  const body = el('div', { class: 'map-body' }, planBox, list);
  const element = el('section', {
    class: `map-box map-mode-${mode}`, 'aria-label': options.label ?? kt('Mapa de zonas'), dataset: { view },
    ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label ?? kt('Mapa de zonas') } : {}),
  }, head, notice, body);

  // --- Datos -------------------------------------------------------------------------------------------------
  const shapeOf = (s: SpaceRow): { planId: string; shape: PlanShape } | null => {
    const own = localShapes.get(s.id);
    if (own && validShape(own.shape)) return own;
    return s.planId && validShape(s.planShape) ? { planId: s.planId, shape: s.planShape } : null;
  };
  const inUse = (s: SpaceRow) => s.active && (!options.filter || options.filter(s));
  const layerOf = (s: SpaceRow): SpaceMapLayer => options.layer?.(s) ?? {};
  /** Lo que se dice de un espacio: el texto de la capa; en las camas, su estado; en una habitación con camas, cuántas libres. */
  function stateText(s: SpaceRow, layer: SpaceMapLayer): string | null {
    if (layer.label) return layer.label;
    if (layer.state) return kt(BED_TEXT[layer.state]);
    // Estado de plazas solo si la habitación tiene camas con estado (adenda 1: el salón sin camas no lleva «Completa»).
    const beds = rows.filter((r) => r.parentId === s.id && r.kind === 'cama' && inUse(r)).map((r) => layerOf(r).state).filter(Boolean);
    if (!beds.length) return null;
    const free = beds.filter((b) => b === 'free').length;
    if (free) return free === 1 ? kt('1 libre') : kt('{n} libres', { n: String(free) });
    return beds.some((b) => b === 'picked') ? null : kt('Completa');
  }
  const accessibleName = (s: SpaceRow, layer: SpaceMapLayer) => {
    const text = stateText(s, layer);
    const name = s.kind === 'cama' ? kt('Cama {n}', { n: bedNumber(s, rows) }) : nameOf(s);
    const room = s.kind === 'cama' && s.parentId ? rows.find((r) => r.id === s.parentId) : null;
    return [room ? `${name}, ${nameOf(room)}` : name, text].filter(Boolean).join(' · ');
  };
  /** Dibujos con alguna forma de este uso, en su orden. */
  const usefulPlans = () => plans.filter((p) => rows.some((s) => inUse(s) && shapeOf(s)?.planId === p.id)).sort((a, b) => a.position - b.position);
  const planName = (p: FloorPlan) => {
    const building = rows.find((r) => r.id === p.buildingId);
    return [building ? nameOf(building) : null, p.floor].filter(Boolean).join(' · ') || kt('Plano');
  };

  async function refresh(): Promise<void> {
    rows = await options.source.list();
    if (options.plans && !Array.isArray(options.plans)) plans = await options.plans.list();
    paint();
  }
  const offRows = options.source.subscribe((next) => { rows = next; paint(); });
  const offPlans = options.plans && !Array.isArray(options.plans) ? options.plans.subscribe?.((next) => { plans = next; paint(); }) : undefined;
  const onNet = () => { if (autoOnline) setOffline(navigator.onLine === false); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  function pick(s: SpaceRow, from: 'map' | 'list'): void {
    selected = s.id;
    paint();
    options.onPick?.(s, { from, offline });
    // El foco sigue en lo que se ha tocado (repintar lo sustituye).
    const again = from === 'map' ? stage.querySelector<SVGElement>(`[data-space-id="${CSS.escape(s.id)}"].map-shape`) : list.querySelector<HTMLElement>(`[data-space-id="${CSS.escape(s.id)}"]`);
    again?.focus({ preventScroll: true });
  }

  // --- Pintar ------------------------------------------------------------------------------------------------
  function paintHead(hasPlan: boolean, useful: FloorPlan[]): void {
    const toggle = hasPlan && mode !== 'list' && mode !== 'plan'
      ? el('div', { class: 'segmented map-view', role: 'group', 'aria-label': kt('Ver como') },
        ...(['plan', 'list'] as const).map((v) => el('button', {
          type: 'button', class: view === v ? 'on' : '', 'aria-pressed': String(view === v), dataset: { view: v }, ...mark('view'),
          onclick: () => { wanted = v; paint(); head.querySelector<HTMLElement>(`.map-view [data-view="${v}"]`)?.focus(); },
        }, v === 'plan' ? kt('Plano') : kt('Lista'))))
      : null;
    const chooser = hasPlan && useful.length > 1 && options.layout !== 'all'
      ? el('div', { class: 'segmented map-plans', role: 'group', 'aria-label': kt('Dibujo') },
        ...useful.map((p) => el('button', {
          type: 'button', class: p.id === planId ? 'on' : '', 'aria-pressed': String(p.id === planId), dataset: { planId: p.id }, ...mark('plan'),
          onclick: () => { planId = p.id; paint(); head.querySelector<HTMLElement>(`.map-plans [data-plan-id="${CSS.escape(p.id)}"]`)?.focus(); },
        }, planName(p))))
      : null;
    replace(head, toggle, chooser);
    head.hidden = !toggle && !chooser;
  }

  /** El espacio y lo de dentro (la elegida ampliada). */
  const within = (root: SpaceRow, index: Map<string, SpaceRow>) => (s: SpaceRow) => s.id === root.id || ancestorsOf(index, s.id).some((a) => a.id === root.id);

  function paintPlan(plan: FloorPlan, crop: SpaceRow | null = null): { nodes: Array<Element | null>; states: Set<SpaceMapBedState> } {
    const w = plan.width > 0 ? plan.width : 1000;
    const h = plan.height > 0 ? plan.height : 700;
    const key = crop ? `${plan.id}:${crop.id}` : plan.id;
    const hatch = `${id}-hatch-${plans.indexOf(plan)}`;
    // Recorte: la caja de la forma con un margen, sin salir de la imagen.
    let box = { x: 0, y: 0, w, h };
    if (crop) {
      const pts = shapeOf(crop)!.shape.points;
      const xs = pts.map((q) => q[0] * w);
      const ys = pts.map((q) => q[1] * h);
      const pad = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.06;
      const x0 = Math.max(0, Math.min(...xs) - pad);
      const y0 = Math.max(0, Math.min(...ys) - pad);
      box = { x: x0, y: y0, w: Math.min(w, Math.max(...xs) + pad) - x0, h: Math.min(h, Math.max(...ys) + pad) - y0 };
    }
    const unit = Math.max(box.w, box.h);
    const scale = scales.get(key) ?? 0;
    const px = (n: number) => (scale > 0 ? n / scale : 0);
    const name = crop ? kt('{name} en el plano', { name: nameOf(crop) }) : kt('Plano de {name}', { name: planName(plan) });
    const root = svg('svg', { class: `map-svg${crop ? ' map-zoom' : ''}`, viewBox: [box.x, box.y, box.w, box.h].map((n) => +n.toFixed(1)).join(' '), preserveAspectRatio: 'xMidYMid meet', role: 'group', 'aria-label': name, 'data-key': key },
      svg('defs', {}, svg('pattern', { id: hatch, patternUnits: 'userSpaceOnUse', width: unit / 90, height: unit / 90, patternTransform: 'rotate(45)' },
        svg('rect', { class: 'map-hatch-line', width: unit / 270, height: unit / 90 }))),
      svg('rect', { class: 'map-paper', width: w, height: h }));
    if (plan.fileId && !failed.has(plan.fileId) && options.planUrl) {
      const image = svg('image', { class: 'map-bg', width: w, height: h, preserveAspectRatio: 'none' });
      const fileId = plan.fileId;
      let url = urls.get(fileId);
      if (!url) { url = Promise.resolve(options.planUrl(fileId)); urls.set(fileId, url); }
      void url.then((u) => image.setAttribute('href', u), () => { failed.add(fileId); paint(); });
      image.addEventListener('error', () => { failed.add(fileId); urls.delete(fileId); paint(); }, { once: true });
      root.append(image);
    }
    const shapesLayer = svg('g', { class: 'map-shapes' });
    const labels = svg('g', { class: 'map-labels', 'aria-hidden': 'true' });
    const ring = svg('g', { class: 'map-rings', 'aria-hidden': 'true' });
    // Primero las estancias y encima lo que va dentro (camas): por profundidad en el árbol.
    const index = indexSpaces(rows);
    const inCrop = crop ? within(crop, index) : () => true;
    const here = rows.filter((s) => s.active && shapeOf(s)?.planId === plan.id && inCrop(s))
      .map((s) => ({ s, depth: ancestorsOf(index, s.id).length }))
      .sort((a, b) => a.depth - b.depth || a.s.position - b.s.position);
    for (const { s } of here) {
      const shape = shapeOf(s)!.shape;
      const points = shape.points.map(([x, y]) => `${(x * w).toFixed(1)},${(y * h).toFixed(1)}`).join(' ');
      const use = inUse(s);
      const layer = use ? layerOf(s) : {};
      const off = !use || !!layer.disabled;
      const bed = s.kind === 'cama';
      const cls = ['map-shape', bed ? 'map-bed' : 'map-room', crop?.id === s.id ? 'map-focus' : '', off ? 'map-off' : '', layer.tone ? `map-tone-${layer.tone}` : '', layer.state ? `map-st-${layer.state}` : '', selected === s.id ? 'map-on' : ''].filter(Boolean).join(' ');
      const poly = svg('polygon', {
        class: cls, points, 'data-space-id': s.id,
        ...(off ? { 'aria-hidden': 'true' } : { role: 'button', tabindex: 0, 'aria-label': accessibleName(s, layer), 'aria-pressed': String(selected === s.id), ...mark('space') }),
      });
      if (!off) {
        poly.addEventListener('click', () => pick(s, 'map'));
        poly.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s, 'map'); } });
      }
      shapesLayer.append(poly);
      if (bed && layer.state === 'occupied') shapesLayer.append(svg('polygon', { class: 'map-hatch', points, fill: `url(#${hatch})`, 'aria-hidden': 'true' }));
      if (selected === s.id) ring.append(svg('polygon', { class: 'map-ring', points }));
      // Rótulo: nombre y estado; en las camas, su número.
      const c = shapeCenter(shape);
      const bw = c.w * w;
      const bh = c.h * h;
      if (bed) {
        const size = Math.max(Math.min(bw * 0.5, bh * 0.5, unit * (crop ? 0.08 : 0.034)), unit * 0.008, px(crop ? 16 : 11));
        // Una cama fuera de este uso (filtro) se ve apagada y sin número.
        if (options.bedNumbers !== false && use) labels.append(svg('text', { class: `map-bed-txt${layer.state ? ` map-st-${layer.state}` : ''}`, x: c.x * w, y: c.y * h, 'font-size': size.toFixed(1), 'dominant-baseline': 'central' }, bedNumber(s, rows)));
        continue;
      }
      if (off && !use) continue;
      const name = nameOf(s);
      // En el dibujo, lo corto si la app lo da («2»); la frase entera va al lector de pantalla y a la lista.
      const text = layer.short ?? stateText(s, layer);
      const size = Math.max(Math.min(bw / Math.max(name.length * 0.62, 1), bh / (text ? 3.2 : 2.2), unit * 0.03), unit * 0.012, px(12));
      // Si dentro hay camas dibujadas, el rótulo va abajo para no taparlas.
      const bedsInside = here.some(({ s: b }) => b.parentId === s.id && b.kind === 'cama');
      const bottom = Math.max(...shape.points.map((p) => p[1])) * h;
      const y = bedsInside ? bottom - size * (text ? 2.1 : 1) : c.y * h - (text ? size * 0.55 : 0);
      labels.append(svg('text', { class: 'map-room-txt', x: c.x * w, y, 'font-size': size.toFixed(1), 'dominant-baseline': 'central' }, name));
      if (text && layer.short) labels.append(svg('text', { class: 'map-room-short', x: c.x * w, y: y + size * 1.3, 'font-size': Math.max(size * 1.15, px(15)).toFixed(1), 'dominant-baseline': 'central' }, text));
      else if (text) labels.append(svg('text', { class: 'map-room-state', x: c.x * w, y: y + size * 1.15, 'font-size': Math.max(size * 0.82, px(11)).toFixed(1), 'dominant-baseline': 'central' }, text));
    }
    root.append(shapesLayer, ring, labels);
    const missing = plan.fileId && failed.has(plan.fileId) ? el('p', { class: 'hint map-nobg' }, kt('No se ha podido cargar el dibujo: las estancias siguen en su sitio y en la lista.')) : null;
    const states = new Set(here.filter(({ s }) => s.kind === 'cama' && inUse(s)).map(({ s }) => layerOf(s).state).filter(Boolean) as SpaceMapBedState[]);
    return { nodes: [root, missing], states };
  }

  /** Pinta uno o varios dibujos y la leyenda de las camas (solo los estados que hay). */
  function paintStage(drawn: Array<{ plan: FloorPlan; crop?: SpaceRow | null }>): void {
    const states = new Set<SpaceMapBedState>();
    const all = drawn.length > 1 || options.layout === 'all';
    const parts = drawn.map(({ plan, crop }) => {
      const out = paintPlan(plan, crop ?? null);
      out.states.forEach((s) => states.add(s));
      return all ? el('figure', { class: 'map-figure' }, el('figcaption', { class: 'map-figcap' }, planName(plan)), ...out.nodes) : out.nodes;
    });
    stage.classList.toggle('map-all', all);
    replace(stage, ...parts.flat());
    replace(legend, ...BED_ORDER.filter((st) => states.has(st)).map((st) => el('li', null, el('span', { class: 'map-seat', dataset: { state: st }, 'aria-hidden': 'true' }), kt(BED_TEXT[st]))));
    legend.hidden = !states.size;
  }

  /** Alturas y edificios (y exteriores con algo dentro) son títulos de la lista, no filas. */
  const container = (s: SpaceRow) => s.kind === 'altura' || s.kind === 'edificio' || (s.kind === 'exterior' && rows.some((r) => r.parentId === s.id && r.active));

  function paintList(plan: FloorPlan | null, crop: SpaceRow | null = null): void {
    const hasPlan = !!plan;
    const index = indexSpaces(rows);
    // Con dibujo, la lista es su equivalente: lo de ese edificio (con forma o sin ella); ampliada, lo de ese espacio.
    const inside = crop ? within(crop, index) : (s: SpaceRow) => !plan || s.id === plan.buildingId || ancestorsOf(index, s.id).some((a) => a.id === plan.buildingId);
    const shown = rows.filter((s) => inUse(s) && !container(s) && inside(s));
    // En el orden del árbol: cada edificio (o la raíz más alta) con lo suyo debajo.
    const ordered: SpaceRow[] = [];
    const walk = (parentId: string | null) => {
      for (const s of rows.filter((r) => r.parentId === parentId && r.active).sort((a, b) => a.position - b.position)) {
        if (shown.includes(s)) ordered.push(s);
        walk(s.id);
      }
    };
    walk(null);
    if (!ordered.length) { replace(list, el('p', { class: 'hint map-empty' }, kt('No hay espacios que enseñar.'))); return; }
    const groups = new Map<string, SpaceRow[]>();
    for (const s of ordered) {
      const chain = ancestorsOf(index, s.id);
      const top = chain.find((a) => a.kind === 'edificio' || a.kind === 'exterior') ?? chain[chain.length - 1] ?? null;
      const key = top ? spacePath(index, top.id) : '';
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const row = (s: SpaceRow) => {
      const layer = layerOf(s);
      const text = stateText(s, layer);
      const bed = s.kind === 'cama';
      const parent = s.parentId ? spacePath(index, s.parentId) : '';
      const unplaced = hasPlan && !shapeOf(s);
      return el('li', { class: `map-item${bed ? ' map-item-bed' : ''}` },
        el('button', {
          type: 'button', class: `map-row${layer.tone ? ` map-tone-${layer.tone}` : ''}`, dataset: { spaceId: s.id, ...(layer.state ? { state: layer.state } : {}) },
          'aria-current': selected === s.id ? 'true' : null, disabled: layer.disabled ? true : null, 'aria-label': `${accessibleName(s, layer)}${parent ? ` · ${parent}` : ''}`, ...mark('row'),
          onclick: () => pick(s, 'list'),
        },
        bed ? el('span', { class: 'map-seat', dataset: { state: layer.state ?? 'none' }, 'aria-hidden': 'true' }, options.bedNumbers === false ? null : bedNumber(s, rows)) : null,
        el('span', { class: 'map-row-main' },
          el('strong', { class: 'map-row-name' }, bed ? kt('Cama {n}', { n: bedNumber(s, rows) }) : nameOf(s)),
          el('span', { class: 'map-row-path' }, [parent, unplaced ? kt('Sin sitio en el plano') : null].filter(Boolean).join(' · '))),
        text ? el('span', { class: 'map-row-state' }, text) : null));
    };
    replace(list, ...[...groups].map(([title, items]) => el('section', { class: 'map-group' },
      title ? el('h3', { class: 'map-group-title' }, title) : null,
      el('ul', { class: 'map-items' }, ...items.map(row)))));
  }

  function paint(): void {
    // La elegida ampliada: su dibujo recortado, o la lista si no tiene forma.
    const crop = focus ? rows.find((r) => r.id === focus) ?? null : null;
    if (focus) {
      const at = crop ? shapeOf(crop) : null;
      const plan = mode !== 'list' && at ? plans.find((p) => p.id === at.planId) ?? null : null;
      view = plan ? wanted : 'list';
      element.dataset.view = view;
      element.dataset.focus = focus;
      element.classList.toggle('map-noplan', !plan);
      paintHead(!!plan, []);
      if (plan && crop) paintStage([{ plan, crop }]); else { replace(stage); replace(legend); }
      planBox.hidden = !plan;
      if (crop) paintList(plan, crop); else replace(list, el('p', { class: 'hint map-empty' }, kt('No hay espacios que enseñar.')));
      if (!plan && crop && mode !== 'list') list.prepend(el('p', { class: 'hint map-why' }, kt('Sin sitio en el plano: lo de dentro, en lista.')));
      notice.hidden = !offline;
      replace(notice, offline ? kt('Sin red: ves la última copia guardada.') : '');
      element.dataset.offline = String(offline);
      return;
    }
    delete element.dataset.focus;
    const useful = mode === 'list' ? [] : usefulPlans();
    // Al empezar (o tras `select`), el dibujo de lo elegido; después manda el conmutador.
    if (follow && selected) {
      const where = rows.find((r) => r.id === selected);
      const at = where ? shapeOf(where)?.planId : null;
      if (at && useful.some((p) => p.id === at)) { planId = at; follow = false; }
    }
    if (!useful.some((p) => p.id === planId)) planId = useful[0]?.id ?? null;
    const plan = useful.find((p) => p.id === planId) ?? null;
    const hasPlan = !!plan;
    view = hasPlan ? wanted : 'list';
    element.dataset.view = view;
    element.classList.toggle('map-noplan', !hasPlan);
    paintHead(hasPlan, useful);
    if (plan) paintStage(options.layout === 'all' ? useful.map((p) => ({ plan: p })) : [{ plan }]); else { replace(stage); replace(legend); }
    planBox.hidden = !hasPlan;
    // Con todos los dibujos, la lista es la de todos.
    paintList(options.layout === 'all' ? null : plan);
    const why = !hasPlan && mode !== 'list' ? kt('Sin plano todavía: la misma información en lista, con la ruta de cada espacio.') : null;
    const intro = list.querySelector('.map-why');
    if (why && !intro) list.prepend(el('p', { class: 'hint map-why' }, why));
    notice.hidden = !offline;
    replace(notice, offline ? kt('Sin red: ves la última copia guardada.') : '');
    element.dataset.offline = String(offline);
  }

  function setOffline(next: boolean): void {
    if (next === offline) return;
    offline = next;
    paint();
  }

  // Al cambiar el ancho (girar el móvil, abrir la columna), se recalculan los rótulos.
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    let changed = false;
    for (const svgNode of stage.querySelectorAll<SVGSVGElement>('.map-svg')) {
      const vb = svgNode.viewBox.baseVal;
      const key = svgNode.getAttribute('data-key');
      if (!vb?.width || !key) continue;
      const next = svgNode.getBoundingClientRect().width / vb.width;
      const before = scales.get(key) ?? 0;
      if (next > 0 && Math.abs(next - before) / next > 0.08) { scales.set(key, next); changed = true; }
    }
    if (changed) paint();
  }) : null;
  resize?.observe(stage);

  paint();
  void refresh();

  return {
    element,
    refresh,
    select(next) { selected = next; follow = !!next; paint(); },
    setFocus(next) { focus = next; paint(); },
    repaint: paint,
    setOffline,
    setShape(spaceId, plan, shape) {
      if (!validShape(shape)) return;
      localShapes.set(spaceId, { planId: plan, shape });
      paint();
      const s = rows.find((r) => r.id === spaceId);
      if (s) options.onShape?.(s, plan, shape);
    },
    destroy() {
      offRows();
      offPlans?.();
      resize?.disconnect();
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
      element.remove();
    },
  };
}
