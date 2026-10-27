/**
 * «Ver en el plano» desplegable (MUELA-025, 024 y 071, pieza común de Guests `verEnPlano`): se abre dentro, sin salir de
 * la pantalla.
 * - **Con el mapa de zonas** (`GET plans`, `resources.portal_plans`) y el sitio en él: el mapa del kit (`createSpaceMap`)
 *   con el sitio resaltado y «Aquí» en texto, y la lista equivalente (sin dibujo o sin forma, la pieza enseña solo la
 *   lista con la ruta). El sitio se busca por su id de Recursos (`spaceId`) o, si no lo hay, por su nombre, solo si
 *   coincide con uno (`match`). El plano del centro de Central queda debajo, como respaldo.
 * - **Sin mapa o sin el sitio en él:** como hasta ahora, dónde está en texto y el plano del centro de Central
 *   (`site_plan_file_id`): la imagen o, si es un PDF, «Abrir el plano (PDF)».
 * Todo se pide al abrir el desplegable o una vez por minuto (la lectura se recuerda). El dibujo se guarda en el dispositivo
 * por su `sha256` para verlo sin red y no volver a bajarlo si no cambia. Sin plano y sin texto, nada; sin plano pero con
 * texto, solo la línea del sitio.
 */
import { bedShape, createMemorySpaceSource, createSpaceMap, el, icon, replace, toast, type DecorItem, type FloorPlan, type SpaceMap, type SpaceMapOptions, type SpaceRow } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { whyNote } from './common.ts';
import { t } from '../app/i18n.ts';
import type { Loaded } from '../app/api.ts';
import type { Place, PortalPlan, PortalPlans, PortalReads, PortalSpace } from '../app/portal.ts';

export interface PlanOptions {
  /** Dónde está, en texto («Sala grande»). */
  place: string | null;
  /** Rótulo del desplegable; por defecto, `place`. */
  label?: string | null;
  id?: string;
  reads?: PortalReads | null;
  /** El espacio de Recursos, si se conoce (`resource_space_id`). */
  spaceId?: string | null;
  /** Sin id: el nombre de la habitación o sala y, si lo hay, el de la cama dentro (solo si coincide con uno). */
  match?: { space?: string | null; bed?: string | null } | null;
  /** El mapa entero, sin un sitio (Información práctica, «Ikisai»). */
  whole?: boolean;
  /** Marca de feedback del desplegable, con id y etiqueta literales en cada pantalla (con `fbMark` de common.ts). */
  mark?: (node: HTMLElement) => void;
  /** Las habitaciones de Booking con su disposición (`portal_lodging`): de ellas salen las camas del plano (`withBedLayouts`). */
  rooms?: LayoutRoom[] | null;
}

/** Línea del sitio sin plano: chincheta y texto. */
function placeLine(place: string): HTMLElement {
  return el('span', { class: 'small gplace' }, icon('pin', 14), el('span', null, place));
}

// --- Lecturas recordadas un minuto (una pantalla puede tener un «Ver en el plano» por actividad) ----------------------
const MEMO_MS = 60_000;
const memo = new WeakMap<PortalReads, { at: number; plans: Promise<Loaded<PortalPlans> | null>; place: Promise<Loaded<Place> | null> }>();
function readsOf(reads: PortalReads) {
  const hit = memo.get(reads);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit;
  const fresh = { at: Date.now(), plans: reads.plans().catch(() => null), place: reads.place().catch(() => null) };
  memo.set(reads, fresh);
  return fresh;
}

// --- El mapa de zonas ------------------------------------------------------------------------------------------------
const norm = (s: string | null | undefined) => (s ?? '').trim().toLocaleLowerCase('es');

/** Filas del kit desde la lectura del portal (solo nombres públicos y, en las camas, su tipo para el icono). */
export function toRows(spaces: PortalSpace[]): SpaceRow[] {
  return spaces.map((s) => ({ id: s.id, parentId: s.parentId, kind: s.kind, name: s.name, publicName: null, code: null, position: s.position ?? 0,
    active: true, notes: null, attributes: s.bedKind ? { bed_kind: s.bedKind } : {}, planId: s.planId, planShape: s.planShape }));
}

/** Una habitación de Booking con su disposición (`portal_lodging` y `booking_public_beds`, Booking 1417). */
export interface LayoutRoom {
  resource_space_id?: string | null;
  layout?: { cols: number; rows: number } | null;
  beds: Array<{ resource_bed_id?: string | null; layout?: { x: number; y: number; rot?: number } | null }>;
}

