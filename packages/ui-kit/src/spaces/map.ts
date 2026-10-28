/**
 * Mapa de zonas (MUELA-024, tanda 34): el dibujo de cada edificio y planta (`resources.floor_plans`) y, encima, la capa
 * de estancias con su forma (`resources.spaces.plan_shape`, puntos 0..1 relativos a la imagen). Cada app pone su capa
 * (`layer`): color, estado en palabras y, en las camas, libre, ocupada, elegida o no se puede.
 *
 * ```ts
 * const source = createSyncSpaceSource(resources);
 * const map = createSpaceMap({
 *   // `planUrl` da el enlace firmado del archivo (`client.fileUrl`), no la ruta de la API: esa devuelve JSON `{ url }`.
 *   source, plans: source.plans, planUrl: (fileId) => client.fileUrl(fileId),
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
 * - **Retícula y decoración** (0.63, DECORACION_Y_FINCA): `grid` dibuja la retícula de 5 m, 1 m o 0,5 m del dibujo
 *   (`FloorPlan.grid`); `decor` pinta los objetos encima de las estancias (`showDecor: false` los quita en la vista). Con
 *   `decorEdit` (Central, ordenador) se ponen, se arrastran por celdas, se giran y se quitan (`onDecorChange`). Sin
 *   `decorEdit`, la decoración solo se ve. `bedIcons` dibuja cada cama con el icono de su `bed_kind`; `bands`, las
 *   alturas de la finca.
 * - **Bajar de la finca a la habitación** (`drill`): tocar un edificio entra en su dibujo (`onEnterBuilding`) y tocar
 *   una habitación con cosas dentro la amplía. Una miga («Finca › Albergue › Hab 1») y «Volver» suben. Sin zoom libre:
 *   se cambia de dibujo.
 * Prefijo de clases: `map-`.
 */
import { el, replace } from '../dom.ts';
import { NOT_A_FIELD } from '../fields/field-mark.ts';
import { kt } from '../i18n/i18n.ts';
import { ancestorsOf, indexSpaces, spacePath, type SpaceRow, type SpaceSource } from './model.ts';
import { GRID_SCALES, beaconText, bedKindOf, bedSymbols, cellSize, decorBox, relToCell, safeIconUrl, validGrid, type DecorChange, type DecorIcon, type DecorItem, type GridScale, type PlanGrid } from './decor.ts';

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
  /** Escala del dibujo para la retícula y la decoración (lo da Recursos). */
  grid?: PlanGrid | null;
  /** Bandas horizontales con nombre (las alturas de la finca); `bands` en las opciones manda. */
  bands?: PlanBand[] | null;
  /** Etiquetas de las curvas de nivel (la curva va en el dibujo); `contours` en las opciones manda. */
  contours?: PlanContour[] | null;
}

/** Cota de una curva de nivel del dibujo: dónde va su etiqueta (0..1) y su altura en metros. */
export interface PlanContour {
  spaceId?: string | null;
  label: string;
  elevationM: number;
  x: number;
  y: number;
}

/** Banda horizontal del dibujo (las alturas de la finca), con `y` relativa (0..1). */
export interface PlanBand {
  name: string;
  y0: number;
  y1: number;
}

