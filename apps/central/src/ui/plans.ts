/**
 * Central · Planos del centro (tanda 36, MUELA-024 con sus adendas; tanda 37, MUELA-092; docs/central/API.md §9.7). El
 * mapa de zonas de todas las apps sale de aquí: el dibujo de cada edificio y planta (`resources.floor_plans`) y la forma
 * de cada estancia encima (`resources.spaces.plan_id` + `plan_shape`, puntos 0..1 relativos a la imagen).
 * - **Todos** ven el mapa con la pieza del kit (`createSpaceMap`), con su lista equivalente.
 * - **«Colocar», solo el owner y en el ordenador** (en el móvil, solo ver; el núcleo lo exige igualmente):
 *   - subir un dibujo por edificio y planta (SVG, PNG o JPG), sustituirlo (las formas se conservan) y quitarlo (no con
 *     estancias encima). **Del SVG se sube el limpio** (`cleanSvg`), no el original. Sin red, subir, sustituir, quitar y
 *     «Colocar solo» se apagan con su motivo;
 *   - **colocar solo:** si el SVG trae los nombres de las estancias, se colocan solas (`app/svg-plan.ts`: DOMPurify, perfil
 *     SVG, y nunca en la página). El aviso dice qué nombres del SVG no son de ninguna estancia; la que no se puede leer
 *     (un giro raro) va a «Por revisar» con el motivo;
 *   - **colocar a mano:** arrastrar y estirar, o con el teclado (flechas mueven; con Mayúsculas, estiran). Las camas y lo
 *     que hay dentro acompañan a su habitación: el mismo lote y un solo «Deshacer». Cada forma pasa por `setShape` y
 *     `onShape` de la pieza;
 *   - **«Por revisar»:** las estancias del edificio que aún no tienen forma.
 * - El plano en imagen o PDF de la Entidad no cambia: lo siguen usando los portales.
 * - **Finca y decoración** (encargo de VG del 27-10; Recursos 0814, kit 0.63):
 *   - el mapa empieza en el dibujo de la finca (si lo hay) y baja a cada edificio con su miga (`drill`); enseña la
 *     decoración general (solo ver) y las cotas de las alturas en sus curvas de nivel;
 *   - al subir un dibujo se elige «Edificio o exterior» o «Finca» (cuelga de un exterior raíz). De la finca se leen la escala (`data-meters-per-unit`) y
 *     dónde va la cota de cada altura: el punto medio de su curva de nivel (`<path data-contour="Altura N">`, convención de
 *     Core con UI-kit). Las bandas no se guardan, porque el SVG ya dibuja las curvas;
 *   - «Colocar» tiene dos pestañas: Estancias (lo de siempre) y **Decoración** (la pieza del kit con `decorEdit`: icono,
 *     tamaño, escala, poner, arrastrar, girar y quitar; cada cambio con «Deshacer»), más el catálogo de iconos, la escala
 *     del dibujo y, en la finca, la cota de cada altura;
 *   - **Imágenes del centro:** siluetas, secciones y fotos de cada edificio, que leen Guests y Organizers.
 *   - **Curvas de nivel editables** (Recursos 0815): en «Colocar» de la finca, cada curva con sus puntos como asas; se
 *     arrastran (o con el teclado, flechas) y se guardan en `contours[i].points` con «Deshacer». Sin puntos guardados, la
 *     curva sale del SVG (`data-contour`).
 */
import {
  applyBedLayouts, bedLayoutFromRow, bindOnline, confirmDialog, createSpaceMap, createSyncSpaceSource, el, icon, indexSpaces, openSheet, renderOfflineReason, replace, shapeCenter, spacePath,
  spaceToFields, toast, toastWithAction, validGrid, validShape,
  type BedLayout as KitBedLayout, type DecorChange as KitDecorChange, type DecorIcon, type DecorItem, type FloorPlan, type GridScale, type PlanContour, type PlanGrid, type PlanShape, type Sheet,
  type SpaceMap, type SpaceRow,
} from '@ikisai/ui-kit';
import type { RowOperation, TableName } from '@ikisai/sync-client';
import { BOOKING_BEDS_URL, type BedLayout } from '@ikisai/domain-central';
import { describeError } from '../app/client.ts';
import { R, startResources } from '../app/resources.ts';
import { announceHeaderArt, centralHeader } from './header-art.ts';
import {
  DECOR_ICONS, HEADER_APPS, HEADER_APP_LABELS, IMAGE_KIND_LABELS, headerOf, headerOperations, type HeaderApp, IMAGE_KINDS, contoursFromBands, contoursFromCurves, movePoint, withContourPoints, decorForPlan, decorOperations, elevationLines, estateMeta, gridOf, iconProblem, imageProblem,
  type DecorRow, type ImageKind,
} from '../app/decor.ts';
import { activeContent, cleanSvg, foldName, generatedName, matchShapes, readSvgPlan, type SvgShape } from '../app/svg-plan.ts';
import type { ViewMount } from './shell.ts';

const PLANS = 'resources.floor_plans' as TableName;
/** Valor del desplegable para «Otra: escribir el nombre…». */
const NEW_SPACE = '__nueva__';
/** Tipos de estancia que se pueden crear desde el dibujo (los de nivel 3 del kit). */
const ROOM_KINDS: Array<[string, string]> = [['habitacion', 'Habitación'], ['sala', 'Sala'], ['bano', 'Baño'], ['cocina', 'Cocina'], ['comedor', 'Comedor'], ['oficina', 'Oficina'],
  ['zona_paso', 'Zona de paso'], ['instalacion', 'Instalación'], ['almacen', 'Almacén'], ['otro', 'Otro']];
const SPACES = 'resources.spaces' as TableName;
const PLAN_MIME = ['image/svg+xml', 'image/png', 'image/jpeg'];
const ITEMS = R.decorItems as TableName;
const IMAGES = R.spaceImages as TableName;
const ICON_ACCEPT = 'image/svg+xml,image/png,image/gif';
type PlanRow = { id: string; revision: number; kind?: string | null; grid?: unknown; contours?: unknown; deleted_at?: string | null };
type IconRow = { id: string; revision: number; name: string; category: string; file_id: unknown; default_size: number; deleted_at?: string | null };
/** Ids literales del selector de cabecera de cada app (así entran en el catálogo y en el inventario de campos). */
const HEADER_MARKS: Record<HeaderApp, { label: Record<string, string>; select: Record<string, string> }> = {
  central: { label: { 'data-feedback-id': 'central.planos.imagenes.cabecera.central', 'data-feedback-label': 'Cabecera de Central' }, select: { 'data-field-id': 'central.planos.header_central', 'data-field-entity': 'resources.space_images', 'data-field-prop': 'header_for' } },
  guests: { label: { 'data-feedback-id': 'central.planos.imagenes.cabecera.guests', 'data-feedback-label': 'Cabecera de Guests' }, select: { 'data-field-id': 'central.planos.header_guests', 'data-field-entity': 'resources.space_images', 'data-field-prop': 'header_for' } },
  organizers: { label: { 'data-feedback-id': 'central.planos.imagenes.cabecera.organizers', 'data-feedback-label': 'Cabecera de Organizers' }, select: { 'data-field-id': 'central.planos.header_organizers', 'data-field-entity': 'resources.space_images', 'data-field-prop': 'header_for' } },
};
type ImageRow = { id: string; revision: number; space_id: string; kind: string; title: string; file_id: unknown; position: number; header_for?: string[] | null; deleted_at?: string | null };
const WIDE = '(min-width: 900px)';
/** Lo que no se coloca: lo que contiene estancias (alturas, edificios y exteriores). */
const CONTAINERS = new Set(['altura', 'edificio', 'exterior']);
/** El aviso del SVG con contenido activo (el servidor lo rechaza, #694; aquí no debería llegar, porque se sube limpio). */
const ACTIVE_SVG = 'El SVG lleva contenido activo. Guárdalo limpio desde tu programa de dibujo.';
/** Cuántos nombres del SVG sin estancia se dicen; del resto, «+N más». */
const UNMATCHED_SHOWN = 10;

/** Tamaño del dibujo en sus unidades: el `viewBox` del SVG o los píxeles de la imagen. */
async function imageSize(file: Blob, svgText: string | null): Promise<{ width: number; height: number } | null> {
  if (svgText !== null) { const plan = readSvgPlan(svgText); return plan ? { width: plan.width, height: plan.height } : null; }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('imagen')); img.src = url; });
    return img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null;
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

/** Un dibujo recién elegido aún no tiene id de archivo (en el espejo es `{ $blob }`): hasta que sube, sin archivo. */
const uploaded = (p: FloorPlan): FloorPlan => (typeof p.fileId === 'string' ? p : { ...p, fileId: null });
const pendingFile = (p: FloorPlan) => p.fileId !== null && typeof p.fileId !== 'string';

const rect = (cx: number, cy: number, w: number, h: number): PlanShape => {
  const x0 = Math.min(Math.max(cx - w / 2, 0), 1 - w); const y0 = Math.min(Math.max(cy - h / 2, 0), 1 - h);
  return { points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]] };
};
const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
const boxOf = (s: PlanShape) => { const xs = s.points.map((p) => p[0]); const ys = s.points.map((p) => p[1]); return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };
/** Mueve una forma sin salirse del dibujo. */
function moved(s: PlanShape, dx: number, dy: number): PlanShape {
  const b = boxOf(s);
  const mx = Math.min(Math.max(dx, -b.x0), 1 - b.x1); const my = Math.min(Math.max(dy, -b.y0), 1 - b.y1);
  return { points: s.points.map(([x, y]) => [round(x + mx), round(y + my)]) };
}
/** Estira una forma desde su esquina de arriba a la izquierda (o desde la contraria a la que se arrastra). */
function stretched(s: PlanShape, anchor: [number, number], w: number, h: number): PlanShape {
  const b = boxOf(s);
  const bw = Math.max(b.x1 - b.x0, 1e-6); const bh = Math.max(b.y1 - b.y0, 1e-6);
  const nw = Math.max(0.01, Math.min(w, 1)); const nh = Math.max(0.01, Math.min(h, 1));
  return { points: s.points.map(([x, y]) => [round(anchor[0] + ((x - anchor[0]) * nw) / bw), round(anchor[1] + ((y - anchor[1]) * nh) / bh)]) };
}
/** La misma traslación y escala que lleva la caja de `from` a la de `to`, aplicada a otra forma (una cama de la habitación). */
function follow(shape: PlanShape, from: PlanShape, to: PlanShape): PlanShape {
  const a = boxOf(from); const b = boxOf(to);
  const sx = (b.x1 - b.x0) / Math.max(a.x1 - a.x0, 1e-6); const sy = (b.y1 - b.y0) / Math.max(a.y1 - a.y0, 1e-6);
  return { points: shape.points.map(([x, y]) => [round(b.x0 + (x - a.x0) * sx), round(b.y0 + (y - a.y0) * sy)]) };
}
const pointsAttr = (s: PlanShape, plan: FloorPlan) => s.points.map(([x, y]) => `${(x * plan.width).toFixed(1)},${(y * plan.height).toFixed(1)}`).join(' ');

type Placement = { planId: string | null; shape: PlanShape | null };