/**
 * Las camas con un solo modelo (VG, por Core y Central, 27-10-2026): la forma de cada cama en el dibujo sale de su
 * disposición en Booking (`bedShape` del kit sobre la forma de su habitación), nunca de Recursos. Se casa por
 * `resource_bed_id` y la habitación por `resource_space_id` o, si la lectura no lo da (`booking_public_beds`), por la
 * habitación de la cama en Recursos. Las camas sin disposición se quedan sin forma: no se pintan y queda la lista. Pura.
 */
export function withBedLayouts(data: PortalPlans, rooms: LayoutRoom[]): PortalPlans {
  const byId = new Map(data.spaces.map((s) => [s.id, s]));
  const shapes = new Map<string, Pick<PortalSpace, 'planId' | 'planShape'>>();
  for (const room of rooms) {
    if (!room.layout) continue;
    for (const bed of room.beds) {
      const space = bed.resource_bed_id ? byId.get(bed.resource_bed_id) : undefined;
      if (!space || !bed.layout) continue;
      const parent = byId.get(room.resource_space_id ?? space.parentId ?? '');
      if (!parent?.planId) continue;
      const shape = bedShape(parent.planShape, room.layout, { x: bed.layout.x, y: bed.layout.y, rot: bed.layout.rot === 90 ? 90 : 0 });
      if (shape) shapes.set(space.id, { planId: parent.planId, planShape: shape });
    }
  }
  return { ...data, spaces: data.spaces.map((s) => (s.kind === 'cama' ? { ...s, ...(shapes.get(s.id) ?? { planId: null, planShape: null }) } : s)) };
}

/** La cama propia con su sitio (`room_layout` y `bed_layout` de Booking). */
export interface OwnBed {
  resource_space_id?: string | null; resource_bed_id?: string | null;
  room_layout?: { cols: number; rows: number } | null; bed_layout?: { x: number; y: number; rot?: number } | null;
}

/**
 * La cama propia como una habitación de una cama, para `withBedLayouts`. Sale de `mine` de `portal_lodging` y de las
 * estancias y `default_bed` de `portal_my_stays`, para que «Aquí» caiga en la cama aunque su habitación no esté abierta a
 * elegir. Sin esos campos, ninguna, y «Aquí» va en la habitación. Pura.
 */
export function ownBedRoom(bed: OwnBed | null | undefined): LayoutRoom[] {
  return bed?.resource_bed_id && bed.room_layout && bed.bed_layout
    ? [{ resource_space_id: bed.resource_space_id ?? null, layout: bed.room_layout, beds: [{ resource_bed_id: bed.resource_bed_id, layout: bed.bed_layout }] }]
    : [];
}

/** El espacio del sitio: por id o, si no, por nombre (habitación y cama dentro), solo si la coincidencia es única. Pura. */
export function findSpace(spaces: PortalSpace[], spaceId?: string | null, match?: { space?: string | null; bed?: string | null } | null): PortalSpace | null {
  if (spaceId) return spaces.find((s) => s.id === spaceId) ?? null;
  // Sin id (Booking no tiene pareja en Recursos): por el nombre, solo si coincide con uno.
  const name = norm(match?.space);
  if (!name) return null;
  const rooms = spaces.filter((s) => norm(s.name) === name && s.kind !== 'cama');
  if (rooms.length !== 1) return null;
  const room = rooms[0]!;
  const bedName = norm(match?.bed);
  const beds = bedName ? spaces.filter((s) => s.parentId === room.id && norm(s.name) === bedName) : [];
  return beds.length === 1 ? beds[0]! : room;
}

const PLAN_CACHE = 'ikisai-guests-plans';
const planKey = (sha256: string) => `/plans/${sha256}`;

/** El dibujo: la copia del dispositivo si es el mismo (`sha256`); si no, se baja con la URL firmada y se guarda. */
async function planImage(plan: PortalPlan | undefined): Promise<string> {
  if (!plan) return '';
  if (plan.sha256) {
    try {
      const hit = await (await caches.open(PLAN_CACHE)).match(planKey(plan.sha256));
      if (hit) return URL.createObjectURL(await hit.blob());
    } catch { /* sin Cache Storage */ }
  }
  if (!plan.url) return '';
  try {
    const res = await fetch(plan.url);
    if (!res.ok) return plan.url;
    const blob = await res.blob();
    if (plan.sha256) {
      try { await (await caches.open(PLAN_CACHE)).put(planKey(plan.sha256), new Response(blob, { headers: { 'content-type': plan.mime ?? blob.type } })); } catch { /* sin Cache Storage */ }
    }
    return URL.createObjectURL(blob);
  } catch {
    // Sin CORS o sin red: la imagen firmada se pinta igual (no necesita leerse desde aquí).
    return plan.url;
  }
}