/** Tramo de la miga de `drill`. */
export interface SpaceMapStep {
  planId: string;
  /** Habitación ampliada en ese tramo, si la hay. */
  focus: string | null;
  name: string;
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
  /**
   * URL del dibujo, la que se puede pintar: el enlace firmado (`client.fileUrl(fileId)`, que lo pide a
   * `/api/v1/resources/files/:id`) o un `blob:`. No la ruta de la API, que responde JSON `{ url }` y el dibujo no carga.
   */
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
  /** Separador entre el nombre y el estado en el nombre accesible; por defecto « · » (Tasks: «: », «Hab 3: 2 tareas abiertas»). */
  labelJoin?: string;
  /** Nombre accesible de la pieza. */
  label?: string;
  /** Base de las marcas de feedback y uso (`SPACE_MAP_MARKS`). */
  feedbackId?: string;
  /** Sin red; por defecto sigue a `navigator.onLine`. */
  offline?: boolean;
  /** Preparado para «Colocar» (Central): avisa cuando cambia una forma con `setShape`. Sin pantalla todavía. */
  onShape?: (space: SpaceRow, planId: string, shape: PlanShape) => void;
  /** Retícula fina de esa escala en los dibujos que la tienen (`FloorPlan.grid`). Por defecto, sin retícula (con `decorEdit`, la de la herramienta). */
  grid?: GridScale | false;
  /** Objetos de decoración de los dibujos. */
  decor?: DecorItem[];
  /** `false` quita la decoración en esta vista (p. ej. al ordenar camas). Por defecto, con decoración. */
  showDecor?: boolean;
  /** Colocar decoración (Central, ordenador): iconos que se pueden poner y aviso de cada cambio. Sin esto, la decoración solo se ve. */
  decorEdit?: {
    icons: DecorIcon[]; onDecorChange: (change: DecorChange) => void; scale?: GridScale;
    /** «Subir imagen» en la paleta: la app la sube y devuelve su URL. Sin esto, solo iconos y «Texto». */
    onUpload?: (file: File) => Promise<{ url: string; fileId?: string | null }>;
  };
  /** Camas con el icono de su `attributes.bed_kind` (individual, doble, litera, sofá cama), además del color y el estado. */
  bedIcons?: boolean;
  /** Bandas horizontales con nombre (las alturas de la finca); por defecto, `plan.bands`. */
  bands?: (plan: FloorPlan) => PlanBand[] | null | undefined;
  /** Etiquetas de las curvas de nivel («Altura 3 · 12 m», «+6 m» hasta la siguiente); por defecto, `plan.contours`. */
  contours?: (plan: FloorPlan) => PlanContour[] | null | undefined;
  /** Bajar de la finca al edificio y a la habitación tocando (con miga y «Volver»). */
  drill?: boolean;
  /** Dibujo con el que empieza (p. ej. el de la finca). */
  plan?: string | null;
  /** Con `drill`: se ha entrado en un edificio. */
  onEnterBuilding?: (building: SpaceRow, plan: FloorPlan) => void;
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
  /** Cambia los objetos de decoración (lo del servidor), sin avisar. */
  setDecor(items: DecorItem[]): void;
  /** Va a un dibujo (con `drill`, como raíz de la miga). */
  setPlan(planId: string): void;
  /** Con `drill`: la miga, de la raíz a donde se está. */
  path(): SpaceMapStep[];
  destroy(): void;
}