export const mountPlans: ViewMount = ({ main, client }) => {
  let alive = true;
  const r = startResources(client);
  // Camas con un solo modelo (VG, 27-10): su sitio lo guarda Booking (`GET beds/layout`) y aquí se deriva de la forma de
  // su habitación en cada lectura. Central no guarda ni escribe formas de cama; lo que hubiera en Recursos no cuenta.
  const baseSpaces = createSyncSpaceSource(r);
  let layouts: BedLayout[] = [];
  // La derivación es la del kit (`applyBedLayouts` con `bedShape`, #1023): todas las apps pintan las camas igual.
  const derive = (list: SpaceRow[]) => applyBedLayouts(list, layouts.map((l) => bedLayoutFromRow(l as unknown as Record<string, unknown>)).filter((l): l is KitBedLayout => !!l));
  const spaces: typeof baseSpaces = {
    ...baseSpaces,
    list: async () => derive(await baseSpaces.list()),
    subscribe: (listener) => baseSpaces.subscribe((next) => listener(derive(next))),
  };
  const media = matchMedia(WIDE);
  const canPlace = () => r.bootstrap()?.membership.role === 'owner';
  let rows: SpaceRow[] = [];
  let plans: FloorPlan[] = [];
  let editing: string | null = null;
  // La dirección de cada dibujo, una vez: pedirla en cada repintado hacía parpadear la imagen (VG, 28-10).
  const planUrls = new Map<string, string>();
  // La forma del dibujo que se está mirando (la fila con el foco o el ratón): se resalta en el dibujo.
  let lit: string | null = null;
  // «Colocar» empieza por las formas que ya trae el dibujo (VG, 27-10): para cada una se dice qué estancia es.
  const svgShapes = new Map<string, SvgShape[] | 'loading' | 'none'>();
  let missingOpen: boolean | null = null;
  // Guardado a la vista: «Guardando…», «Guardado a las 10:42» o el error.
  let saveState = '';
  const paintSaved = () => { const node = editor.querySelector('#placeSaved'); if (node) node.textContent = saveState; };
  const wantedText = new URLSearchParams(location.hash.split('?')[1] ?? '').get('colocar')?.trim() ?? '';
  let wanted: string | null = wantedText || null;
  let viewer: SpaceMap | null = null;
  const binds: Array<() => void> = [];
  const editorBinds: Array<() => void> = [];
  /** El dibujo recién subido desde este dispositivo, para verlo ya mientras sube (`blob:`), por id de plano. */
  const localUrls = new Map<string, string>();
  /** Por qué una estancia está en «Por revisar» aunque el SVG la nombre (un giro que no se puede leer), por id. */
  const reviewWhy = new Map<string, string>();
  /** Los nombres del último «Colocar solo» que no son de ninguna estancia, por plano. */
  const unmatchedOf = new Map<string, string[]>();
  // Finca y decoración (0814): lo que la fuente del kit aún no trae de cada dibujo, los iconos, los objetos y las imágenes.
  let planRows: PlanRow[] = [];
  let icons: IconRow[] = [];
  let items: Array<DecorRow & { deleted_at?: string | null }> = [];
  let images: ImageRow[] = [];
  /** URL de cada archivo (iconos e imágenes), ya resuelta: la pieza del kit la quiere al momento. */
  const fileUrls = new Map<string, string>();
  /** Pestaña de «Colocar». */
  let tab: 'estancias' | 'decoracion' = 'estancias';
  let decorMap: SpaceMap | null = null;
  let decorScale: GridScale = 1;
  /** Curvas de nivel leídas del SVG de cada finca (por plano), para cuando aún no se han ajustado a mano. */
  const svgCurves = new Map<string, Array<{ spaceId: string; name: string; points: Array<[number, number]>; anchor: [number, number] }>>();

  const viewerHost = el('div', { id: 'plansMap' });
  const imagesHost = el('section', { id: 'centerImages', 'aria-label': 'Imágenes del centro', 'data-feedback-id': 'central.planos.imagenes', 'data-feedback-label': 'Imágenes del centro' });
  const tools = el('section', { id: 'planTools', 'aria-label': 'Dibujos y colocar', 'data-feedback-id': 'central.planos.dibujos', 'data-feedback-label': 'Dibujos y colocar' });
  const editor = el('section', { id: 'placeEditor', hidden: true, 'aria-label': 'Colocar', 'data-feedback-id': 'central.planos.colocar', 'data-feedback-label': 'Colocar' });
  replace(main,
    el('a', { href: '#/entidad', class: 'backlink', 'data-feedback-id': 'central.planos.volver', 'data-feedback-label': 'Volver a la entidad' }, '← Entidad'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.planos.cabecera', 'data-feedback-label': 'Cabecera de Planos' }, el('div', null, el('h2', null, 'Planos del centro'),
      el('p', null, 'El dibujo de cada edificio y planta, con sus estancias encima: es el mapa de zonas que ven las apps. El plano en imagen o PDF de la Entidad sigue siendo el de los portales.'))),
    tools, editor, viewerHost, imagesHost);

  const index = () => indexSpaces(rows);
  const planName = (p: FloorPlan) => [rows.find((s) => s.id === p.buildingId)?.name ?? 'Edificio', p.floor].filter(Boolean).join(' · ');
  const inside = (p: FloorPlan) => {
    if (isEstate(p)) return rows.filter((s) => s.active && s.id !== p.buildingId && (s.kind === 'edificio' || s.kind === 'exterior'));
    const idx = index(); return rows.filter((s) => s.active && !CONTAINERS.has(s.kind) && s.kind !== 'cama' && (s.id === p.buildingId || spacePath(idx, s.id).startsWith(`${spacePath(idx, p.buildingId)} › `)));
  };
  const placedOn = (p: FloorPlan) => rows.filter((s) => s.planId === p.id && validShape(s.planShape));
  const toReview = (p: FloorPlan) => inside(p).filter((s) => !(s.planId === p.id && validShape(s.planShape)));
  /** Lo que hay dentro de una estancia (sus camas) y está en el mismo dibujo. */
  const within = (s: SpaceRow, planId: string) => rows.filter((x) => {
    if (x.id === s.id || x.planId !== planId || !validShape(x.planShape)) return false;
    for (let up = x.parentId, guard = 0; up && guard < 20; up = rows.find((y) => y.id === up)?.parentId ?? null, guard++) if (up === s.id) return true;
    return false;
  });

  // --- Finca y decoración: lo que la fuente del kit aún no trae de cada dibujo ---------------------------------------
  const planRow = (id: string) => planRows.find((x) => x.id === id && !x.deleted_at) ?? null;
  const isEstate = (p: FloorPlan) => planRow(p.id)?.kind === 'estate';
  const gridOfPlan = (p: FloorPlan): PlanGrid | null => { const g = planRow(p.id)?.grid; return validGrid(g) ? g : null; };
  const elevationOf = (s: SpaceRow) => { const v = (s.attributes as Record<string, unknown> | undefined)?.elevation_m; return typeof v === 'number' ? v : null; };
  /** Cotas de la finca para la pieza: la posición la guarda el dibujo; el nombre y los metros, cada altura. */
  function contoursOf(p: FloorPlan): PlanContour[] | null {
    const raw = planRow(p.id)?.contours;
    if (!Array.isArray(raw)) return null;
    const out: PlanContour[] = [];
    for (const c of raw as Array<{ spaceId?: string; x?: number; y?: number }>) {
      const a = rows.find((s) => s.id === c.spaceId);
      const m = a ? elevationOf(a) : null;
      if (a && m !== null && typeof c.x === 'number' && typeof c.y === 'number') out.push({ spaceId: a.id, label: a.publicName ?? a.name, elevationM: m, x: c.x, y: c.y });
    }
    return out.length ? out : null;
  }
  const enrich = (p: FloorPlan): FloorPlan => ({ ...uploaded(p), grid: gridOfPlan(p), bands: null, contours: contoursOf(p) });
  const iconUrl = (id: string) => { const f = icons.find((i) => i.id === id)?.file_id; return typeof f === 'string' ? fileUrls.get(f) ?? null : null; };
  const decorOf = (planId: string): DecorItem[] => decorForPlan(items, planId, iconUrl).filter((d): d is typeof d & { iconUrl: string } => !!d.iconUrl).map((d): DecorItem => ({
    ...d, scale: d.scale as GridScale, size: d.size === 4 ? 4 : 1, rotation: ([0, 90, 180, 270].includes(d.rotation) ? d.rotation : 0) as DecorItem['rotation'], label: icons.find((i) => i.id === d.iconId)?.name ?? null,
  }));
  const allDecor = () => plans.flatMap((p) => decorOf(p.id));
  const kitIcons = (): DecorIcon[] => icons.filter((i) => !i.deleted_at).flatMap((i) => { const url = iconUrl(i.id); return url ? [{ id: i.id, url, label: i.name, size: i.default_size === 4 ? 4 as const : 1 as const }] : []; });
  /** Resuelve la URL de los archivos que aún no la tienen (iconos e imágenes) y repinta lo que la usa. */
  async function resolveFiles(): Promise<void> {
    const want = [...icons.map((i) => i.file_id), ...images.map((i) => i.file_id)].filter((f): f is string => typeof f === 'string' && !fileUrls.has(f));
    if (!want.length) return;
    await Promise.all(want.map(async (f) => { try { fileUrls.set(f, await r.fileUrl(f)); } catch { /* sin red: se intenta en la próxima vuelta */ } }));
    if (!alive) return;
    viewer?.setDecor(allDecor());
    paintDecorEditor();
    paintImages();
  }
  /** El dibujo con el que empieza el mapa: el de la finca, si lo hay. */
  const startPlan = () => plans.find((p) => isEstate(p))?.id ?? null;

  // --- El mapa (todos) ------------------------------------------------------------------------------------------
  function buildViewer(): void {
    viewer?.destroy();
    viewer = createSpaceMap({
      source: spaces, label: 'Mapa de zonas', feedbackId: 'central.planos.mapa',
      plans: {
        list: async () => (await spaces.plans.list()).map(enrich),
        subscribe: (listener) => spaces.plans.subscribe!((next) => listener(next.map(enrich))),
      },
      planUrl: (fileId) => r.fileUrl(fileId),
      // «Colocar» guarda aquí lo que la pieza avisa: la forma, en su dibujo.
      onShape: (space, planId, shape) => save(space.id, planId, shape),
      // De la finca a cada edificio, con su miga; la decoración general, solo para ver.
      drill: true,
      plan: startPlan(),
      decor: allDecor(),
    });
    replace(viewerHost, viewer.element);
  }

  // --- Guardar: un lote por gesto, con su «Deshacer» -------------------------------------------------------------
  /** Lo que falta por guardar, por estancia; sale en **un** lote (la habitación con sus camas va junta). */
  const batch = new Map<string, Placement>();
  /** Cómo estaba cada estancia antes del gesto, para «Deshacer» todo junto. */
  const before = new Map<string, Placement>();
  let undoLabel: string | null = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Apunta cómo estaba la estancia antes de cambiarla (solo la primera vez en el gesto). */
  function remember(id: string): void {
    const row = rows.find((s) => s.id === id);
    if (row && !before.has(id)) before.set(id, { planId: row.planId ?? null, shape: row.planShape ? { points: row.planShape.points.map(([x, y]) => [x, y]) } : null });
  }
  function save(id: string, planId: string | null, shape: PlanShape | null): void {
    // Las camas acompañan a su habitación solo en pantalla: su sitio es de Booking y no se escribe.
    if (rows.find((s) => s.id === id)?.kind === 'cama') return;
    batch.set(id, { planId, shape });
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => void flush(), 350);
  }
  async function flush(): Promise<void> {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (!batch.size) { before.clear(); undoLabel = null; return; }
    const entries = [...batch]; batch.clear();
    const undo = undoLabel ? new Map([...before].filter(([id]) => entries.some(([e]) => e === id))) : null;
    const label = undoLabel;
    before.clear(); undoLabel = null;
    saveState = 'Guardando…'; paintSaved();
    try {
      const ops: RowOperation[] = [];
      for (const [id, p] of entries) ops.push({ op: 'update', table: SPACES, id, expectedRevision: Number((await r.get(SPACES, id))?.revision ?? 0), fields: spaceToFields({ planId: p.planId, planShape: p.shape }) });
      await r.commit(ops);
      saveState = `Guardado a las ${new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date())}`; paintSaved();
      if (undo?.size && label && alive) toastWithAction(label, { label: 'Deshacer', onClick: () => restore(undo) });
    } catch (e) { saveState = `No se ha guardado: ${describeError(e)}`; paintSaved(); toast(describeError(e)); }
  }
  /** «Deshacer»: todas las del gesto vuelven a donde estaban, en un lote. */
  function restore(undo: Map<string, Placement>): void {
    for (const [id, p] of undo) {
      const row = rows.find((s) => s.id === id);
      if (row) { row.planId = p.planId; row.planShape = p.shape; }
      if (p.planId && p.shape) viewer?.setShape(id, p.planId, p.shape); else save(id, p.planId, p.shape);
    }
    if (batchTimer) clearTimeout(batchTimer);
    void flush();
    paintEditor();
  }
  /** Una forma nueva o cambiada: por la pieza (`setShape` → `onShape`), que también la enseña ya en el mapa. */
  function setShape(id: string, planId: string, shape: PlanShape): void {
    const row = rows.find((s) => s.id === id);
    if (row) { row.planId = planId; row.planShape = shape; }
    viewer?.setShape(id, planId, shape);
  }
  /** Mover o estirar a mano: la estancia y lo que tiene dentro, con la misma traslación y escala, y con «Deshacer». */
  function reshape(s: SpaceRow, plan: FloorPlan, from: PlanShape, to: PlanShape, inner: Array<[SpaceRow, PlanShape]>, how: 'movida' | 'estirada'): void {
    remember(s.id);
    for (const [x] of inner) remember(x.id);
    setShape(s.id, plan.id, to);
    for (const [x, start] of inner) setShape(x.id, plan.id, follow(start, from, to));
    const n = inner.length;
    const along = !n ? '' : inner.every(([x]) => x.kind === 'cama') ? (n === 1 ? ' con su cama' : ` con sus ${n} camas`) : ' con lo que tiene dentro';
    undoLabel = `${how === 'movida' ? 'Movida' : 'Estirada'} «${s.name}»${along}.`;
  }

  // --- Dibujos (owner, ordenador) ---------------------------------------------------------------------------------
  function paintTools(): void {
    for (const b of binds.splice(0)) b();
    if (!canPlace()) { replace(tools); return; }
    if (!media.matches) {
      replace(tools, el('p', { class: 'note', id: 'placeOnDesktop' }, icon('info', 16), ' Para subir dibujos y colocar las estancias, abre Planos en el ordenador. Aquí se ve el mapa.'));
      return;
    }
    const sorted = [...plans].sort((a, b) => planName(a).localeCompare(planName(b), 'es') || a.position - b.position);
    // Sin red, todo lo que escribe dibujos se apaga con un solo motivo.
    const why = renderOfflineReason({ reason: 'Subir, sustituir y quitar dibujos necesita conexión.', retry: () => void r.sync().catch(() => undefined) });
    why.id = 'planOffline';
    const upload = el('button', { type: 'button', class: 'primary', id: 'newPlan', 'data-feedback-id': 'central.planos.dibujos.subir', 'data-feedback-label': 'Subir un dibujo', onclick: () => openUpload(null) }, icon('upload', 16), 'Subir un dibujo');
    const online: HTMLElement[] = [upload];
    replace(tools,
      el('div', { class: 'blockhead' }, el('h3', null, 'Dibujos'), upload),
      why,
      sorted.length ? el('ul', { class: 'list', id: 'planList' }, ...sorted.map((p) => {
        const placed = placedOn(p).length;
        const review = toReview(p).length;
        const busyId = `planBusy-${p.id}`;
        const remove = el('button', { type: 'button', class: 'ghost small', 'aria-label': `Quitar el dibujo de ${planName(p)}`, disabled: placed > 0 || undefined, 'aria-describedby': placed ? busyId : undefined,
          'data-feedback-id': 'central.planos.dibujos.quitar', 'data-feedback-label': 'Quitar el dibujo', onclick: () => void removePlan(p) }, icon('trash', 16), 'Quitar');
        const replaceBtn = el('button', { type: 'button', class: 'ghost small', 'aria-label': `Sustituir el dibujo de ${planName(p)}`, 'data-feedback-id': 'central.planos.dibujos.sustituir', 'data-feedback-label': 'Sustituir el dibujo', onclick: () => openUpload(p) }, 'Sustituir');
        online.push(replaceBtn);
        if (!placed) online.push(remove);
        return el('li', { class: 'agentrow ctl-planrow', 'data-plan': p.id },
          el('div', null, el('strong', null, planName(p)),
            el('div', { class: 'muted small' }, [`${placed} ${placed === 1 ? 'colocada' : 'colocadas'}`, review ? `${review} por revisar` : 'todo colocado', pendingFile(p) ? 'dibujo pendiente de subir' : p.fileId ? null : 'sin dibujo'].filter(Boolean).join(' · ')),
            placed ? el('div', { class: 'muted small', id: busyId }, 'Tiene estancias encima: para quitarlo, quítalas antes del plano.') : null),
          el('span', { class: 'ctl-planactions' },
            el('button', { type: 'button', class: 'softbtn small', 'aria-label': `Colocar en ${planName(p)}`, 'data-feedback-id': 'central.planos.dibujos.colocar', 'data-feedback-label': 'Colocar', onclick: () => openEditor(p.id) }, 'Colocar'),
            replaceBtn,
            remove));
      })) : el('p', { class: 'hint' }, 'Aún no hay dibujos. Sube uno por edificio y planta (SVG, PNG o JPG).'));
    for (const b of online) binds.push(bindOnline(b, { client: r, line: why }));
  }

  /** Subir un dibujo nuevo, o sustituir uno (`plan`): las formas se conservan porque son relativas a la imagen. */
  function openUpload(plan: FloorPlan | null): void {
    let sheet: Sheet | null = null;
    const error = el('p', { class: 'formerror', role: 'alert' });
    const estateNow = plan ? isEstate(plan) : false;
    const kind = el('select', { id: 'planKind', 'data-field-id': 'central.planos.plan_kind', 'data-field-entity': 'resources.floor_plans', 'data-field-prop': 'kind', 'aria-label': 'Tipo de dibujo' },
      el('option', { value: 'building' }, 'Edificio o exterior'), el('option', { value: 'estate' }, 'Finca (el plano de todo el centro)')) as HTMLSelectElement;
    // La finca cuelga de un exterior raíz (Recursos 0814); un edificio o exterior, de lo demás.
    const buildingsOf = (k: string) => rows.filter((s) => s.active && (k === 'estate' ? s.kind === 'exterior' && !s.parentId : (s.kind === 'edificio' || s.kind === 'exterior'))).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const building = el('select', { id: 'planBuilding', 'data-field-id': 'central.planos.plan_building', 'data-field-entity': 'resources.floor_plans', 'data-field-prop': 'building_id', 'aria-label': 'Edificio' }) as HTMLSelectElement;
    const fillBuildings = () => replace(building, ...buildingsOf(kind.value).map((b) => el('option', { value: b.id }, spacePath(index(), b.id))));
    fillBuildings();
    kind.addEventListener('change', fillBuildings);
    // Escala: metros por unidad del dibujo. Del SVG si la trae (`data-meters-per-unit`); si no, se escribe (para decorar).
    const scale = el('input', { id: 'planScale', 'data-field-id': 'central.planos.plan_scale', 'data-field-entity': 'resources.floor_plans', 'data-field-prop': 'grid', type: 'number', step: 'any', min: '0', inputmode: 'decimal', placeholder: 'Del SVG si la trae',
      value: plan ? String(gridOfPlan(plan)?.metersPerUnit ?? '') : '' }) as HTMLInputElement;
    const floor = el('input', { id: 'planFloor', 'data-field-id': 'central.planos.plan_floor', 'data-field-entity': 'resources.floor_plans', 'data-field-prop': 'floor', type: 'text', maxlength: '40', placeholder: 'Planta baja', autocomplete: 'off' }) as HTMLInputElement;
    const file = el('input', { id: 'planFile', 'data-field-id': 'central.planos.plan_file', 'data-field-entity': 'resources.floor_plans', 'data-field-prop': 'file_id', type: 'file', accept: PLAN_MIME.join(',') }) as HTMLInputElement;
    const submit = el('button', { type: 'button', class: 'primary', id: 'planSubmit', 'data-feedback-id': 'central.planos.subir.guardar', 'data-feedback-label': 'Guardar el dibujo', onclick: async () => {
      error.textContent = '';
      const f = file.files?.[0];
      if (!f) { error.textContent = 'Elige el dibujo: SVG, PNG o JPG.'; return; }
      const mime = f.type || (f.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '');
      if (!PLAN_MIME.includes(mime)) { error.textContent = 'El dibujo debe ser SVG, PNG o JPG.'; return; }
      if (f.size > 10 * 1024 * 1024) { error.textContent = 'El dibujo pasa de 10 MB.'; return; }
      // Del SVG se sube el limpio (DOMPurify), nunca el original: el servidor rechaza el que lleve contenido activo.
      const raw = mime === 'image/svg+xml' ? await f.text() : null;
      const svgText = raw === null ? null : cleanSvg(raw);
      if (raw !== null && svgText === null) { error.textContent = activeContent(raw) ? ACTIVE_SVG : 'No se ha podido leer el dibujo. Prueba con otro archivo.'; return; }
      const blob: Blob = svgText !== null ? new Blob([svgText], { type: 'image/svg+xml' }) : f;
      const size = await imageSize(blob, svgText);
      if (!size) { error.textContent = 'No se ha podido leer el dibujo. Prueba con otro archivo.'; return; }
      if (!plan && !building.value) { error.textContent = kind.value === 'estate' ? 'Falta un exterior raíz en Recursos (la finca).' : 'Elige el edificio.'; return; }
      const estate = plan ? estateNow : kind.value === 'estate';
      const meta = svgText !== null ? estateMeta(svgText) : null;
      const typed = Number(scale.value.replace(',', '.'));
      const grid = scale.value.trim() ? (typed > 0 ? { metersPerUnit: typed, originX: meta?.originX ?? 0, originY: meta?.originY ?? 0 } : null) : (meta ? gridOf(meta) : null);
      if (scale.value.trim() && !grid) { error.textContent = 'La escala son los metros por unidad del dibujo: un número mayor que 0.'; return; }
      // En la finca, dónde va la cota de cada altura (sus trazados «Altura N»); las bandas no se guardan: el SVG ya las dibuja.
      const alturas = rows.filter((x) => x.kind === 'altura');
      const contours = estate && meta ? (meta.contours.length ? contoursFromCurves(meta.contours, alturas) : contoursFromBands(meta.bands, alturas)) : null;
      const extra: Record<string, unknown> = { ...(grid ? { grid } : {}), ...(contours && contours.length ? { contours } : {}) };
      submit.disabled = true;
      try {
        const sha = await r.stageBlob(blob, { filename: `plano.${mime === 'image/svg+xml' ? 'svg' : mime.split('/')[1]}`, mime });
        const id = plan?.id ?? crypto.randomUUID();
        const old = localUrls.get(id);
        if (old) URL.revokeObjectURL(old);
        localUrls.set(id, URL.createObjectURL(blob));
        if (plan) {
          const current = await r.get(PLANS, plan.id);
          await r.commit([{ op: 'update', table: PLANS, id, expectedRevision: Number(current?.revision ?? 0), fields: { file_id: { $blob: sha }, width: size.width, height: size.height, ...extra } }]);
        } else {
          await r.commit([{ op: 'insert', table: PLANS, id, fields: { building_id: building.value, floor: floor.value.trim() || null, position: plans.length, file_id: { $blob: sha }, width: size.width, height: size.height, kind: estate ? 'estate' : 'building', ...extra } }]);
        }
        void sheet?.close(true);
        toast(plan ? 'Dibujo sustituido: las estancias siguen en su sitio.' : estate ? `Finca subida${grid ? '' : ' (sin escala: ponla para decorar)'}.` : 'Dibujo subido.');
        // Si el SVG trae los nombres, se colocan solas las que aún no tienen forma (en la finca, los edificios).
        if (svgText !== null) setTimeout(() => autoPlace(id, svgText, !!plan), 0);
        openEditor(id);
      } catch (e) { error.textContent = describeError(e); } finally { submit.disabled = false; }
    } }, plan ? 'Sustituir' : 'Subir');
    const unbind = bindOnline(submit, { client: r, reason: 'El dibujo se sube con conexión.' });
    sheet = openSheet({
      title: plan ? `Sustituir el dibujo · ${planName(plan)}` : 'Subir un dibujo',
      body: el('div', { 'data-feedback-id': 'central.planos.subir.formulario', 'data-feedback-label': 'Dibujo' },
        plan ? el('p', { class: 'muted' }, 'Las estancias colocadas se conservan: su forma es relativa a la imagen. Si el dibujo nuevo cambia mucho, recolócalas.')
          : el('label', { class: 'field', 'data-feedback-id': 'central.planos.subir.tipo', 'data-feedback-label': 'Tipo de dibujo' }, el('span', null, 'Qué es'), kind),
        plan ? null : el('label', { class: 'field', 'data-feedback-id': 'central.planos.subir.edificio', 'data-feedback-label': 'Edificio' }, el('span', null, 'Edificio o finca'), building),
        plan ? null : el('label', { class: 'field', 'data-feedback-id': 'central.planos.subir.planta', 'data-feedback-label': 'Planta' }, el('span', null, 'Planta (opcional)'), floor),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.subir.archivo', 'data-feedback-label': 'Archivo del dibujo' }, el('span', null, 'Dibujo (SVG, PNG o JPG, hasta 10 MB)'), file),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.subir.escala', 'data-feedback-label': 'Escala del dibujo' }, el('span', null, 'Escala: metros por unidad del dibujo (opcional; hace falta para decorar)'), scale),
        el('p', { class: 'hint' }, 'Si es un SVG con los nombres de las estancias (o, en la finca, de los edificios), se colocan solas. De la finca se leen la escala y las alturas.'),
        error),
      panelAttrs: { 'data-feedback-id': 'central.planos.subir', 'data-feedback-label': 'Subir un dibujo' },
      closeAttrs: { 'data-feedback-id': 'central.planos.subir.cerrar', 'data-feedback-label': 'Cerrar' },
      foot: [submit],
      onClose: () => unbind(),
    });
  }

  async function removePlan(p: FloorPlan): Promise<void> {
    if (placedOn(p).length) { toast('Tiene estancias encima: quítalas antes del plano.'); return; }
    if (!(await confirmDialog({ title: `¿Quitar el dibujo de ${planName(p)}?`, text: 'Las estancias no se tocan. Se puede volver a subir.', confirmLabel: 'Quitar', danger: true }))) return;
    try {
      const current = await r.get(PLANS, p.id);
      await r.commit([{ op: 'delete', table: PLANS, id: p.id, expectedRevision: Number(current?.revision ?? 0) }]);
      if (editing === p.id) closeEditor();
      toast('Dibujo quitado.');
    } catch (e) { toast(describeError(e)); }
  }

  /**
   * «Colocar solo»: las estancias del edificio que el SVG nombra. Sustituyendo, solo las que no tenían forma. Las que
   * nombra pero no se pueden leer van a «Por revisar» con el motivo; el aviso dice qué nombres no son de ninguna estancia.
   */
  function autoPlace(planId: string, svgText: string, onlyMissing: boolean): void {
    const plan = plans.find((p) => p.id === planId) ?? { id: planId, buildingId: '', floor: null, position: 0, fileId: null, width: 1, height: 1 } as FloorPlan;
    const read = readSvgPlan(svgText);
    if (!read) { toast('Este dibujo no se puede leer: colócalas a mano.'); return; }
    const candidates = (plan.buildingId ? inside(plan) : rows.filter((s) => s.active && !CONTAINERS.has(s.kind)))
      .filter((s) => !onlyMissing || !(s.planId && validShape(s.planShape)));
    const { placed, skipped } = matchShapes(read, candidates);
    for (const { space, points } of placed) { reviewWhy.delete(space.id); setShape(space.id, planId, { points }); }
    for (const { space, reason } of skipped) reviewWhy.set(space.id, reason);
    // Lo que no coincide con ninguna estancia de Recursos (no solo con las candidatas), sin los nombres del programa.
    const known = new Set(rows.flatMap((s) => [s.name, s.publicName, s.code]).filter((k): k is string => !!k).map(foldName));
    const unknown = [...new Set(read.shapes.map((s) => s.name).filter((n) => !generatedName(n) && !known.has(foldName(n))))];
    unmatchedOf.set(planId, unknown);
    const left = plan.buildingId ? toReview(plan).length : 0;
    const head = placed.length ? `${placed.length} ${placed.length === 1 ? 'estancia colocada sola' : 'estancias colocadas solas'}${left ? `; ${left} por revisar` : ''}.`
      : skipped.length ? `Ninguna se ha colocado sola; ${skipped.length} por revisar.` : 'El dibujo no trae nombres de estancias: colócalas a mano.';
    toast(unknown.length ? `${head} ${unmatchedText(unknown)}` : head, unknown.length ? 9000 : 3200);
    paintEditor();
  }
  const unmatchedText = (names: string[]) => `Sin estancia con ese nombre: ${names.slice(0, UNMATCHED_SHOWN).map((n) => `«${n}»`).join(', ')}${names.length > UNMATCHED_SHOWN ? ` y +${names.length - UNMATCHED_SHOWN} más` : ''}.`;

  // --- Curvas de nivel de la finca (editables) ------------------------------------------------------------------------
  /** Las curvas de cada altura: los puntos ajustados a mano (`points`) o, si no los hay, los del SVG. */
  function curvesOf(plan: FloorPlan): Array<{ spaceId: string; name: string; points: Array<[number, number]>; anchor: [number, number] }> {
    const raw = planRow(plan.id)?.contours;
    const fromSvg = svgCurves.get(plan.id) ?? [];
    const saved = Array.isArray(raw) ? raw as Array<{ spaceId: string; x: number; y: number; points?: Array<[number, number]> }> : [];
    const ids = [...new Set([...saved.map((c) => c.spaceId), ...fromSvg.map((c) => c.spaceId)])];
    return ids.flatMap((id) => {
      const a = rows.find((x) => x.id === id);
      const own = saved.find((c) => c.spaceId === id);
      const svg = fromSvg.find((c) => c.spaceId === id);
      const points = own?.points && own.points.length >= 2 ? own.points : svg?.points ?? [];
      return a && points.length >= 2 ? [{ spaceId: id, name: a.name, points, anchor: [own?.x ?? svg?.anchor[0] ?? 0.02, own?.y ?? svg?.anchor[1] ?? 0.5] as [number, number] }] : [];
    });
  }
  /** Lee una vez las curvas del SVG de la finca (para enseñarlas antes de ajustarlas). */
  async function loadSvgCurves(plan: FloorPlan): Promise<void> {
    if (svgCurves.has(plan.id) || !isEstate(plan) || typeof plan.fileId !== 'string') return;
    svgCurves.set(plan.id, []);
    try {
      const local = localUrls.get(plan.id);
      const text = await (await fetch(local ?? await r.fileUrl(plan.fileId))).text();
      const meta = estateMeta(text);
      const alturas = rows.filter((x) => x.kind === 'altura');
      const anchors = contoursFromCurves(meta.contours, alturas);
      svgCurves.set(plan.id, meta.contours.flatMap((c) => {
        const at = anchors.find((x) => alturas.find((a) => a.id === x.spaceId && (c.name === a.name || c.name.startsWith(`${a.name} `))));
        return at ? [{ spaceId: at.spaceId, name: c.name, points: c.points, anchor: [at.x, at.y] as [number, number] }] : [];
      }));
      if (alive && editing === plan.id) paintEditor();
    } catch { svgCurves.delete(plan.id); }
  }
  /** Guarda la curva de una altura con sus puntos nuevos, y «Deshacer» devuelve todas las curvas como estaban. */
  async function saveCurve(plan: FloorPlan, spaceId: string, points: Array<[number, number]>, anchor: [number, number], name: string): Promise<void> {
    try {
      const current = await r.get(PLANS, plan.id);
      const before = (current as Record<string, unknown> | null)?.contours ?? null;
      await r.commit([{ op: 'update', table: PLANS, id: plan.id, expectedRevision: Number(current?.revision ?? 0), fields: { contours: withContourPoints(before, spaceId, points, anchor) } }]);
      toastWithAction(`Curva de «${name}» ajustada.`, { label: 'Deshacer', onClick: () => void (async () => {
        try { const now = await r.get(PLANS, plan.id); await r.commit([{ op: 'update', table: PLANS, id: plan.id, expectedRevision: Number(now?.revision ?? 0), fields: { contours: before } }]); }
        catch (e) { toast(describeError(e)); }
      })() });
    } catch (e) { toast(describeError(e)); paintEditor(); }
  }
  /** Pinta las curvas de la finca en el SVG de «Colocar», con un asa por punto (ratón y teclado). */
  function drawCurves(svg: SVGSVGElement, plan: FloorPlan): SVGElement[] {
    const NS = 'http://www.w3.org/2000/svg';
    const w = plan.width; const h = plan.height;
    const out: SVGElement[] = [];
    const r0 = Math.max(w, h) * 0.008;
    for (const c of curvesOf(plan)) {
      const line = document.createElementNS(NS, 'polyline');
      const attr = (pts: Array<[number, number]>) => pts.map(([x, y]) => `${(x * w).toFixed(1)},${(y * h).toFixed(1)}`).join(' ');
      line.setAttribute('points', attr(c.points));
      line.setAttribute('class', 'ctl-contour');
      line.setAttribute('data-contour-for', c.spaceId);
      line.setAttribute('aria-hidden', 'true');
      out.push(line);
      // El nombre de la altura y su cota (o «sin cota»), en el ancla de la curva.
      const a = rows.find((x) => x.id === c.spaceId);
      const m = a ? elevationOf(a) : null;
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(c.anchor[0] * w)); label.setAttribute('y', String(c.anchor[1] * h - r0 * 1.6));
      label.setAttribute('class', 'ctl-contourlabel');
      label.setAttribute('data-contour-label', c.spaceId);
      label.setAttribute('font-size', String(Math.max(w, h) * 0.022));
      label.textContent = `${c.name} · ${m === null ? 'sin cota' : `${String(m).replace('.', ',')} m`}`;
      out.push(label);
      let pts = c.points.map(([x, y]) => [x, y] as [number, number]);
      pts.forEach((pt, i) => {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', String(pt[0] * w)); dot.setAttribute('cy', String(pt[1] * h)); dot.setAttribute('r', String(r0));
        dot.setAttribute('class', 'ctl-contourpt');
        dot.setAttribute('tabindex', '0');
        dot.setAttribute('role', 'button');
        dot.setAttribute('data-contour-point', `${c.spaceId}:${i}`);
        dot.setAttribute('aria-label', `Punto ${i + 1} de ${pts.length} de la curva de ${c.name}: con las flechas se mueve`);
        dot.addEventListener('keydown', (e) => {
          const step = e.altKey ? 0.001 : 0.005;
          const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as [number, number] | undefined;
          if (!d) return;
          e.preventDefault();
          pts = movePoint(pts, i, d[0], d[1]);
          dot.setAttribute('cx', String(pts[i]![0] * w)); dot.setAttribute('cy', String(pts[i]![1] * h));
          line.setAttribute('points', attr(pts));
          void saveCurve(plan, c.spaceId, pts, c.anchor, c.name);
        });
        dot.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          const box = svg.getBoundingClientRect();
          const start = pts.map(([x, y]) => [x, y] as [number, number]);
          const x0 = e.clientX; const y0 = e.clientY;
          dot.setPointerCapture?.(e.pointerId);
          const move = (ev: PointerEvent) => {
            pts = movePoint(start, i, (ev.clientX - x0) / box.width, (ev.clientY - y0) / box.height);
            dot.setAttribute('cx', String(pts[i]![0] * w)); dot.setAttribute('cy', String(pts[i]![1] * h));
            line.setAttribute('points', attr(pts));
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            if (pts.some(([x, y], n) => x !== start[n]![0] || y !== start[n]![1])) void saveCurve(plan, c.spaceId, pts, c.anchor, c.name);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });
        out.push(dot);
      });
    }
    return out;
  }

  // --- Colocar a mano ---------------------------------------------------------------------------------------------
  let selected: string | null = null;
  /**
   * Enlace profundo (tarjetas de Flow y de VG): `#/entidad/planos?colocar=Albergue` abre «Colocar» en el dibujo de ese
   * edificio (por nombre, nombre público o código, sin tildes ni mayúsculas; con planta, «Albergue · Baja»). Una sola vez,
   * cuando ya están los dibujos; solo el owner y en el ordenador, como «Colocar».
   */
  function openWanted(): void {
    if (wanted === null || !alive || !canPlace() || !media.matches || !plans.length || !rows.length) return;
    const key = foldName(wanted);
    const named = (p: FloorPlan) => {
      const b = rows.find((s) => s.id === p.buildingId);
      return [foldName(planName(p)), ...[b?.name, b?.publicName, b?.code].filter((k): k is string => !!k).map(foldName)];
    };
    const plan = plans.find((p) => named(p).includes(key));
    wanted = null;
    if (plan) openEditor(plan.id); else toast(`No hay ningún dibujo de «${wantedText}». Súbelo con «Subir un dibujo».`);
  }

  function openEditor(planId: string): void { editing = planId; selected = null; tab = 'estancias'; editor.hidden = false; paintEditor(); editor.scrollIntoView({ block: 'start' }); }
  function closeEditor(): void { for (const b of editorBinds.splice(0)) b(); decorMap?.destroy(); decorMap = null; editing = null; selected = null; editor.hidden = true; replace(editor); }
  const tabBar = (plan: FloorPlan) => el('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Qué colocar', id: 'placeTabs', 'data-feedback-id': 'central.planos.colocar.pestanas', 'data-feedback-label': 'Estancias o decoración' },
    ...([['estancias', isEstate(plan) ? 'Edificios' : 'Estancias'], ['decoracion', 'Decoración']] as const).map(([k, label]) => el('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', dataset: { tab: k },
      onclick: () => { if (tab !== k) { tab = k; decorMap?.destroy(); decorMap = null; paintEditor(); } } }, label)));

  function paintEditor(): void {
    if (!editing || !alive) return;
    const plan = plans.find((p) => p.id === editing);
    if (!plan || !canPlace() || !media.matches) { closeEditor(); return; }
    if (tab === 'decoracion') { paintDecorEditor(); return; }
    for (const b of editorBinds.splice(0)) b();
    // Repintar no quita el foco: si estaba en una estancia (o en un botón con su id), vuelve a ella.
    const focused = editor.contains(document.activeElement) ? (document.activeElement as HTMLElement | SVGElement | null) : null;
    const focusKey = focused?.getAttribute('data-space-id') ? `[data-space-id="${CSS.escape(focused.getAttribute('data-space-id')!)}"]` : focused?.id ? `#${CSS.escape(focused.id)}` : null;
    const w = plan.width; const h = plan.height;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'ctl-placesvg');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `Colocar en ${planName(plan)}`);
    const paper = document.createElementNS(NS, 'rect');
    paper.setAttribute('width', String(w)); paper.setAttribute('height', String(h)); paper.setAttribute('class', 'ctl-placepaper');
    svg.append(paper);
    if (plan.fileId) {
      const image = document.createElementNS(NS, 'image');
      image.setAttribute('width', String(w)); image.setAttribute('height', String(h)); image.setAttribute('preserveAspectRatio', 'none');
      // El SVG va como imagen: nunca se mete en la página. Recién subido, desde este dispositivo.
      const local = localUrls.get(plan.id);
      if (local) image.setAttribute('href', local);
      else if (typeof plan.fileId === 'string') {
        const fileId = plan.fileId;
        const known = planUrls.get(fileId);
        if (known) image.setAttribute('href', known);
        else void r.fileUrl(fileId).then((u) => { planUrls.set(fileId, u); image.setAttribute('href', u); }).catch(() => undefined);
      }
      svg.append(image);
    }
    if (!isEstate(plan) && plan.fileId && !svgShapes.has(plan.id)) void loadSvgShapes(plan);
    const shapesHere = svgShapes.get(plan.id);
    const drawn = Array.isArray(shapesHere) ? shapesHere : [];
    // Las formas del dibujo que aún no son de ninguna estancia, en discontinuo con su nombre.
    const numbers: SVGTextElement[] = [];
    drawn.forEach((shape, i) => {
      const held = holderOf(plan, shape);
      const ghost = document.createElementNS(NS, 'polygon');
      ghost.setAttribute('points', shape.points.map(([x, y]) => `${x * w},${y * h}`).join(' '));
      ghost.setAttribute('class', `ctl-placeghost${held ? ' held' : ''}${lit === shape.name ? ' lit' : ''}`);
      ghost.setAttribute('data-svg-shape', shape.name);
      ghost.setAttribute('aria-hidden', 'true');
      // Tocar una forma del dibujo lleva a su fila, para decir qué estancia es.
      ghost.addEventListener('click', () => {
        const select = editor.querySelector<HTMLSelectElement>(`#placeShapes [data-shape-row="${CSS.escape(shape.name)}"] select`);
        select?.scrollIntoView({ block: 'center' }); select?.focus();
      });
      svg.append(ghost);
      const xs = shape.points.map((pt) => pt[0]); const ys = shape.points.map((pt) => pt[1]);
      const num = document.createElementNS(NS, 'text');
      num.setAttribute('x', String(((Math.min(...xs) + Math.max(...xs)) / 2) * w));
      num.setAttribute('y', String(((Math.min(...ys) + Math.max(...ys)) / 2) * h));
      num.setAttribute('class', 'ctl-placenum');
      num.setAttribute('font-size', String(Math.max(w, h) * 0.022));
      num.setAttribute('aria-hidden', 'true');
      num.textContent = String(i + 1);
      numbers.push(num);
    });
    const placed = placedOn(plan);
    const labels: SVGTextElement[] = [];
    const handles: SVGRectElement[] = [];
    // Primero las estancias y después las camas, encima de su habitación: se ven, pero no se tocan (se mueven en Booking).
    for (const s of [...placed.filter((x) => x.kind !== 'cama'), ...placed.filter((x) => x.kind === 'cama')]) {
      const shape = s.planShape as PlanShape;
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', pointsAttr(shape, plan));
      if (s.kind === 'cama') {
        poly.setAttribute('class', 'ctl-placeshape bed');
        poly.setAttribute('data-space-id', s.id);
        poly.setAttribute('aria-hidden', 'true');
        svg.append(poly);
        continue;
      }
      poly.setAttribute('class', `ctl-placeshape${selected === s.id ? ' on' : ''}`);
      poly.setAttribute('tabindex', '0');
      poly.setAttribute('role', 'button');
      poly.setAttribute('data-space-id', s.id);
      poly.setAttribute('aria-label', `${s.name}: con las flechas se mueve; con Mayúsculas y las flechas, se estira`);
      poly.setAttribute('aria-pressed', String(selected === s.id));
      poly.addEventListener('pointerdown', (e) => startDrag(e, s, 'move', plan, svg));
      poly.addEventListener('keydown', (e) => onKey(e, s, plan));
      poly.addEventListener('focus', () => { if (selected !== s.id) { selected = s.id; paintEditor(); svg.ownerDocument.querySelector<SVGElement>(`#placeEditor [data-space-id="${CSS.escape(s.id)}"]`)?.focus(); } });
      svg.append(poly);
      const c = shapeCenter(shape);
      const label = document.createElementNS(NS, 'text');
      const fontSize = Math.max(Math.min(c.w * w, c.h * h) * 0.22, Math.max(w, h) * 0.012);
      label.setAttribute('x', String(c.x * w)); label.setAttribute('y', String(c.y * h)); label.setAttribute('class', 'ctl-placelabel');
      label.setAttribute('font-size', String(fontSize));
      // El halo del rótulo sobre el dibujo, el de la pieza del kit: proporcional a la letra, porque el dibujo escala.
      label.setAttribute('stroke-width', String(fontSize * 0.2));
      label.setAttribute('aria-hidden', 'true');
      label.setAttribute('data-label-for', s.id);
      label.textContent = s.kind === 'cama' ? (s.code ?? s.name) : s.name;
      labels.push(label);
      if (selected === s.id) {
        const b = boxOf(shape);
        for (const [hx, hy, ax, ay] of [[b.x0, b.y0, b.x1, b.y1], [b.x1, b.y0, b.x0, b.y1], [b.x1, b.y1, b.x0, b.y0], [b.x0, b.y1, b.x1, b.y0]] as const) {
          const handle = document.createElementNS(NS, 'rect');
          const size = Math.max(w, h) * 0.014;
          handle.setAttribute('x', String(hx * w - size / 2)); handle.setAttribute('y', String(hy * h - size / 2));
          handle.setAttribute('width', String(size)); handle.setAttribute('height', String(size)); handle.setAttribute('class', 'ctl-placehandle');
          handle.setAttribute('aria-hidden', 'true');
          handle.addEventListener('pointerdown', (e) => startDrag(e, s, [ax, ay], plan, svg));
          handles.push(handle);
        }
      }
    }
    // Los rótulos, encima de todas las formas (el de una habitación no queda bajo sus camas), y las esquinas para estirar,
    // encima de todo: si no, la estancia de al lado las tapaba.
    if (isEstate(plan)) { void loadSvgCurves(plan); svg.append(...drawCurves(svg, plan)); }
    svg.append(...labels, ...numbers, ...handles);
    const review = toReview(plan);
    // Las camas no se eligen ni se quitan: van con su habitación (su sitio es de Booking).
    const rooms = placed.filter((s) => s.kind !== 'cama');
    const current = selected ? rows.find((s) => s.id === selected && s.kind !== 'cama') ?? null : null;
    // Un solo paso a la vista: colocar lo que falta o, si ya está todo, revisarlo.
    const unassigned = (Array.isArray(svgShapes.get(plan.id)) ? svgShapes.get(plan.id) as SvgShape[] : []).filter((x) => !holderOf(plan, x)).length;
    const step = isEstate(plan) ? null : unassigned
      ? `Paso 2 de 3 · Di qué estancia es cada forma del dibujo (${unassigned} sin estancia).`
      : review.length
      ? `Paso 2 de 3 · Coloca ${review.length === 1 ? 'la estancia que falta' : `las ${review.length} estancias que faltan`}: «Poner» o «Colocar solo».`
      : 'Paso 3 de 3 · Todo tiene su sitio. Revisa el dibujo y, si algo no cuadra, arrástralo.';
    const unknown = unmatchedOf.get(plan.id) ?? [];
    const autoBtn = el('button', { type: 'button', class: 'ghost', id: 'autoPlace', 'data-feedback-id': 'central.planos.colocar.solo', 'data-feedback-label': 'Colocar solo', onclick: () => void autoFromFile(plan) }, 'Colocar solo (SVG con nombres)');
    const candidates = inside(plan).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const pendingShapes = drawn.filter((x) => !holderOf(plan, x));
    const shapeRow = (shape: SvgShape, index: number) => {
      const holder = holderOf(plan, shape);
      const select = el('select', { 'aria-label': `Qué estancia es la forma ${index + 1} («${shape.name}»)`, 'data-svg-shape': shape.name },
        el('option', { value: '' }, 'Elige qué estancia es'),
        ...candidates.map((c) => el('option', { value: c.id, selected: holder?.id === c.id }, c.name)),
        el('option', { value: NEW_SPACE }, 'Otra: escribir el nombre…')) as HTMLSelectElement;
      select.addEventListener('change', () => {
        if (select.value === NEW_SPACE) { select.value = holder?.id ?? ''; newSpaceFor(plan, shape); return; }
        if (select.value) assignShape(plan, shape, select.value);
      });
      const light = (on: boolean) => { lit = on ? shape.name : null; editor.querySelector(`[data-svg-shape="${CSS.escape(shape.name)}"].ctl-placeghost`)?.classList.toggle('lit', on); };
      select.addEventListener('focus', () => light(true));
      select.addEventListener('blur', () => light(false));
      const create = holder ? null : el('button', { type: 'button', class: 'softbtn small', 'aria-label': `Crear la estancia «${shape.name.replace(/[_-]+/g, ' ')}»`,
        'data-feedback-id': 'central.planos.colocar.crear_estancia', 'data-feedback-label': 'Crear la estancia con el nombre del dibujo', onclick: () => newSpaceFor(plan, shape) },
        icon('plus', 16), `Crear «${shape.name.replace(/[_-]+/g, ' ')}»`);
      const rename = holder && foldName(holder.name) !== foldName(shape.name.replace(/[_-]+/g, ' '))
        ? el('button', { type: 'button', class: 'linkbtn small', 'data-feedback-id': 'central.planos.colocar.renombrar', 'data-feedback-label': 'Renombrar como en el dibujo', onclick: () => void renameTo(holder, shape.name.replace(/[_-]+/g, ' ')) }, `Llamarla «${shape.name.replace(/[_-]+/g, ' ')}»`)
        : null;
      const manage = holder ? el('div', { class: 'ctl-shapetools' },
        el('button', { type: 'button', class: 'linkbtn small', 'aria-label': `Renombrar ${holder.name}`, 'data-feedback-id': 'central.planos.colocar.renombrar_estancia', 'data-feedback-label': 'Renombrar la estancia', onclick: () => renameSpace(holder) }, 'Renombrar'),
        el('button', { type: 'button', class: 'linkbtn small', 'aria-label': `Dar de baja ${holder.name}`, 'data-feedback-id': 'central.planos.colocar.baja_estancia', 'data-feedback-label': 'Dar de baja la estancia', onclick: () => void archiveSpace(holder) }, 'Dar de baja')) : null;
      const row = el('li', { class: `ctl-shaperow${holder ? '' : ' warn'}`, 'data-shape-row': shape.name },
        el('div', { class: 'ctl-shapehead' }, el('span', { class: 'ctl-shapenum', 'aria-hidden': 'true' }, String(index + 1)),
          el('span', null, el('strong', null, holder ? holder.name : 'Sin estancia'), el('span', { class: 'muted small' }, ` · en el dibujo «${shape.name.replace(/[_-]+/g, ' ')}»`))),
        select, create, rename, manage);
      row.addEventListener('mouseenter', () => light(true));
      row.addEventListener('mouseleave', () => light(false));
      return row;
    };
    const dupes = [...candidates.reduce((m, c) => m.set(foldName(c.name), [...(m.get(foldName(c.name)) ?? []), c]), new Map<string, SpaceRow[]>()).values()].filter((l) => l.length > 1);
    const missing = el('details', { class: 'ctl-placemissing', id: 'placeMissing', open: missingOpen ?? (!drawn.length || !pendingShapes.length),
      'data-feedback-id': 'central.planos.colocar.falta', 'data-feedback-label': '¿Falta alguna?' }) as HTMLDetailsElement;
    missing.addEventListener('toggle', () => { missingOpen = missing.open; });
    const fill = (node: HTMLElement, ...kids: Array<Parameters<typeof replace>[1]>) => { replace(node, ...kids); return node; };
    replace(editor,
      el('div', { class: 'blockhead' }, el('h3', null, `Colocar · ${planName(plan)}`),
        el('span', { class: 'muted small', id: 'placeSaved', role: 'status', 'aria-live': 'polite', 'data-feedback-id': 'central.planos.colocar.guardado', 'data-feedback-label': 'Estado del guardado' }, saveState || 'Se guarda solo'),
        el('button', { type: 'button', class: 'linkbtn', id: 'closePlace', 'data-feedback-id': 'central.planos.colocar.cerrar', 'data-feedback-label': 'Cerrar Colocar', onclick: () => closeEditor() }, 'Cerrar')),
      tabBar(plan),
      step ? el('p', { class: 'ctl-placestep', id: 'placeStep', 'data-feedback-id': 'central.planos.colocar.paso', 'data-feedback-label': 'Paso de Colocar' }, step) : null,
      isEstate(plan) ? null : el('p', { class: 'ctl-placebeds', id: 'placeBeds', 'data-feedback-id': 'central.planos.colocar.camas', 'data-feedback-label': 'Camas de Booking' },
        icon('info', 16), layouts.length ? ' Las camas salen como están en Booking y van con su habitación. ' : ' Aún no se ven camas: Booking todavía no ha dado su sitio (o no tienen sitio en Booking). Cuando lo dé, saldrán solas dentro de su habitación. ',
        el('a', { href: BOOKING_BEDS_URL, target: '_blank', rel: 'noopener', id: 'placeBedsLink', 'data-feedback-id': 'central.planos.colocar.camas_booking', 'data-feedback-label': 'Mover camas en Booking' }, 'Moverlas en Booking › Espacios y camas')),
      el('details', { class: 'ctl-placehelp', 'data-feedback-id': 'central.planos.colocar.ayuda', 'data-feedback-label': 'Cómo se coloca' },
        el('summary', null, 'Cómo se coloca'),
        el('p', { class: 'hint' }, isEstate(plan) ? 'Arrastra un edificio para moverlo y sus esquinas para estirarlo. Las curvas de nivel se ajustan arrastrando sus puntos (o con Tab y las flechas). Se guarda solo.'
          : 'Arrastra una estancia para moverla y sus esquinas para estirarla. Con el teclado: Tab hasta la estancia, las flechas la mueven y, con Mayúsculas, la estiran. Se guarda solo.')),
      el('div', { class: 'ctl-place' },
        el('div', { class: 'ctl-placestage' }, svg),
        el('div', { class: 'ctl-placeside' },
          dupes.length ? el('p', { class: 'note', id: 'placeDuplicates', 'data-feedback-id': 'central.planos.colocar.repetidas', 'data-feedback-label': 'Estancias repetidas' },
            icon('info', 16), ` Hay estancias repetidas: ${dupes.map((l) => `«${l[0]!.name}» (${l.length})`).join(', ')}. Si sobra una, quítala del plano aquí y bórrala en Booking › Espacios y camas.`) : null,
          shapesHere === 'loading' ? el('p', { class: 'muted', id: 'placeShapesLoading' }, 'Leyendo las formas del dibujo…') : null,
          drawn.length ? el('h4', { class: 'sectionlabel', id: 'placeShapesHead' }, `Formas del dibujo · ${pendingShapes.length ? `${pendingShapes.length} sin estancia` : 'todas con su estancia'}`) : null,
          drawn.length ? el('p', { class: 'muted small' }, 'Cada número es una forma del dibujo. Elige qué estancia es; si no está en la lista, «Otra» y escribe su nombre. También puedes tocar la forma en el dibujo.') : null,
          drawn.length ? el('div', { id: 'placeShapes', 'data-feedback-id': 'central.planos.colocar.formas', 'data-feedback-label': 'Formas del dibujo' },
            pendingShapes.length
              ? el('ul', { class: 'ctl-shapes' }, ...drawn.map((x, i) => [x, i] as const).filter(([x]) => !holderOf(plan, x)).map(([x, i]) => shapeRow(x, i)))
              : el('p', { class: 'hint' }, icon('check', 16), ' Todas las formas del dibujo tienen su estancia.'),
            drawn.length > pendingShapes.length ? el('details', { class: 'ctl-shapesdone', id: 'placeShapesDone', open: pendingShapes.length === 0 },
              el('summary', null, `Con su estancia (${drawn.length - pendingShapes.length})`),
              el('ul', { class: 'ctl-shapes compact' }, ...drawn.map((x, i) => [x, i] as const).filter(([x]) => !!holderOf(plan, x)).map(([x, i]) => shapeRow(x, i)))) : null) : null,
          current ? el('div', { class: 'toolbar' }, el('button', { type: 'button', class: 'ghost', id: 'unplace', 'data-feedback-id': 'central.planos.colocar.quitar', 'data-feedback-label': 'Quitar del plano', onclick: () => unplace(current) }, `Quitar «${current.name}» del plano`)) : null,
          fill(missing, el('summary', null, drawn.length ? `¿Falta alguna? Ponla en el dibujo (${review.length})` : `Por revisar · ${review.length}`),
          el('div', { class: 'toolbar' }, autoBtn),
          unknown.length ? el('p', { class: 'hint', id: 'placeUnmatched' }, icon('info', 16), ` ${unmatchedText(unknown)} Elige arriba qué estancia es cada una o vuelve a «Colocar solo».`) : null,
          el('h4', { class: 'sectionlabel', id: 'placeReviewHead' }, `Por revisar · ${review.length}`),
          review.length ? el('ul', { class: 'list', id: 'placeReview' }, ...review.map((s) => el('li', { class: 'agentrow', 'data-space': s.id },
            el('span', null, el('strong', null, s.name), el('span', { class: 'muted small' }, ` · ${s.parentId ? spacePath(index(), s.parentId) : ''}`),
              reviewWhy.has(s.id) ? el('span', { class: 'muted small ctl-placewhy', id: `placeWhy-${s.id}` }, `No se ha colocado sola: ${reviewWhy.get(s.id)}.`) : null),
            el('button', { type: 'button', class: 'ghost small', 'aria-label': `Poner ${s.name} en el plano`, 'aria-describedby': reviewWhy.has(s.id) ? `placeWhy-${s.id}` : undefined,
              'data-feedback-id': 'central.planos.colocar.poner', 'data-feedback-label': 'Poner en el plano', onclick: () => putOn(s, plan) }, 'Poner'))))
            : el('p', { class: 'hint' }, 'Todas las estancias de este edificio tienen su sitio.')),
          el('h4', { class: 'sectionlabel' }, `En el plano · ${rooms.length}`),
          rooms.length ? el('ul', { class: 'list', id: 'placePlaced' }, ...rooms.map((s) => el('li', null,
            el('button', { type: 'button', class: `linkbtn${selected === s.id ? ' on' : ''}`, 'data-space': s.id, 'data-feedback-id': 'central.planos.colocar.elegir', 'data-feedback-label': 'Elegir estancia', onclick: () => { selected = s.id; paintEditor(); } }, s.name)))) : null)));
    // «Colocar solo» lee el dibujo del servidor: sin red, apagado con su motivo.
    editorBinds.push(bindOnline(autoBtn, { client: r, reason: 'Colocar solo lee el dibujo con conexión.' }));
    if (focusKey) editor.querySelector<HTMLElement | SVGElement>(focusKey)?.focus({ preventScroll: true });
  }

  /**
   * Pestaña Decoración: la pieza del kit con `decorEdit` sobre este dibujo (icono, tamaño 1 o 4, escala 5 · 1 · 0,5 m,
   * poner, arrastrar por celdas, girar y quitar). Cada cambio va a Recursos con su «Deshacer». Al lado: la escala del dibujo
   * (sin ella no se decora), el catálogo de iconos y, en la finca, la cota de cada altura.
   */
  function paintDecorEditor(): void {
    if (!editing || tab !== 'decoracion' || !alive) return;
    const plan = plans.find((p) => p.id === editing);
    if (!plan || !canPlace() || !media.matches) { closeEditor(); return; }
    const grid = gridOfPlan(plan);
    if (decorMap && grid) { decorMap.setDecor(decorOf(plan.id)); paintDecorSide(plan); return; }
    for (const b of editorBinds.splice(0)) b();
    decorMap?.destroy(); decorMap = null;
    const stage = el('div', { class: 'ctl-placestage', id: 'decorStage' });
    const side = el('div', { class: 'ctl-placeside', id: 'decorSide' });
    replace(editor,
      el('div', { class: 'blockhead' }, el('h3', null, `Colocar · ${planName(plan)}`),
        el('button', { type: 'button', class: 'linkbtn', id: 'closePlace', 'data-feedback-id': 'central.planos.colocar.cerrar', 'data-feedback-label': 'Cerrar Colocar', onclick: () => closeEditor() }, 'Cerrar')),
      tabBar(plan),
      el('p', { class: 'hint' }, grid ? 'Elige un icono, su tamaño y la escala; toca el plano para ponerlo. Arrástralo de celda en celda; seleccionado, las flechas lo mueven, R lo gira y Supr lo quita. Se guarda solo.'
        : 'Para decorar, este dibujo necesita su escala: los metros por unidad. Escríbela al lado.'),
      el('div', { class: 'ctl-place' }, stage, side));
    if (grid) {
      decorMap = createSpaceMap({
        source: spaces, label: `Decoración · ${planName(plan)}`, feedbackId: 'central.planos.decoracion',
        plans: { list: async () => (await spaces.plans.list()).filter((x) => x.id === plan.id).map(enrich) },
        planUrl: (fileId) => r.fileUrl(fileId),
        plan: plan.id,
        decor: decorOf(plan.id),
        decorEdit: { icons: kitIcons(), scale: decorScale, onDecorChange: (change) => void onDecor(change) },
      });
      replace(stage, decorMap.element);
    }
    paintDecorSide(plan);
  }

  /** Un cambio de la pieza: a Recursos, y «Deshacer» con la operación contraria. */
  async function onDecor(change: KitDecorChange): Promise<void> {
    decorScale = change.item.scale;
    const before = items.find((x) => x.id === change.item.id && !x.deleted_at) ?? null;
    const ops = decorOperations({ type: change.type, item: { ...change.item, iconId: change.item.iconId ?? '' } }, before);
    if (!ops) return;
    try {
      await r.commit([ops.op]);
      const what = { add: 'Puesto', move: 'Movido', rotate: 'Girado', remove: 'Quitado' }[change.type];
      toastWithAction(`${what} «${change.item.label ?? 'objeto'}».`, { label: 'Deshacer', onClick: () => void (async () => {
        try { const now = await r.get(ITEMS, change.item.id); await r.commit([ops.undo(Number(now?.revision ?? 0))]); }
        catch (e) { toast(describeError(e)); }
      })() });
    } catch (e) {
      toast(describeError(e));
      decorMap?.setDecor(decorOf(change.item.planId));
    }
  }

  function paintDecorSide(plan: FloorPlan): void {
    const side = editor.querySelector<HTMLElement>('#decorSide');
    if (!side) return;
    for (const b of editorBinds.splice(0)) b();
    const grid = gridOfPlan(plan);
    const scaleIn = el('input', { id: 'decorPlanScale', 'data-field-id': 'central.planos.decor_plan_scale', 'data-field-entity': 'resources.floor_plans', 'data-field-prop': 'grid', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: grid ? String(grid.metersPerUnit) : '', 'aria-describedby': 'decorScaleHelp' }) as HTMLInputElement;
    const saveScale = el('button', { type: 'button', class: 'ghost small', id: 'saveDecorScale', 'data-feedback-id': 'central.planos.decoracion.guardar_escala', 'data-feedback-label': 'Guardar la escala', onclick: async () => {
      const v = Number(scaleIn.value.replace(',', '.'));
      if (!(v > 0)) { toast('La escala son los metros por unidad del dibujo: un número mayor que 0.'); return; }
      try {
        const current = await r.get(PLANS, plan.id);
        await r.commit([{ op: 'update', table: PLANS, id: plan.id, expectedRevision: Number(current?.revision ?? 0), fields: { grid: { metersPerUnit: v, originX: grid?.originX ?? 0, originY: grid?.originY ?? 0 } } }]);
        toast('Escala guardada.');
      } catch (e) { toast(describeError(e)); }
    } }, 'Guardar');
    const newIcon = el('button', { type: 'button', class: 'primary small', id: 'newDecorIcon', 'data-feedback-id': 'central.planos.decoracion.subir_icono', 'data-feedback-label': 'Subir un icono', onclick: () => openIconUpload() }, icon('upload', 16), 'Subir un icono');
    editorBinds.push(bindOnline(newIcon, { client: r, reason: 'Los iconos se suben con conexión.' }));
    const live = icons.filter((i) => !i.deleted_at).sort((a, b) => a.category.localeCompare(b.category, 'es') || a.name.localeCompare(b.name, 'es'));
    const alturas = rows.filter((s) => s.kind === 'altura' && s.active).sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
    const lines = isEstate(plan) ? elevationLines(alturas.map((a) => ({ name: a.name, y0: 0, y1: 0 })), alturas.map((a) => ({ name: a.name, elevation_m: elevationOf(a) }))) : [];
    replace(side,
      el('h4', { class: 'sectionlabel' }, 'Escala del dibujo'),
      el('label', { class: 'field', 'data-feedback-id': 'central.planos.decoracion.escala', 'data-feedback-label': 'Escala del dibujo' }, el('span', null, 'Metros por unidad'), scaleIn),
      el('p', { class: 'hint', id: 'decorScaleHelp' }, 'En un SVG a escala 1:1, 1. Sin escala no se puede decorar.'),
      saveScale,
      el('h4', { class: 'sectionlabel' }, `Iconos · ${live.length}`),
      newIcon,
      live.length ? el('ul', { class: 'list ctl-decoricons', id: 'decorIcons' }, ...live.map((i) => {
        const url = iconUrl(i.id);
        return el('li', { class: 'agentrow', dataset: { icon: i.id } },
          el('span', { class: 'ctl-decoricon' }, url ? el('img', { src: url, alt: '', width: '32', height: '32' }) : null),
          el('span', null, el('strong', null, i.name), el('span', { class: 'muted small' }, ` · ${i.category} · ${i.default_size === 4 ? '4 celdas' : '1 celda'}`)),
          el('button', { type: 'button', class: 'ghost small', 'aria-label': `Quitar el icono ${i.name}`, 'data-feedback-id': 'central.planos.decoracion.quitar_icono', 'data-feedback-label': 'Quitar el icono', onclick: () => void removeIcon(i) }, icon('trash', 16)));
      })) : el('p', { class: 'hint' }, 'Aún no hay iconos. Sube uno (SVG, PNG o GIF, visto desde arriba).'),
      isEstate(plan) ? el('h4', { class: 'sectionlabel' }, 'Cota de cada altura') : null,
      isEstate(plan) ? el('ul', { class: 'list', id: 'decorElevations' }, ...alturas.map((a, n) => {
        const input = el('input', { type: 'number', step: 'any', min: '-500', max: '9000', id: `elev-${n}`, value: elevationOf(a) ?? '', 'aria-label': `Cota de ${a.name} en metros sobre el mar` }) as HTMLInputElement;
        input.addEventListener('change', () => void saveElevation(a, input.value));
        return el('li', { class: 'agentrow', dataset: { space: a.id } }, el('label', { class: 'field' }, el('span', null, a.name), input),
          el('span', { class: 'muted small' }, lines[n]?.toNext !== null && lines[n]?.toNext !== undefined ? `+${lines[n]!.toNext} m hasta la siguiente` : ''));
      })) : null);
  }

  async function saveElevation(a: SpaceRow, value: string): Promise<void> {
    const v = value.trim() === '' ? null : Number(value.replace(',', '.'));
    if (v !== null && !(Number.isFinite(v) && v >= -500 && v <= 9000)) { toast('La cota va en metros sobre el mar, entre −500 y 9000.'); return; }
    const attrs = { ...((a.attributes as Record<string, unknown> | undefined) ?? {}) };
    if (v === null) delete attrs.elevation_m; else attrs.elevation_m = v;
    try { await spaces.update(a.id, { attributes: attrs }); toast(v === null ? `Sin cota en ${a.name}.` : `${a.name}: ${v} m.`); }
    catch (e) { toast(describeError(e)); }
  }

  /** Subir un icono del catálogo: SVG (se sube limpio), PNG o GIF de hasta 1 MB, con nombre, categoría y tamaño por defecto. */
  function openIconUpload(): void {
    let sheet: Sheet | null = null;
    const error = el('p', { class: 'formerror', role: 'alert' });
    const name = el('input', { id: 'iconName', 'data-field-id': 'central.planos.icon_name', 'data-field-entity': 'resources.decor_icons', 'data-field-prop': 'name', type: 'text', maxlength: '80', placeholder: 'Planta grande' }) as HTMLInputElement;
    const category = el('input', { id: 'iconCategory', 'data-field-id': 'central.planos.icon_category', 'data-field-entity': 'resources.decor_icons', 'data-field-prop': 'category', type: 'text', maxlength: '40', placeholder: 'Plantas', list: 'iconCategories' }) as HTMLInputElement;
    const cats = el('datalist', { id: 'iconCategories' }, ...[...new Set(icons.map((i) => i.category))].map((c) => el('option', { value: c })));
    const size = el('select', { id: 'iconSize', 'data-field-id': 'central.planos.icon_size', 'data-field-entity': 'resources.decor_icons', 'data-field-prop': 'default_size', 'aria-label': 'Tamaño por defecto' }, el('option', { value: '1' }, '1 celda (0,5 m en interior)'), el('option', { value: '4' }, '4 celdas (2×2, 1 m)')) as HTMLSelectElement;
    const file = el('input', { id: 'iconFile', 'data-field-id': 'central.planos.icon_file', 'data-field-entity': 'resources.decor_icons', 'data-field-prop': 'file_id', type: 'file', accept: ICON_ACCEPT }) as HTMLInputElement;
    const submit = el('button', { type: 'button', class: 'primary', id: 'iconSubmit', 'data-feedback-id': 'central.planos.icono.guardar', 'data-feedback-label': 'Guardar el icono', onclick: async () => {
      error.textContent = '';
      const f = file.files?.[0];
      if (!f) { error.textContent = 'Elige el icono: SVG, PNG o GIF.'; return; }
      const mime = f.type || (f.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '');
      const problem = iconProblem({ type: mime, size: f.size }, name.value, Number(size.value)) ?? (category.value.trim() ? null : 'Ponle una categoría.');
      if (problem) { error.textContent = problem; return; }
      const raw = mime === 'image/svg+xml' ? await f.text() : null;
      const svgText = raw === null ? null : cleanSvg(raw);
      if (raw !== null && svgText === null) { error.textContent = activeContent(raw) ? ACTIVE_SVG : 'No se ha podido leer el icono.'; return; }
      submit.disabled = true;
      try {
        const blob: Blob = svgText !== null ? new Blob([svgText], { type: 'image/svg+xml' }) : f;
        const sha = await r.stageBlob(blob, { filename: `icono.${mime === 'image/svg+xml' ? 'svg' : mime.split('/')[1]}`, mime });
        await r.commit([{ op: 'insert', table: DECOR_ICONS, id: crypto.randomUUID(), fields: { name: name.value.trim(), category: category.value.trim(), default_size: Number(size.value), file_id: { $blob: sha } } }]);
        void sheet?.close(true);
        toast(`Icono «${name.value.trim()}» subido.`);
      } catch (e) { error.textContent = describeError(e); } finally { submit.disabled = false; }
    } }, 'Subir');
    const unbind = bindOnline(submit, { client: r, reason: 'El icono se sube con conexión.' });
    sheet = openSheet({
      title: 'Subir un icono',
      body: el('div', { 'data-feedback-id': 'central.planos.icono.formulario', 'data-feedback-label': 'Icono' },
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.icono.nombre', 'data-feedback-label': 'Nombre' }, el('span', null, 'Nombre'), name),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.icono.categoria', 'data-feedback-label': 'Categoría' }, el('span', null, 'Categoría'), category, cats),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.icono.tamano', 'data-feedback-label': 'Tamaño por defecto' }, el('span', null, 'Tamaño por defecto'), size),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.icono.archivo', 'data-feedback-label': 'Archivo del icono' }, el('span', null, 'Icono (SVG, PNG o GIF animado, hasta 1 MB, visto desde arriba)'), file),
        error),
      panelAttrs: { 'data-feedback-id': 'central.planos.icono', 'data-feedback-label': 'Subir un icono' },
      closeAttrs: { 'data-feedback-id': 'central.planos.icono.cerrar', 'data-feedback-label': 'Cerrar' },
      foot: [submit],
      onClose: () => unbind(),
    });
  }

  async function removeIcon(i: IconRow): Promise<void> {
    const used = items.filter((x) => !x.deleted_at && x.icon_id === i.id).length;
    if (used) { toast(`«${i.name}» está puesto ${used === 1 ? 'una vez' : `${used} veces`}: quítalo de los planos antes.`); return; }
    if (!(await confirmDialog({ title: `¿Quitar el icono «${i.name}»?`, text: 'Deja de salir en el catálogo. Se puede volver a subir.', confirmLabel: 'Quitar', danger: true }))) return;
    try { const now = await r.get(DECOR_ICONS, i.id); await r.commit([{ op: 'delete', table: DECOR_ICONS, id: i.id, expectedRevision: Number(now?.revision ?? 0) }]); toast('Icono quitado.'); }
    catch (e) { toast(describeError(e)); }
  }

  // --- Imágenes del centro (todos ven; el owner sube y quita) ---------------------------------------------------------
  const imageBinds: Array<() => void> = [];
  function paintImages(): void {
    if (!alive) return;
    for (const b of imageBinds.splice(0)) b();
    const owner = canPlace();
    const buildings = rows.filter((s) => s.active && (s.kind === 'edificio' || s.kind === 'exterior'));
    const live = images.filter((i) => !i.deleted_at);
    const add = owner ? el('button', { type: 'button', class: 'primary', id: 'newCenterImage', 'data-feedback-id': 'central.planos.imagenes.subir', 'data-feedback-label': 'Subir una imagen del centro', onclick: () => openImageUpload(null) }, icon('upload', 16), 'Subir una imagen') : null;
    if (add) imageBinds.push(bindOnline(add, { client: r, reason: 'Las imágenes se suben con conexión.' }));
    const byBuilding = buildings.filter((b) => live.some((i) => i.space_id === b.id)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    // Silueta de cabecera de cada app (Recursos 0816): una por app, elegida entre las siluetas subidas.
    const siluetas = live.filter((i) => i.kind === 'silueta').map((i) => ({ i, b: buildings.find((x) => x.id === i.space_id) }))
      .sort((x, y) => (x.b?.name ?? '').localeCompare(y.b?.name ?? '', 'es') || x.i.position - y.i.position);
    const headers = siluetas.length ? el('div', { id: 'headerPicks', class: 'ctl-headerpicks', 'data-feedback-id': 'central.planos.imagenes.cabecera', 'data-feedback-label': 'Silueta de cabecera de cada app' },
      el('h4', { class: 'sectionlabel' }, 'Silueta de cabecera'),
      el('p', { class: 'hint' }, 'La que sale arriba en cada app.'),
      ...HEADER_APPS.map((app) => {
        const current = headerOf(live, app);
        const sel = el('select', { id: `header-${app}`, ...HEADER_MARKS[app].select, disabled: !owner },
          el('option', { value: '' }, 'Ninguna'),
          ...siluetas.map(({ i, b }) => el('option', { value: i.id, selected: i.id === current }, `${b?.name ?? 'Sin edificio'} · ${i.title}`))) as HTMLSelectElement;
        sel.addEventListener('change', () => void setHeader(app, sel.value || null));
        return el('label', { class: 'field', ...HEADER_MARKS[app].label }, el('span', null, HEADER_APP_LABELS[app]), sel);
      })) : null;
    replace(imagesHost,
      el('div', { class: 'blockhead' }, el('h3', null, 'Imágenes del centro'), add),
      el('p', { class: 'hint' }, 'Siluetas, secciones y fotos de cada edificio: salen de cabecera en los portales de huéspedes y de quien organiza, y en la ficha del edificio.'),
      headers,
      byBuilding.length ? el('div', { id: 'centerImageList' }, ...byBuilding.map((b) => el('section', { class: 'card', dataset: { space: b.id } },
        el('div', { class: 'blockhead' }, el('h4', null, b.name),
          owner ? el('button', { type: 'button', class: 'ghost small', 'aria-label': `Subir una imagen de ${b.name}`, 'data-feedback-id': 'central.planos.imagenes.subir_edificio', 'data-feedback-label': 'Subir una imagen del edificio', onclick: () => openImageUpload(b.id) }, icon('plus', 16), 'Añadir') : null),
        el('ul', { class: 'ctl-centerimages' }, ...live.filter((i) => i.space_id === b.id).sort((x, y) => x.position - y.position).map((i) => {
          const url = typeof i.file_id === 'string' ? fileUrls.get(i.file_id) ?? null : null;
          return el('li', { dataset: { image: i.id } },
            url ? el('img', { src: url, alt: `${IMAGE_KIND_LABELS[i.kind as ImageKind] ?? i.kind} de ${b.name}: ${i.title}`, loading: 'lazy' }) : el('span', { class: 'muted small' }, 'Cargando…'),
            el('span', { class: 'small' }, el('strong', null, i.title), ` · ${IMAGE_KIND_LABELS[i.kind as ImageKind] ?? i.kind}`),
            i.header_for?.length ? el('span', { class: 'chip', dataset: { headerFor: i.header_for.join(' ') } }, `Cabecera de ${i.header_for.map((a) => HEADER_APP_LABELS[a as HeaderApp] ?? a).join(', ')}`) : null,
            owner ? el('button', { type: 'button', class: 'ghost small', 'aria-label': `Quitar «${i.title}»`, 'data-feedback-id': 'central.planos.imagenes.quitar', 'data-feedback-label': 'Quitar la imagen', onclick: () => void removeImage(i) }, icon('trash', 16), 'Quitar') : null);
        }))))) : el('p', { class: 'hint', id: 'centerImagesEmpty' }, owner ? 'Aún no hay imágenes. Sube las siluetas y secciones de cada edificio.' : 'Aún no hay imágenes de los edificios.'));
  }

  function openImageUpload(spaceId: string | null): void {
    let sheet: Sheet | null = null;
    const error = el('p', { class: 'formerror', role: 'alert' });
    const buildings = rows.filter((s) => s.active && (s.kind === 'edificio' || s.kind === 'exterior')).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const building = el('select', { id: 'imageBuilding', 'data-field-id': 'central.planos.image_building', 'data-field-entity': 'resources.space_images', 'data-field-prop': 'space_id', 'aria-label': 'Edificio' }, ...buildings.map((b) => el('option', { value: b.id, selected: b.id === spaceId }, b.name))) as HTMLSelectElement;
    const kindSel = el('select', { id: 'imageKind', 'data-field-id': 'central.planos.image_kind', 'data-field-entity': 'resources.space_images', 'data-field-prop': 'kind', 'aria-label': 'Tipo de imagen' }, ...IMAGE_KINDS.map((k) => el('option', { value: k }, IMAGE_KIND_LABELS[k]))) as HTMLSelectElement;
    const title = el('input', { id: 'imageTitle', 'data-field-id': 'central.planos.image_title', 'data-field-entity': 'resources.space_images', 'data-field-prop': 'title', type: 'text', maxlength: '120', placeholder: 'Alzado norte' }) as HTMLInputElement;
    const file = el('input', { id: 'imageFile', 'data-field-id': 'central.planos.image_file', 'data-field-entity': 'resources.space_images', 'data-field-prop': 'file_id', type: 'file', accept: 'image/png,image/jpeg,image/svg+xml' }) as HTMLInputElement;
    const submit = el('button', { type: 'button', class: 'primary', id: 'imageSubmit', 'data-feedback-id': 'central.planos.imagen.guardar', 'data-feedback-label': 'Guardar la imagen', onclick: async () => {
      error.textContent = '';
      const f = file.files?.[0];
      if (!f) { error.textContent = 'Elige la imagen: PNG, JPG o SVG.'; return; }
      const mime = f.type || (f.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '');
      const problem = imageProblem({ type: mime, size: f.size }, title.value) ?? (building.value ? null : 'Elige el edificio.');
      if (problem) { error.textContent = problem; return; }
      const raw = mime === 'image/svg+xml' ? await f.text() : null;
      const svgText = raw === null ? null : cleanSvg(raw);
      if (raw !== null && svgText === null) { error.textContent = activeContent(raw) ? ACTIVE_SVG : 'No se ha podido leer la imagen.'; return; }
      submit.disabled = true;
      try {
        const blob: Blob = svgText !== null ? new Blob([svgText], { type: 'image/svg+xml' }) : f;
        const sha = await r.stageBlob(blob, { filename: `imagen.${mime === 'image/svg+xml' ? 'svg' : mime === 'image/jpeg' ? 'jpg' : 'png'}`, mime });
        const position = images.filter((i) => !i.deleted_at && i.space_id === building.value).length;
        await r.commit([{ op: 'insert', table: IMAGES, id: crypto.randomUUID(), fields: { space_id: building.value, kind: kindSel.value, title: title.value.trim(), file_id: { $blob: sha }, position } }]);
        void sheet?.close(true);
        toast(`Imagen «${title.value.trim()}» subida.`);
      } catch (e) { error.textContent = describeError(e); } finally { submit.disabled = false; }
    } }, 'Subir');
    const unbind = bindOnline(submit, { client: r, reason: 'La imagen se sube con conexión.' });
    sheet = openSheet({
      title: 'Subir una imagen del centro',
      body: el('div', { 'data-feedback-id': 'central.planos.imagen.formulario', 'data-feedback-label': 'Imagen del centro' },
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.imagen.edificio', 'data-feedback-label': 'Edificio' }, el('span', null, 'Edificio'), building),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.imagen.tipo', 'data-feedback-label': 'Tipo de imagen' }, el('span', null, 'Qué es'), kindSel),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.imagen.titulo', 'data-feedback-label': 'Título' }, el('span', null, 'Título'), title),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.imagen.archivo', 'data-feedback-label': 'Archivo de la imagen' }, el('span', null, 'Imagen (PNG, JPG o SVG, hasta 5 MB)'), file),
        error),
      panelAttrs: { 'data-feedback-id': 'central.planos.imagen', 'data-feedback-label': 'Subir una imagen del centro' },
      closeAttrs: { 'data-feedback-id': 'central.planos.imagen.cerrar', 'data-feedback-label': 'Cerrar' },
      foot: [submit],
      onClose: () => unbind(),
    });
  }

  /** Cambia la silueta de cabecera de una app en un solo lote, con «Deshacer». */
  async function setHeader(app: HeaderApp, imageId: string | null): Promise<void> {
    const before = headerOf(images, app);
    const ops = headerOperations(images, app, imageId);
    if (!ops.length) return;
    try {
      await r.commit(ops);
      const label = HEADER_APP_LABELS[app];
      toastWithAction(imageId ? `Cabecera de ${label} cambiada.` : `${label} se queda sin silueta de cabecera.`, { label: 'Deshacer', onClick: () => void (async () => {
        try { const now = (await r.list(IMAGES)) as unknown as ImageRow[]; const back = headerOperations(now, app, before); if (back.length) await r.commit(back); }
        catch (e) { toast(describeError(e)); }
      })() });
    } catch (e) { toast(describeError(e)); paintImages(); }
  }

  async function removeImage(i: ImageRow): Promise<void> {
    if (!(await confirmDialog({ title: `¿Quitar «${i.title}»?`, text: 'Deja de salir en los portales y en la ficha del edificio.', confirmLabel: 'Quitar', danger: true }))) return;
    try { const now = await r.get(IMAGES, i.id); await r.commit([{ op: 'delete', table: IMAGES, id: i.id, expectedRevision: Number(now?.revision ?? 0) }]); toast('Imagen quitada.'); }
    catch (e) { toast(describeError(e)); }
  }

  /** Una estancia sin forma va al centro del dibujo, como un rectángulo; las camas, más pequeñas y dentro de su habitación. */
  function putOn(s: SpaceRow, plan: FloorPlan): void {
    const parent = s.parentId ? rows.find((x) => x.id === s.parentId && x.planId === plan.id && validShape(x.planShape)) : null;
    const shape = parent ? (() => { const c = shapeCenter(parent.planShape as PlanShape); return rect(c.x, c.y, Math.max(c.w / 4, 0.015), Math.max(c.h / 4, 0.015)); })()
      : s.kind === 'cama' ? rect(0.5, 0.5, 0.03, 0.03) : rect(0.5, 0.5, 0.12, 0.1);
    selected = s.id;
    reviewWhy.delete(s.id);
    setShape(s.id, plan.id, shape);
    paintEditor();
    editor.querySelector<SVGElement>(`[data-space-id="${CSS.escape(s.id)}"]`)?.focus();
  }

  function unplace(s: SpaceRow): void {
    s.planId = null; s.planShape = null;
    selected = null;
    batch.delete(s.id); before.delete(s.id);
    void Promise.resolve(spaces.update(s.id, { planId: null, planShape: null })).then(() => buildViewer()).catch((e: unknown) => toast(describeError(e)));
    paintEditor();
  }

  function onKey(e: KeyboardEvent, s: SpaceRow, plan: FloorPlan): void {
    const step = e.altKey ? 0.002 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as [number, number] | undefined;
    if (!d) return;
    e.preventDefault();
    const shape = s.planShape as PlanShape;
    const b = boxOf(shape);
    const next = e.shiftKey ? stretched(shape, [b.x0, b.y0], b.x1 - b.x0 + d[0], b.y1 - b.y0 + d[1]) : moved(shape, d[0], d[1]);
    const inner = within(s, plan.id).map((x) => [x, x.planShape as PlanShape] as [SpaceRow, PlanShape]);
    reshape(s, plan, shape, next, inner, e.shiftKey ? 'estirada' : 'movida');
    // Con el teclado, sin «Deshacer» para lo suelto (la flecha contraria lo deshace); con sus camas, sí.
    if (!inner.length) undoLabel = null;
    paintEditor();
    editor.querySelector<SVGElement>(`[data-space-id="${CSS.escape(s.id)}"]`)?.focus();
  }

  /** Arrastrar: mover la forma, o estirarla desde la esquina contraria (`anchor`). Las camas de dentro la acompañan. */
  function startDrag(e: PointerEvent, s: SpaceRow, how: 'move' | readonly [number, number], plan: FloorPlan, svg: SVGSVGElement): void {
    e.preventDefault();
    selected = s.id;
    const box = svg.getBoundingClientRect();
    const start = s.planShape as PlanShape;
    const inner = within(s, plan.id).map((x) => [x, x.planShape as PlanShape] as [SpaceRow, PlanShape]);
    const x0 = e.clientX; const y0 = e.clientY;
    const target = e.target as Element;
    target.setPointerCapture?.(e.pointerId);
    let next: PlanShape = start;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / box.width; const dy = (ev.clientY - y0) / box.height;
      if (how === 'move') next = moved(start, dx, dy);
      else {
        const b = boxOf(start);
        const corner: [number, number] = [how[0] === b.x0 ? b.x1 : b.x0, how[1] === b.y0 ? b.y1 : b.y0];
        const nx = corner[0] + dx; const ny = corner[1] + dy;
        next = stretched(start, [how[0], how[1]], Math.abs(nx - how[0]), Math.abs(ny - how[1]));
        const nb = boxOf(next);
        // Hacia el otro lado del ancla: se refleja la posición, no la forma.
        next = moved(next, nx < how[0] ? how[0] - (nb.x1 - nb.x0) - nb.x0 : 0, ny < how[1] ? how[1] - (nb.y1 - nb.y0) - nb.y0 : 0);
      }
      // Mientras se arrastra, solo se pinta (la estancia y sus camas); se guarda al soltar.
      svg.querySelector(`[data-space-id="${CSS.escape(s.id)}"]`)?.setAttribute('points', pointsAttr(next, plan));
      for (const [x, from] of inner) svg.querySelector(`[data-space-id="${CSS.escape(x.id)}"]`)?.setAttribute('points', pointsAttr(follow(from, start, next), plan));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (next !== start && validShape(next)) reshape(s, plan, start, next, inner, how === 'move' ? 'movida' : 'estirada');
      paintEditor();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** «Colocar solo» sobre un dibujo ya subido: se lee el archivo (si es SVG) y se colocan las que faltan. */
  /** Lee las formas con nombre del dibujo (SVG) una vez por dibujo. Sin SVG o sin nombres, `none`. */
  async function loadSvgShapes(plan: FloorPlan): Promise<void> {
    svgShapes.set(plan.id, 'loading');
    try {
      const local = localUrls.get(plan.id);
      if (!local && typeof plan.fileId !== 'string') { svgShapes.delete(plan.id); return; }
      const text = await (await fetch(local ?? await r.fileUrl(plan.fileId as string))).text();
      const read = /<svg[\s>]/i.test(text) ? readSvgPlan(text) : null;
      const named = (read?.shapes ?? []).filter((x) => !x.problem && !generatedName(x.name) && x.points.length >= 3);
      // Fuera lo que envuelve a otras formas (el contorno del edificio, el grupo «estancias», los muros): no son estancias.
      const box = (x: SvgShape) => { const xs = x.points.map((q) => q[0]); const ys = x.points.map((q) => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const; };
      const centre = (x: SvgShape) => { const [a, b, c, d] = box(x); return [(a + c) / 2, (b + d) / 2] as const; };
      const shapes = named.filter((x) => {
        const [a, b, c, d] = box(x);
        return named.filter((y) => y !== x && (() => { const [cx, cy] = centre(y); return cx > a && cx < c && cy > b && cy < d; })()).length < 2;
      });
      svgShapes.set(plan.id, shapes.length ? shapes : 'none');
    } catch { svgShapes.delete(plan.id); }
    if (alive && editing === plan.id) paintEditor();
  }
  const near = (a: number, b: number) => Math.abs(a - b) < 0.002;
  const sameShape = (shape: PlanShape | null | undefined, points: Array<[number, number]>) =>
    !!shape?.points && shape.points.length === points.length && shape.points.every(([x, y], i) => near(x, points[i]![0]) && near(y, points[i]![1]));
  /** La estancia que ya ocupa esa forma del dibujo, si la hay. */
  const holderOf = (plan: FloorPlan, shape: SvgShape) => rows.find((s) => s.active && s.planId === plan.id && s.kind !== 'cama' && sameShape(s.planShape as PlanShape | null, shape.points)) ?? null;

  /** «Esta forma es…»: la estancia elegida toma la forma; si otra la tenía, la deja. Un «Deshacer». */
  function assignShape(plan: FloorPlan, shape: SvgShape, spaceId: string): void {
    const before = holderOf(plan, shape);
    if (before?.id === spaceId) return;
    const target = rows.find((s) => s.id === spaceId);
    if (!target) return;
    remember(target.id);
    if (before) { remember(before.id); before.planId = null; before.planShape = null; save(before.id, null, null); }
    setShape(target.id, plan.id, { points: shape.points.map(([x, y]) => [x, y]) });
    undoLabel = `«${shape.name}» del dibujo es ${target.name}.`;
    paintEditor();
  }

  /** «Otra: escribir el nombre…»: una estancia nueva en este edificio, con su tipo, que toma ya esta forma del dibujo. */
  function newSpaceFor(plan: FloorPlan, shape: SvgShape): void {
    let sheet: Sheet | null = null;
    const name = el('input', { id: 'newSpaceName', 'data-field-id': 'central.planos.new_space_name', 'data-field-entity': 'resources.spaces', 'data-field-prop': 'name', maxlength: 80, value: shape.name.replace(/[_-]+/g, ' ') }) as HTMLInputElement;
    const kind = el('select', { id: 'newSpaceKind', 'data-field-id': 'central.planos.new_space_kind', 'data-field-entity': 'resources.spaces', 'data-field-prop': 'kind' },
      ...ROOM_KINDS.map(([k, label]) => el('option', { value: k }, label))) as HTMLSelectElement;
    const save = el('button', { class: 'primary', type: 'button', id: 'newSpaceSave', 'data-feedback-id': 'central.planos.colocar.nueva_estancia.crear', 'data-feedback-label': 'Crear la estancia', onclick: async () => {
      const text = name.value.trim();
      if (!text) { toast('Escribe el nombre.'); return; }
      try {
        const id = crypto.randomUUID();
        await spaces.create({ id, parentId: plan.buildingId, kind: kind.value, name: text, publicName: null, code: null, position: rows.length, active: true, notes: null, attributes: {}, planId: plan.id, planShape: { points: shape.points.map(([x, y]) => [x, y]) } });
        toast(`«${text}» creada y puesta en el dibujo.`);
        await sheet?.close(true);
      } catch (e) { toast(describeError(e)); }
    } }, 'Crear');
    sheet = openSheet({ title: 'Otra estancia', meta: planName(plan),
      body: el('div', { 'data-feedback-id': 'central.planos.colocar.nueva_estancia', 'data-feedback-label': 'Otra estancia' },
        el('p', { class: 'muted small' }, 'Se crea en este edificio con esta forma del dibujo. Si tiene camas, se ponen en Booking › Espacios y camas.'),
        el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
        el('label', { class: 'field' }, el('span', null, 'Qué es'), kind)),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.planos.colocar.nueva_estancia.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save],
      initialFocus: name });
  }

  /** Cambiar el nombre de la estancia por el del dibujo (Recursos). */
  /** Renombrar una estancia (Recursos) desde «Colocar». */
  function renameSpace(space: SpaceRow): void {
    let sheet: Sheet | null = null;
    const name = el('input', { id: 'renameSpaceName', 'data-field-id': 'central.planos.rename_space', 'data-field-entity': 'resources.spaces', 'data-field-prop': 'name', maxlength: 80, value: space.name }) as HTMLInputElement;
    const save = el('button', { class: 'primary', type: 'button', id: 'renameSpaceSave', 'data-feedback-id': 'central.planos.colocar.renombrar_estancia.guardar', 'data-feedback-label': 'Guardar el nombre', onclick: async () => {
      const text = name.value.trim();
      if (!text) { toast('Escribe el nombre.'); return; }
      await renameTo(space, text);
      await sheet?.close(true);
    } }, 'Guardar');
    sheet = openSheet({ title: 'Renombrar', meta: space.name,
      body: el('div', { 'data-feedback-id': 'central.planos.colocar.renombrar_estancia.hoja', 'data-feedback-label': 'Renombrar la estancia' },
        el('p', { class: 'muted small' }, 'El nombre nuevo sale en todas las apps: Booking, Guests, Tasks…'),
        el('label', { class: 'field' }, el('span', null, 'Nombre'), name)),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.planos.colocar.renombrar_estancia.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save],
      initialFocus: name });
  }

  /** Dar de baja una estancia (Recursos la archiva; el servidor se niega si tiene reservas futuras, stock o tareas abiertas). */
  async function archiveSpace(space: SpaceRow): Promise<void> {
    if (!(await confirmDialog({ title: `¿Dar de baja «${space.name}»?`, text: 'Deja de salir en el plano y en las apps. Se puede recuperar en Booking › Espacios y camas (archivadas). Si tiene reservas, stock o tareas abiertas, no se puede.', confirmLabel: 'Dar de baja', danger: true }))) return;
    try {
      await spaces.archive([space.id]);
      toast(`«${space.name}» dada de baja.`);
    } catch (e) { toast(describeError(e)); }
  }

  async function renameTo(space: SpaceRow, name: string): Promise<void> {
    try {
      await spaces.update(space.id, { name: name.slice(0, 80) });
      toast(`«${space.name}» ahora se llama «${name}».`);
    } catch (e) { toast(describeError(e)); }
  }

  async function autoFromFile(plan: FloorPlan): Promise<void> {
    if (!plan.fileId) { toast('Este plano no tiene dibujo: sube uno.'); return; }
    try {
      const local = localUrls.get(plan.id);
      if (!local && typeof plan.fileId !== 'string') { toast('El dibujo aún está subiendo: prueba en un momento.'); return; }
      const res = await fetch(local ?? await r.fileUrl(plan.fileId as string));
      const text = await res.text();
      if (!/<svg[\s>]/i.test(text)) { toast('Este dibujo no es un SVG con nombres: colócalas a mano.'); return; }
      autoPlace(plan.id, text, true);
    } catch { toast('No se ha podido leer el dibujo: prueba con conexión o colócalas a mano.'); }
  }

  // --- Datos ------------------------------------------------------------------------------------------------------
  const repaint = () => { if (!alive) return; paintTools(); paintEditor(); paintImages(); };
  // Lo de 0814 que la fuente del kit no trae: dibujos (tipo, escala y cotas), iconos, objetos e imágenes.
  let lastHeader: string | null | undefined;
  async function loadExtra(): Promise<void> {
    const [p, ic, it, im] = await Promise.all([r.list(PLANS), r.list(DECOR_ICONS), r.list(ITEMS), r.list(IMAGES)].map((x) => x.catch(() => [])));
    planRows = p as unknown as PlanRow[];
    icons = (ic as unknown as IconRow[]).filter((x) => !x.deleted_at);
    items = it as unknown as typeof items;
    images = (im as unknown as ImageRow[]).filter((x) => !x.deleted_at);
    // Si cambia la silueta de cabecera de Central (se elige aquí), la cabecera se entera sin leer Recursos por su cuenta.
    const header = centralHeader(images as unknown as Parameters<typeof centralHeader>[0])?.id ?? null;
    if (header !== lastHeader) { if (lastHeader !== undefined) announceHeaderArt(images as unknown as Parameters<typeof announceHeaderArt>[0]); lastHeader = header; }
    if (!alive) return;
    viewer?.setDecor(allDecor());
    repaint();
    void resolveFiles();
  }
  const offExtra = [PLANS, DECOR_ICONS, ITEMS, IMAGES].map((t) => r.onTable(t, () => void loadExtra()));
  const offRows = spaces.subscribe((next) => { rows = next.map((s) => ({ ...s })); repaint(); });
  const offPlans = spaces.plans.subscribe?.((next) => { plans = next; repaint(); openWanted(); }) ?? null;
  // Si el servidor rechaza el SVG (no debería: se sube limpio), se dice una vez y por qué.
  let warnedActive = false;
  const offStatus = r.onStatus((s) => {
    if (s.lastError?.code === 'UNSUPPORTED_MEDIA') { if (!warnedActive) toast(ACTIVE_SVG, 9000); warnedActive = true; } else warnedActive = false;
    repaint();
  });
  const onHide = () => { void flush(); };
  window.addEventListener('pagehide', onHide);
  const onMedia = () => repaint();
  media.addEventListener('change', onMedia);
  // Disposición de las camas (Booking): la última se recuerda en este dispositivo para verlas sin red.
  const LAYOUT_KEY = 'ikisai-central-bed-layouts';
  try { const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '[]'); if (Array.isArray(saved)) layouts = saved as BedLayout[]; } catch { /* sin almacenamiento */ }
  void client.api<{ rows: BedLayout[]; available: boolean }>('/beds/layout').then((out) => {
    if (!alive || !out?.available) return;
    layouts = out.rows;
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layouts)); } catch { /* sin almacenamiento */ }
    rows = derive(rows);
    buildViewer();
    repaint();
  }).catch(() => undefined);
  void Promise.all([spaces.list(), spaces.plans.list(), loadExtra()]).then(([s, p]) => {
    rows = s.map((x) => ({ ...x })); plans = p;
    // El mapa empieza en la finca en cuanto se sabe que la hay.
    const first = startPlan();
    if (first) viewer?.setPlan(first);
    repaint();
    openWanted();
  });
  buildViewer();
  return () => {
    alive = false;
    void flush();
    for (const b of binds.splice(0)) b();
    for (const b of editorBinds.splice(0)) b();
    offRows(); offPlans?.(); offStatus(); media.removeEventListener('change', onMedia); window.removeEventListener('pagehide', onHide);
    for (const off of offExtra) off();
    for (const b of imageBinds.splice(0)) b();
    viewer?.destroy(); decorMap?.destroy(); spaces.destroy();
    for (const u of localUrls.values()) URL.revokeObjectURL(u);
  };
};
