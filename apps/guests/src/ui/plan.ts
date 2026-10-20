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
import { createMemorySpaceSource, createSpaceMap, el, icon, replace, toast, type FloorPlan, type SpaceMap, type SpaceMapOptions, type SpaceRow } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
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

/** Filas del kit desde la lectura del portal (solo nombres públicos). */
export function toRows(spaces: PortalSpace[]): SpaceRow[] {
  return spaces.map((s) => ({ id: s.id, parentId: s.parentId, kind: s.kind, name: s.name, publicName: null, code: null, position: s.position ?? 0,
    active: true, notes: null, attributes: {}, planId: s.planId, planShape: s.planShape }));
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

/** El mapa del kit sobre la lectura del portal (Alojamiento y Ayuda ponen su capa, su filtro y su `onPick`). */
export function portalMap(data: PortalPlans, options: Omit<SpaceMapOptions, 'source' | 'plans' | 'planUrl'>): SpaceMap {
  const plans: FloorPlan[] = data.plans.map((x) => ({ id: x.id, buildingId: x.buildingId, floor: x.floor, position: x.position, fileId: x.fileId, width: x.width, height: x.height }));
  return createSpaceMap({
    source: createMemorySpaceSource(toRows(data.spaces)),
    plans,
    planUrl: (fileId) => planImage(data.plans.find((x) => x.fileId === fileId)),
    // Sin números en las camas (056): el estado va en el color, el rayado y el nombre accesible.
    bedNumbers: false,
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
  }).catch((error) => replace(box, where, el('p', { class: 'small' }, describeError(error))));
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
    const data = plansLoaded?.value ?? null;
    const target = data ? findSpace(data.spaces, options.spaceId, options.match ?? (place ? { space: place } : null)) : null;
    const withMap = Boolean(data && data.plans.length && (target || options.whole));
    if (!withMap && !p?.site_plan_file_id) return;
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