/** El mapa de zonas leído (recordado un minuto), o null si no hay. */
export function loadPlans(reads: PortalReads): Promise<Loaded<PortalPlans> | null> {
  return readsOf(reads).plans;
}

const SCALES = new Set([5, 1, 0.5]);
const ROTATIONS = new Set([0, 90, 180, 270]);

/** La decoración general de la lectura, con la URL de su icono (las piezas sin icono firmado no se pintan). */
export function decorOf(data: PortalPlans): DecorItem[] {
  const icons = new Map((data.icons ?? []).map((i) => [i.id, i]));
  return (data.decor ?? []).flatMap((d) => {
    const ic = d.iconId ? icons.get(d.iconId) : null;
    if (!ic?.url || !SCALES.has(d.scale) || !ROTATIONS.has(d.rotation)) return [];
    return [{ id: d.id, planId: d.planId, iconId: d.iconId, iconUrl: ic.url, label: ic.name, cellX: d.cellX, cellY: d.cellY,
      scale: d.scale as DecorItem['scale'], size: d.size === 4 ? 4 : 1, rotation: d.rotation as DecorItem['rotation'] }];
  });
}

/** La silueta de cabecera de Guests que eligió Central (`headerFor`), ya firmada; sin elegir, ninguna. Pura. */
export function headerSilhouette(data: PortalPlans | null | undefined): { url: string; title: string | null } | null {
  const image = (data?.images ?? []).find((m) => m.kind === 'silueta' && m.url && (m.headerFor ?? []).includes('guests'));
  return image?.url ? { url: image.url, title: image.title } : null;
}

/** El plano de la finca, si lo hay (el mapa empieza en él y se baja tocando: finca → edificio → habitación). */
export function estateOf(data: PortalPlans): string | null {
  return data.plans.find((x) => x.kind === 'estate')?.id ?? null;
}

/** El mapa del kit sobre la lectura del portal (Alojamiento y Ayuda ponen su capa, su filtro y su `onPick`). */
export function portalMap(data: PortalPlans, options: Omit<SpaceMapOptions, 'source' | 'plans' | 'planUrl'>): SpaceMap {
  const plans: FloorPlan[] = data.plans.map((x) => ({
    id: x.id, buildingId: x.buildingId, floor: x.floor, position: x.position, fileId: x.fileId, width: x.width, height: x.height,
    grid: x.grid ?? null, bands: x.bands ?? null,
    // La cota de cada altura (0814): sin cota no hay etiqueta.
    contours: (x.contours ?? []).flatMap((c) => (typeof c.elevationM === 'number' ? [{ spaceId: c.spaceId, label: c.label, elevationM: c.elevationM, x: c.x, y: c.y }] : [])),
  }));
  return createSpaceMap({
    source: createMemorySpaceSource(toRows(data.spaces)),
    plans,
    planUrl: (fileId) => planImage(data.plans.find((x) => x.fileId === fileId)),
    // Sin números en las camas (056): el estado va en el color, el rayado y el nombre accesible; y su icono según el tipo.
    bedNumbers: false,
    bedIcons: true,
    // Decoración general por defecto (VG: con decoración salvo donde moleste, que lo quita cada vista).
    decor: decorOf(data),
    ...options,
  });
}

/** Borra los dibujos guardados (al salir del dispositivo). */
export async function clearPlanImages(): Promise<void> {
  try { await caches.delete(PLAN_CACHE); } catch { /* sin Cache Storage */ }
}

/** El plano del centro (Central) dentro del desplegable: imagen o «Abrir el plano (PDF)». */
function centralPlan(reads: PortalReads, p: Place, box: HTMLElement, where: HTMLElement): void {
  if (p.site_plan_mime === 'application/pdf') {
    replace(box, where, el('button', { type: 'button', class: 'ghost small', 'data-feedback-id': 'guests.info.plano.abrir', 'data-feedback-label': 'Abrir el plano (PDF)',
      onclick: async () => {
        try { window.open((await reads.fileUrl(p.site_plan_file_id!)).url, '_blank', 'noopener'); } catch (error) { toast(describeError(error)); }
      } }, icon('download', 16), t('plan.openPdf')));
    return;
  }
  replace(box, where, el('p', { class: 'small' }, t('plan.loading')));
  void reads.fileUrl(p.site_plan_file_id!).then(({ url }) => {
    replace(box, where, el('img', { class: 'gplan-img', src: url, alt: t('plan.alt', { name: p.name ?? t('plan.center') }), loading: 'lazy' }));
  }).catch((error) => replace(box, where, el('p', { class: 'small' }, describeError(error)),
    el('button', { type: 'button', class: 'ghost small', onclick: () => centralPlan(reads, p, box, where) }, t('common.retry'))));
}