/** Sufijos y etiquetas de las marcas (los lee también el catálogo, `feature-catalog.mjs`). */
export const SPACE_MAP_MARKS = {
  view: ['vista', 'Plano o lista'],
  plan: ['dibujo', 'Elegir dibujo'],
  space: ['espacio', 'Espacio en el plano'],
  row: ['fila', 'Espacio en la lista'],
  crumb: ['miga', 'Miga del plano'],
  back: ['volver', 'Volver'],
  icon: ['deco-icono', 'Icono de decoración'],
  size: ['deco-tamano', 'Tamaño del objeto'],
  scale: ['deco-escala', 'Escala de la retícula'],
  item: ['deco-objeto', 'Objeto de decoración'],
  rotate: ['deco-girar', 'Girar 90°'],
  remove: ['deco-quitar', 'Quitar el objeto'],
  text: ['deco-texto', 'Baliza de texto'],
  upload: ['deco-imagen', 'Subir imagen'],
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
  /** Dibujo pedido (`plan`, `setPlan`), a la espera de que tenga algo que enseñar. */
  let wantPlan: string | null = options.plan ?? null;
  let follow = !!selected && !options.plan;
  let focus: string | null = options.focus ?? null;
  /** Lo que eligió la persona; sin dibujo, se ve la lista igualmente (y al llegar el dibujo, vuelve a lo elegido). */
  let wanted: 'plan' | 'list' = mode === 'list' ? 'list' : 'plan';
  let view: 'plan' | 'list' = wanted;
  const urls = new Map<string, Promise<string>>();
  /** Píxeles de pantalla por unidad de cada dibujo: los rótulos no bajan de 11 px aunque el plano se vea pequeño. */
  const scales = new Map<string, number>();
  const failed = new Set<string>();
  // Decoración y bajada.
  let decor: DecorItem[] = (options.decor ?? []).slice();
  const edit = options.decorEdit ?? null;
  const tool: { iconId: string | null; size: 1 | 4; scale: GridScale } = { iconId: edit?.icons[0]?.id ?? null, size: edit?.icons[0]?.size ?? 1, scale: edit?.scale ?? 1 };
  /** Baliza: texto que se pone con «Texto» (y pie de una imagen subida) y la imagen subida que se pone al tocar. */
  const TEXT_TOOL = '__texto';
  const IMAGE_TOOL = '__imagen';
  const beacon: { text: string; url: string | null; fileId: string | null; busy: boolean } = { text: '', url: null, fileId: null, busy: false };
  let decorSel: string | null = null;
  let trail: Array<{ planId: string; focus: string | null }> = [];
  let dragging = false;

  const head = el('div', { class: 'map-head' });
  const decorBar = el('div', { class: 'map-decorbar', role: 'toolbar', 'aria-label': kt('Decoración'), hidden: true });
  const notice = el('p', { class: 'map-offline', role: 'status', hidden: true });
  const stage = el('div', { class: 'map-stage' });
  const legend = el('ul', { class: 'map-legend', 'aria-label': kt('Leyenda') });
  const planBox = el('div', { class: 'map-plan' }, decorBar, stage, legend);
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
  const ownPlans = (s: SpaceRow) => plans.filter((p) => p.buildingId === s.id).sort((a, b) => a.position - b.position);
  const inUse = (s: SpaceRow) => s.active && (!options.filter || options.filter(s) || (!!options.drill && ownPlans(s).length > 0));
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
    return [room ? `${name}, ${nameOf(room)}` : name, text].filter(Boolean).join(options.labelJoin ?? ' · ');
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

  /** Con `drill`: entra en el edificio o amplía la habitación; `true` si lo ha hecho. */
  function drillInto(s: SpaceRow): boolean {
    if (!options.drill) return false;
    const current = planId;
    const own = ownPlans(s).filter((p) => p.id !== current);
    if (own.length && current) {
      trail.push({ planId: current, focus });
      planId = own[0]!.id; focus = null; selected = null; follow = false;
      paint();
      options.onEnterBuilding?.(s, own[0]!);
      head.querySelector<HTMLElement>('.map-back')?.focus();
      return true;
    }
    const at = shapeOf(s);
    const inside = s.kind !== 'cama' && focus !== s.id && !!at && rows.some((r) => r.parentId === s.id && r.active && shapeOf(r)?.planId === at.planId);
    if (inside && current) {
      trail.push({ planId: current, focus });
      focus = s.id; selected = null;
      paint();
      head.querySelector<HTMLElement>('.map-back')?.focus();
      return true;
    }
    return false;
  }

  function goBack(to?: number): void {
    if (!trail.length) return;
    const at = to ?? trail.length - 1;
    const step = trail[at]!;
    trail = trail.slice(0, at);
    planId = step.planId; focus = step.focus; selected = null;
    paint();
    (head.querySelector<HTMLElement>('.map-back') ?? stage.querySelector<HTMLElement>('.map-shape[tabindex="0"]'))?.focus();
  }

  const stepName = (step: { planId: string; focus: string | null }) => {
    const room = step.focus ? rows.find((r) => r.id === step.focus) : null;
    if (room) return nameOf(room);
    const p = plans.find((x) => x.id === step.planId);
    return p ? planName(p) : kt('Plano');
  };
  const path = (): SpaceMapStep[] => [...trail, { planId: planId ?? '', focus }].filter((s) => s.planId).map((s) => ({ ...s, name: stepName(s) }));

  function pick(s: SpaceRow, from: 'map' | 'list'): void {
    if (drillInto(s)) return;
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
    const steps = options.drill ? path() : [];
    const crumbs = options.drill && steps.length > 1
      ? el('nav', { class: 'map-crumbs', 'aria-label': kt('Dónde estás') },
        el('button', { type: 'button', class: 'ghost small map-back', ...mark('back'), onclick: () => goBack() }, kt('‹ Volver')),
        el('ol', { class: 'map-crumbs-list' }, ...steps.map((step, i) => el('li', null, i < steps.length - 1
          ? el('button', { type: 'button', class: 'linkbtn map-crumb', ...mark('crumb'), onclick: () => goBack(i) }, step.name)
          : el('span', { class: 'map-crumb-here', 'aria-current': 'location' }, step.name)))))
      : null;
    replace(head, crumbs, toggle, options.drill ? null : chooser);
    head.hidden = !toggle && !(options.drill ? null : chooser) && !crumbs;
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
    if (options.bedIcons) root.append(bedSymbols(`${id}-bed-${plans.indexOf(plan)}`));
    // Retícula: la de la vista o, colocando, la de la herramienta. Fina, y fuera si sale de menos de 5 px.
    const gridScale = edit ? tool.scale : options.grid || null;
    const cs = gridScale ? cellSize(plan, gridScale) : null;
    const gridNode = cs && validGrid(plan.grid) && !(scale > 0 && cs * scale < 5)
      ? (() => {
        const gid = `${id}-grid-${plans.indexOf(plan)}`;
        const stroke = Math.max(px(1), cs * 0.015);
        return [svg('defs', {}, svg('pattern', { id: gid, patternUnits: 'userSpaceOnUse', x: plan.grid!.originX ?? 0, y: plan.grid!.originY ?? 0, width: cs, height: cs },
          svg('path', { class: 'map-grid-line', d: `M ${cs} 0 L 0 0 0 ${cs}`, fill: 'none', 'stroke-width': stroke.toFixed(3) }))),
        svg('rect', { class: 'map-grid', width: w, height: h, fill: `url(#${gid})`, 'aria-hidden': 'true', 'data-scale': gridScale })];
      })()
      : [];
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
      const kind = bed && options.bedIcons ? bedKindOf(s.attributes) : null;
      if (kind) {
        const xs = shape.points.map((p) => p[0] * w);
        const ys = shape.points.map((p) => p[1] * h);
        const bx = Math.min(...xs); const by = Math.min(...ys);
        const bw = Math.max(...xs) - bx; const bh = Math.max(...ys) - by;
        // El cabecero va arriba si la cama es vertical; si es apaisada, el icono se gira.
        const wide = bw > bh;
        const cxm = bx + bw / 2; const cym = by + bh / 2;
        const [iw, ih] = wide ? [bh, bw] : [bw, bh];
        shapesLayer.append(svg('use', {
          class: `map-bedicon${off ? ' map-off' : ''}`, href: `#${id}-bed-${plans.indexOf(plan)}-${kind}`, x: cxm - iw / 2, y: cym - ih / 2, width: iw, height: ih,
          // En unidades del símbolo (20 de ancho): la línea crece con la cama y no la tapa.
          'stroke-width': 0.9, 'aria-hidden': 'true', 'data-bed-kind': kind,
          ...(wide ? { transform: `rotate(90 ${cxm.toFixed(1)} ${cym.toFixed(1)})` } : {}),
        }));
      }
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
    // Bandas (alturas de la finca): línea arriba y abajo y el nombre a la izquierda.
    const bandList = ((options.bands ? options.bands(plan) : plan.bands) ?? []).filter((b) => Number.isFinite(b.y0) && Number.isFinite(b.y1));
    const bandsLayer = bandList.length ? svg('g', { class: 'map-bands', 'aria-hidden': 'true' }, ...bandList.flatMap((b) => [
      svg('line', { class: 'map-band-line', x1: 0, x2: w, y1: b.y0 * h, y2: b.y0 * h, 'stroke-width': Math.max(px(1), unit * 0.001).toFixed(2) }),
      svg('line', { class: 'map-band-line', x1: 0, x2: w, y1: b.y1 * h, y2: b.y1 * h, 'stroke-width': Math.max(px(1), unit * 0.001).toFixed(2) }),
      svg('text', { class: 'map-band-txt', x: unit * 0.01, y: Math.min(b.y0, b.y1) * h + Math.max(px(12), unit * 0.014) * 1.35, 'font-size': Math.max(px(11), unit * 0.012).toFixed(1) }, b.name),
    ])) : null;
    // Curvas de nivel: la etiqueta con su cota y, debajo, lo que sube hasta la siguiente.
    const contourList = ((options.contours ? options.contours(plan) : plan.contours) ?? [])
      .filter((c) => Number.isFinite(c.elevationM) && Number.isFinite(c.x) && Number.isFinite(c.y)).slice().sort((a, b) => a.elevationM - b.elevationM);
    const meters = (n: number) => kt('{n} m', { n: new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(n) });
    const contourText = (c: PlanContour, i: number) => {
      const next = contourList[i + 1];
      return { main: `${c.label} · ${meters(c.elevationM)}`, diff: next ? `${next.elevationM >= c.elevationM ? '+' : ''}${meters(next.elevationM - c.elevationM)}` : null };
    };
    const csize = Math.max(px(11), unit * 0.012);
    const contoursLayer = contourList.length ? svg('g', { class: 'map-contours', 'aria-hidden': 'true' }, ...contourList.flatMap((c, i) => {
      const txt = contourText(c, i);
      // En la mitad derecha, el texto va a la izquierda del punto para no salirse.
      const right = c.x > 0.55;
      const tx = c.x * w + (right ? -1 : 1) * csize * 0.6;
      const anchor = right ? 'end' : 'start';
      return [
        svg('circle', { class: 'map-contour-dot', cx: c.x * w, cy: c.y * h, r: (csize * 0.3).toFixed(1) }),
        svg('text', { class: 'map-contour-txt', x: tx, y: c.y * h, 'font-size': csize.toFixed(1), 'dominant-baseline': 'central', 'text-anchor': anchor }, txt.main),
        txt.diff ? svg('text', { class: 'map-contour-diff', x: tx, y: c.y * h + csize * 1.2, 'font-size': (csize * 0.9).toFixed(1), 'dominant-baseline': 'central', 'text-anchor': anchor }, `↑ ${txt.diff}`) : null,
      ];
    })) : null;
    const said = [
      bandList.length ? `${kt('Alturas')}: ${bandList.map((b) => b.name).join(', ')}` : null,
      contourList.length ? `${kt('Cotas')}: ${contourList.map((c, i) => { const x = contourText(c, i); return x.diff ? `${x.main} (${kt('{d} hasta la siguiente', { d: x.diff })})` : x.main; }).join(', ')}` : null,
    ].filter(Boolean);
    if (said.length) root.setAttribute('aria-label', `${name}. ${said.join('. ')}`);
    const decorLayer = paintDecor(plan, root, w, h);
    root.append(...gridNode, shapesLayer, ...decorLayer, ring, bandsLayer ?? '', contoursLayer ?? '', labels);
    const missing = plan.fileId && failed.has(plan.fileId) ? el('p', { class: 'hint map-nobg' }, kt('No se ha podido cargar el dibujo: las estancias siguen en su sitio y en la lista.')) : null;
    const states = new Set(here.filter(({ s }) => s.kind === 'cama' && inUse(s)).map(({ s }) => layerOf(s).state).filter(Boolean) as SpaceMapBedState[]);
    return { nodes: [root, missing], states };
  }

  // --- Decoración ----------------------------------------------------------------------------------------------
  const decorName = (item: DecorItem) => item.label ?? edit?.icons.find((i) => i.id === item.iconId)?.label ?? kt('Objeto');
  const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `deco-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const emit = (type: DecorChange['type'], item: DecorItem) => edit?.onDecorChange({ type, item: { ...item } } as DecorChange);

  function decorNode(plan: FloorPlan, item: DecorItem): SVGElement | null {
    const box = decorBox(plan, item);
    const url = item.iconUrl && safeIconUrl(item.iconUrl) ? item.iconUrl : null;
    const text = item.iconId ? '' : beaconText(item.label);
    if (!box || (!url && !text)) return null;
    const cx = box.x + box.side / 2;
    const cy = box.y + box.side / 2;
    const turn = item.rotation ? { transform: `rotate(${item.rotation} ${cx.toFixed(2)} ${cy.toFixed(2)})` } : {};
    const fs = Math.max(box.side * 0.22, 1);
    const caption = text ? svg('text', { class: 'map-deco-text', x: cx, y: url ? box.y + box.side + fs : cy, 'font-size': fs.toFixed(2), 'text-anchor': 'middle', 'dominant-baseline': 'middle' }) : null;
    if (caption) caption.textContent = text;
    // Baliza de solo texto: una etiqueta con fondo; con imagen, la imagen y el texto debajo.
    const image = url
      ? svg('g', { class: 'map-deco-art' }, svg('image', { class: 'map-deco-img', href: url, x: box.x, y: box.y, width: box.side, height: box.side, preserveAspectRatio: 'xMidYMid meet', ...turn }), caption)
      : svg('g', { class: 'map-deco-art map-deco-beacon' }, svg('rect', { class: 'map-deco-tag', x: box.x, y: cy - fs, width: box.side, height: fs * 2, rx: fs * 0.4 }), caption);
    if (!edit) return image;
    const on = decorSel === item.id;
    const g = svg('g', {
      class: `map-deco${on ? ' map-deco-on' : ''}`, role: 'button', tabindex: 0, 'data-deco-id': item.id, 'aria-pressed': String(on),
      'aria-label': kt('{name}, columna {x}, fila {y}', { name: decorName(item), x: String(item.cellX + 1), y: String(item.cellY + 1) }), ...mark('item'),
    }, image, on ? svg('rect', { class: 'map-deco-sel', x: box.x, y: box.y, width: box.side, height: box.side, 'aria-hidden': 'true' }) : null);
    return g;
  }

  function paintDecor(plan: FloorPlan, root: SVGSVGElement, w: number, h: number): SVGElement[] {
    const show = edit ? true : options.showDecor !== false;
    if (!show || !validGrid(plan.grid)) return [];
    const items = decor.filter((d) => d.planId === plan.id);
    const layer = svg('g', { class: `map-decor${edit ? ' map-decor-edit' : ''}`, ...(edit ? {} : { 'aria-hidden': 'true' }) }, ...items.map((d) => decorNode(plan, d)).filter((n): n is SVGElement => !!n));
    if (!edit) return [layer];
    // Colocando: una capa que recoge los toques sobre el plano (debajo de los objetos).
    const hit = svg('rect', { class: 'map-decor-hit', width: w, height: h, 'aria-hidden': 'true' });
    const toRel = (e: PointerEvent | MouseEvent) => {
      const m = root.getScreenCTM();
      if (!m) return null;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
      return { x: p.x / w, y: p.y / h };
    };
    hit.addEventListener('click', (e) => {
      const icon = edit.icons.find((i) => i.id === tool.iconId);
      const text = beacon.text.trim().slice(0, 60);
      const kind = tool.iconId === TEXT_TOOL ? (text ? 'text' : null) : tool.iconId === IMAGE_TOOL ? (beacon.url ? 'image' : null) : icon ? 'icon' : null;
      const at = toRel(e);
      if (!kind || !at) { if (!kind) decorBar.querySelector<HTMLElement>('.map-decor-beacon input')?.focus(); return; }
      const cell = relToCell(plan, tool.scale, at.x, at.y);
      if (!cell) return;
      // Con 4 celdas, el objeto se centra en el toque.
      const shift = tool.size === 4 ? 0.5 : 0;
      const cs = cellSize(plan, tool.scale)!;
      const c2 = tool.size === 4 ? relToCell(plan, tool.scale, at.x - (shift * cs) / w, at.y - (shift * cs) / h) ?? cell : cell;
      const item: DecorItem = kind === 'icon'
        ? { id: newId(), planId: plan.id, iconId: icon!.id, iconUrl: icon!.url, cellX: c2.cellX, cellY: c2.cellY, scale: tool.scale, size: tool.size, rotation: 0, label: icon!.label }
        : { id: newId(), planId: plan.id, iconId: null, iconUrl: kind === 'image' ? beacon.url : null, fileId: kind === 'image' ? beacon.fileId : null, cellX: c2.cellX, cellY: c2.cellY, scale: tool.scale, size: tool.size, rotation: 0, label: text || null };
      decor = [...decor, item];
      decorSel = item.id;
      emit('add', item);
      paint();
      focusDecor(item.id);
    });
    // Arrastrar por celdas: el puntero se captura en el SVG, que no se repinta hasta soltar.
    layer.addEventListener('pointerdown', (e) => {
      const g = (e.target as Element).closest<SVGGElement>('.map-deco');
      const item = g ? decor.find((d) => d.id === g.dataset.decoId) : null;
      const at = toRel(e);
      if (!g || !item || !at) return;
      e.preventDefault();
      const start = relToCell(plan, item.scale, at.x, at.y);
      if (!start) return;
      const from = { x: item.cellX, y: item.cellY };
      let moved = false;
      dragging = true;
      decorSel = item.id;
      root.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const now = toRel(ev);
        const cell = now ? relToCell(plan, item.scale, now.x, now.y) : null;
        if (!cell) return;
        const nx = from.x + cell.cellX - start.cellX;
        const ny = from.y + cell.cellY - start.cellY;
        if (nx === item.cellX && ny === item.cellY) return;
        item.cellX = nx; item.cellY = ny; moved = true;
        const node = decorNode(plan, item);
        const old = layer.querySelector(`[data-deco-id="${CSS.escape(item.id)}"]`);
        if (node && old) old.replaceWith(node);
      };
      const up = () => {
        root.removeEventListener('pointermove', move);
        root.removeEventListener('pointerup', up);
        root.removeEventListener('pointercancel', up);
        dragging = false;
        if (moved) emit('move', item);
        paint();
        focusDecor(item.id);
      };
      root.addEventListener('pointermove', move);
      root.addEventListener('pointerup', up);
      root.addEventListener('pointercancel', up);
    });
    layer.addEventListener('keydown', (e) => {
      const g = (e.target as Element).closest<SVGGElement>('.map-deco');
      const item = g ? decor.find((d) => d.id === g.dataset.decoId) : null;
      if (!item) return;
      const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const step = steps[e.key];
      if (step) { e.preventDefault(); item.cellX += step[0]; item.cellY += step[1]; decorSel = item.id; emit('move', item); paint(); focusDecor(item.id); return; }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rotateDecor(item); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeDecor(item); return; }
      if (e.key === 'Escape') { e.stopPropagation(); decorSel = null; paint(); return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); decorSel = item.id; paint(); focusDecor(item.id); }
    });
    return [hit, layer];
  }

  function focusDecor(decoId: string): void {
    stage.querySelector<SVGElement>(`.map-deco[data-deco-id="${CSS.escape(decoId)}"]`)?.focus({ preventScroll: true });
  }
  function rotateDecor(item: DecorItem): void {
    item.rotation = ((item.rotation + 90) % 360) as DecorItem['rotation'];
    decorSel = item.id;
    emit('rotate', item);
    paint();
    focusDecor(item.id);
  }
  function removeDecor(item: DecorItem): void {
    decor = decor.filter((d) => d.id !== item.id);
    decorSel = null;
    emit('remove', item);
    paint();
    stage.querySelector<SVGElement>('.map-deco')?.focus({ preventScroll: true });
  }

  /** Barra de «Decoración» (solo con `decorEdit`): icono, tamaño, escala y lo que se hace con el elegido. */
  function paintDecorBar(plan: FloorPlan | null): void {
    decorBar.hidden = !edit || !plan || view !== 'plan';
    if (!edit || !plan) { replace(decorBar); return; }
    const chosen = decor.find((d) => d.id === decorSel && d.planId === plan.id) ?? null;
    const seg = (label: string, items: Array<{ key: string; text: Node | string; on: boolean; act: () => void; markKey: keyof typeof SPACE_MAP_MARKS; extra?: Record<string, string> }>) =>
      el('div', { class: 'segmented map-decor-seg', role: 'group', 'aria-label': label }, ...items.map((it) => el('button', {
        type: 'button', class: it.on ? 'on' : '', 'aria-pressed': String(it.on), dataset: { key: it.key }, ...mark(it.markKey), ...(it.extra ?? {}), onclick: it.act,
      }, it.text)));
    const icons = seg(kt('Icono'), edit.icons.map((icon) => ({
      key: icon.id, on: tool.iconId === icon.id, markKey: 'icon' as keyof typeof SPACE_MAP_MARKS,
      text: el('span', { class: 'map-decor-icon' }, safeIconUrl(icon.url) ? el('img', { src: icon.url, alt: '', width: '24', height: '24', loading: 'lazy' }) : null, el('span', null, icon.label)),
      act: () => { tool.iconId = icon.id; tool.size = icon.size ?? tool.size; paint(); decorBar.querySelector<HTMLElement>(`[data-key="${CSS.escape(icon.id)}"]`)?.focus(); },
    })).concat([
      { key: TEXT_TOOL, on: tool.iconId === TEXT_TOOL, markKey: 'text' as const, text: el('span', { class: 'map-decor-icon' }, kt('Texto')),
        act: () => { tool.iconId = TEXT_TOOL; decorSel = null; paint(); decorBar.querySelector<HTMLInputElement>('.map-decor-beacon input[type=text]')?.focus(); } },
      ...(edit.onUpload ? [{ key: IMAGE_TOOL, on: tool.iconId === IMAGE_TOOL, markKey: 'upload' as const, text: el('span', { class: 'map-decor-icon' }, kt('Subir imagen')),
        act: () => { tool.iconId = IMAGE_TOOL; decorSel = null; paint(); decorBar.querySelector<HTMLInputElement>('.map-decor-beacon input[type=file]')?.click(); } }] : []),
    ]));
    // Baliza: el texto (y, con «Subir imagen», el archivo). La imagen se sube al elegirla; se pone al tocar el plano.
    const beaconBox = tool.iconId === TEXT_TOOL || tool.iconId === IMAGE_TOOL ? el('div', { class: 'map-decor-beacon' },
      el('label', { class: 'field' }, el('span', null, tool.iconId === TEXT_TOOL ? kt('Texto de la baliza') : kt('Pie (opcional)')),
        el('input', { type: 'text', class: 'input', maxlength: '60', autocomplete: 'off', value: beacon.text, ...NOT_A_FIELD, oninput: (e: Event) => { beacon.text = (e.target as HTMLInputElement).value; } })),
      tool.iconId === IMAGE_TOOL && edit.onUpload ? el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', class: 'vh', ...NOT_A_FIELD, 'aria-label': kt('Subir imagen'),
        onchange: async (e: Event) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file || beacon.busy) return;
          beacon.busy = true; beacon.url = null; paint();
          try { const up = await edit.onUpload!(file); beacon.url = safeIconUrl(up.url) ? up.url : null; beacon.fileId = beacon.url ? up.fileId ?? null : null; } catch { beacon.url = null; beacon.fileId = null; }
          beacon.busy = false; paint();
        } }) : null,
      tool.iconId === IMAGE_TOOL ? el('button', { type: 'button', class: 'ghost small', disabled: beacon.busy ? true : null, onclick: () => decorBar.querySelector<HTMLInputElement>('.map-decor-beacon input[type=file]')?.click() },
        beacon.busy ? kt('Subiendo…') : beacon.url ? kt('Cambiar imagen') : kt('Elegir imagen')) : null) : null;
    const sizes = seg(kt('Tamaño'), ([1, 4] as const).map((n) => ({
      key: `size-${n}`, on: tool.size === n, markKey: 'size' as const, text: n === 1 ? kt('1 celda') : kt('4 celdas'),
      act: () => { tool.size = n; paint(); decorBar.querySelector<HTMLElement>(`[data-key="size-${n}"]`)?.focus(); },
    })));
    const scalesSeg = seg(kt('Retícula'), GRID_SCALES.map((s) => ({
      key: `scale-${s}`, on: tool.scale === s, markKey: 'scale' as const, text: s === 0.5 ? kt('0,5 m') : `${s} m`,
      act: () => { tool.scale = s; paint(); decorBar.querySelector<HTMLElement>(`[data-key="scale-${s}"]`)?.focus(); },
    })));
    const actions = el('div', { class: 'map-decor-actions' },
      el('button', { type: 'button', class: 'ghost small map-decor-rotate', disabled: chosen ? null : true, ...mark('rotate'), onclick: () => { if (chosen) rotateDecor(chosen); } }, kt('Girar 90°')),
      el('button', { type: 'button', class: 'ghost small danger map-decor-remove', disabled: chosen ? null : true, ...mark('remove'), onclick: () => { if (chosen) removeDecor(chosen); } }, kt('Quitar')));
    const icon = edit.icons.find((i) => i.id === tool.iconId);
    const hint = el('p', { class: 'hint map-decor-hint', role: 'status' }, !validGrid(plan.grid)
      ? kt('Este dibujo no tiene escala: no se puede colocar decoración hasta que Recursos la ponga.')
      : chosen
        ? kt('«{name}» elegido: arrástralo, muévelo con las flechas, R para girar y Supr para quitar.', { name: decorName(chosen) })
        : tool.iconId === TEXT_TOOL ? kt('Escribe el texto y toca el plano para poner la baliza.')
          : tool.iconId === IMAGE_TOOL ? (beacon.busy ? kt('Subiendo la imagen…') : beacon.url ? kt('Toca el plano para poner la imagen.') : kt('Elige una imagen para subirla.'))
            : icon ? kt('Toca el plano para poner «{name}».', { name: icon.label }) : kt('Elige un icono.'));
    replace(decorBar, icons, beaconBox, el('div', { class: 'map-decor-row' }, sizes, scalesSeg, actions), hint);
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
    // Con `drill`, la lista es lo dibujado en ese plano (en la finca, los edificios, que llevan dentro).
    const shown = options.drill && plan && !crop
      ? rows.filter((s) => inUse(s) && shapeOf(s)?.planId === plan.id)
      : rows.filter((s) => inUse(s) && !container(s) && inside(s));
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

  /** Lo que tiene el foco, para devolvérselo al nodo equivalente tras repintar. */
  function focusKey(): string | null {
    const a = document.activeElement;
    if (!a || !element.contains(a) || a === element) return null;
    const cls = [...a.classList].find((c) => c.startsWith('map-')) ?? '';
    const data = ['spaceId', 'decoId', 'key', 'view', 'planId'].map((k) => (a as HTMLElement).dataset?.[k] ? `[data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${CSS.escape((a as HTMLElement).dataset[k]!)}"]` : '').join('');
    return cls || data ? `${a.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${data}` : null;
  }

  function paint(): void {
    const keep = focusKey();
    paintNow();
    if (keep && !element.contains(document.activeElement)) element.querySelector<HTMLElement>(keep)?.focus({ preventScroll: true });
  }

  function paintNow(): void {
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
      paintDecorBar(plan);
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
    if (wantPlan && useful.some((p) => p.id === wantPlan)) { planId = wantPlan; wantPlan = null; }
    if (!useful.some((p) => p.id === planId)) planId = useful[0]?.id ?? null;
    const plan = useful.find((p) => p.id === planId) ?? null;
    const hasPlan = !!plan;
    view = hasPlan ? wanted : 'list';
    element.dataset.view = view;
    element.classList.toggle('map-noplan', !hasPlan);
    paintHead(hasPlan, useful);
    if (plan) paintStage(options.layout === 'all' ? useful.map((p) => ({ plan: p })) : [{ plan }]); else { replace(stage); replace(legend); }
    paintDecorBar(plan);
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
    if (changed && !dragging) paint();
  }) : null;
  resize?.observe(stage);
  element.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !options.drill || !trail.length || e.defaultPrevented) return;
    if ((e.target as Element).closest('input, textarea, select, .map-deco')) return;
    e.preventDefault();
    goBack();
  });

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
      // Las formas derivadas (camas con disposición en Booking) no se mueven a mano.
      if (rows.find((r) => r.id === spaceId)?.shapeLocked) return;
      localShapes.set(spaceId, { planId: plan, shape });
      paint();
      const s = rows.find((r) => r.id === spaceId);
      if (s) options.onShape?.(s, plan, shape);
    },
    setDecor(items) {
      decor = items.slice();
      if (decorSel && !decor.some((d) => d.id === decorSel)) decorSel = null;
      if (!dragging) paint();
    },
    setPlan(next) { trail = []; focus = null; wantPlan = next; follow = false; paint(); },
    path,
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