/**
 * El desplegable, o la línea del sitio si no hay plano. Si hay mapa y plano se conoce al leer (con caché), así que la
 * decisión es asíncrona: devuelve un hueco que se rellena.
 */
export function verEnPlano(options: PlanOptions): HTMLElement | null {
  const place = options.place?.trim() || null;
  if (!options.reads) return place ? placeLine(place) : null;
  const reads = options.reads;
  const host = el('span', { class: 'gplan-host', ...(options.id ? { id: `${options.id}Host` } : {}) }, place ? placeLine(place) : null);
  const both = readsOf(reads);
  void Promise.all([both.plans, both.place]).then(([plansLoaded, placeLoaded]) => {
    const p = placeLoaded?.value ?? null;
    const data = plansLoaded?.value ? (options.rooms ? withBedLayouts(plansLoaded.value, options.rooms) : plansLoaded.value) : null;
    const found = data ? findSpace(data.spaces, options.spaceId, options.match ?? (place ? { space: place } : null)) : null;
    // Una cama sin forma (sin disposición en Booking) no se pinta: «Aquí» va en su habitación.
    const target = found?.kind === 'cama' && !found.planShape ? data!.spaces.find((s) => s.id === found.parentId) ?? found : found;
    const withMap = Boolean(data && data.plans.length && (target || options.whole));
    if (!withMap && !p?.site_plan_file_id) {
      // Sin nada que enseñar, se dice por qué: el plano no se pudo leer, aún no está publicado o tu sitio no está en él.
      const why = !plansLoaded && !placeLoaded ? t('plan.unavailable') : options.whole ? t('plan.none')
        // Solo para tu cama o tu habitación: en cada actividad del programa sería ruido.
        : data?.plans.length && (options.spaceId || options.match) ? t('plan.notOnPlan') : null;
      if (why) host.append(whyNote(`${options.id ?? 'plan'}Why`, why));
      return;
    }
    const box = el('div', { class: 'gplan-box' });
    const details = el('details', { class: `gplan${withMap ? ' gplan-map' : ''}`, ...(options.id ? { id: options.id } : {}), ...(target ? { 'data-space': target.id } : {}) },
      el('summary', null, icon('pin', 16), el('span', { class: 'gplan-label' }, options.label ?? place ?? p?.name ?? t('plan.center')),
        el('span', { class: 'gplan-hint' }, t('plan.see'))),
      box) as HTMLDetailsElement;
    options.mark?.(details);
    let done = false;
    details.addEventListener('toggle', () => {
      if (!details.open || done) return;
      done = true;
      const where = el('p', { class: 'small gplan-where' }, icon('pin', 14), ' ', el('strong', null, place ?? p?.name ?? t('plan.center')), p?.name && place ? ` · ${p.name}` : '');
      if (!withMap) { centralPlan(reads, p!, box, where); return; }
      const map = portalMap(data!, {
        selected: target?.id ?? null,
        mode: 'map',
        label: options.label ?? place ?? t('plan.house'),
        feedbackId: 'guests.info.plano.mapa',
        offline: plansLoaded?.stale ?? false,
        layer: (s) => (target && s.id === target.id ? { tone: 'accent', label: t('plan.here') } : null),
        // Sin un sitio, el mapa entero empieza en la finca y se baja tocando (finca → edificio → habitación).
        ...(!target && options.whole && estateOf(data!) ? { drill: true, plan: estateOf(data!) } : {}),
      });
      // El plano de Central, debajo y plegado: respaldo mientras el dibujo de zonas se completa.
      const backup = p?.site_plan_file_id ? el('details', { class: 'gplan-backup', 'data-feedback-id': 'guests.info.plano.centro', 'data-feedback-label': 'El plano del centro (Central)' },
        el('summary', null, t('plan.centerBackup'))) as HTMLDetailsElement : null;
      if (backup) {
        const inner = el('div');
        backup.append(inner);
        backup.addEventListener('toggle', () => { if (backup.open && !inner.childNodes.length) centralPlan(reads, p!, inner, el('span')); }, { once: false });
      }
      replace(box, target ? where : null, map.element, backup);
    });
    replace(host, details);
  }).catch(() => undefined);
  return host;
}
