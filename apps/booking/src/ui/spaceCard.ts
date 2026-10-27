/**
 * Espacios y camas con plano (tanda 36, MUELA-049; VG: «Plano y ficha» con «Monta el dormitorio»):
 * - El plano del edificio (`createSpaceMap` del kit) con la capa de camas de esta noche: libre, ocupada o no se puede,
 *   con el número de la pieza. Las formas y los dibujos son los de Recursos (el espacio de Booking enlazado por
 *   `resource_id`); sin dibujo o sin formas, la pieza enseña la lista equivalente.
 * - Al tocar una estancia, su ficha: medallón, ruta, tipo y plazas; «Datos del espacio» plegados y «Monta el dormitorio»
 *   abierto. Sin plano, la ficha se abre desde el nombre en la lista de siempre.
 * - Se empieza en la finca y se baja al edificio y al dormitorio tocando (`drill`, kit 0.63), sin decoración (VG,
 *   27-10-2026: «Espacios y camas» sin decoración; la decoración es del «Montaje»).
 */
import { createSyncClient, type SyncClient, type SyncedRow } from '@ikisai/sync-client';
import { createSpaceMap, createSyncSpaceSource, el, plural, renderMedal, replace, type FloorPlan, type SpaceMap, type SpaceRow } from '@ikisai/ui-kit';
import { extraCapacity, spaceCapacity } from '@ikisai/domain-booking';
import { label } from '../app/labels.ts';
import { bookingMapRows, estatePlanId, FLOOR_PLANS, staticSource } from './bedMap.ts';
import { createDormitorio } from './dormitorio.ts';

type Row = SyncedRow & Record<string, any>;

export interface SpacesData {
  spaces: Row[];
  beds: Row[];
  assignments: Row[];
  /** Camas ocupadas esta noche. */
  occupied: ReadonlySet<string>;
}

export interface SpaceCardOptions {
  client: SyncClient;
  owner: boolean;
  writable: boolean;
  fromResources: () => boolean;
  /** Abre la hoja de siempre para editar los datos del espacio. */
  edit: (space: Row) => void;
}

/** Camas ocupadas esta noche: asignaciones vivas de reservas en marcha, con sus noches [entrada, salida). */
export function occupiedTonight(assignments: Row[], events: Row[], reservations: Row[], today: string): Set<string> {
  const eventById = new Map(events.filter((e) => !e.deleted_at).map((e) => [e.id, e]));
  const resById = new Map(reservations.filter((r) => !r.deleted_at && !['cancelada', 'perdida'].includes(r.status)).map((r) => [r.id, r]));
  const out = new Set<string>();
  for (const a of assignments) {
    if (!a.bed_id || a.deleted_at) continue;
    const r = resById.get(eventById.get(a.event_id)?.reservation_id);
    const from = a.from_date ?? r?.start_date, to = a.to_date ?? r?.end_date;
    if (r && from && to && from <= today && today < to) out.add(a.bed_id);
  }
  return out;
}

/** La ficha (y el plano, si hay formas) de «Espacios y camas». */
export function createSpaceCard(o: SpaceCardOptions) {
  const mapHost = el('div', { class: 'bk-space-map', id: 'spacePlan' });
  const card = el('section', { class: 'card bk-space-card', id: 'spaceCard', hidden: true, 'aria-live': 'polite', 'data-feedback-id': 'booking.espacios.ficha', 'data-feedback-label': 'Ficha del espacio' });
  const element = el('div', { class: 'bk-space-top' }, mapHost, card);
  let data: SpacesData = { spaces: [], beds: [], assignments: [], occupied: new Set() };
  let selected: string | null = null;
  let dormitorio: { spaceId: string; revisionSig: string; instance: ReturnType<typeof createDormitorio> } | null = null;
  let resources: { client: SyncClient; source: ReturnType<typeof createSyncSpaceSource>; off: () => void } | null = null;
  let map: SpaceMap | null = null;
  let mapRows: SpaceRow[] = [];
  const listeners = new Set<(rows: SpaceRow[]) => void>();
  let destroyed = false;

  /** Fuente del plano: los espacios de Booking con la forma de su pareja en Recursos. Solo se lee (no se edita desde aquí). */
  const source = staticSource(() => mapRows, listeners);

  async function buildRows(): Promise<{ rows: SpaceRow[]; plans: FloorPlan[]; estate: string | null }> {
    let resourceRows: SpaceRow[] = [];
    let plans: FloorPlan[] = [];
    let estate: string | null = null;
    if (resources) {
      try {
        resourceRows = await resources.source.list();
        plans = await resources.source.plans.list();
        estate = estatePlanId(await resources.client.list(FLOOR_PLANS));
      } catch { /* sin Recursos: la lista equivalente */ }
    }
    return { rows: bookingMapRows(resourceRows, data.spaces, data.beds), plans, estate };
  }

  /** Recursos solo se abre si algo está enlazado (o con los espacios en Recursos): sin enlaces no hay formas que leer. */
  function ensureResources(): void {
    if (resources || destroyed) return;
    if (!o.fromResources() && !data.spaces.some((s) => s.resource_id)) return;
    const client = createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: o.client, clearOnLogout: true });
    const rs = createSyncSpaceSource(client);
    const off = rs.subscribe(() => void paintMap());
    resources = { client, source: rs, off };
    void client.start();
  }

  async function paintMap(): Promise<void> {
    ensureResources();
    const { rows, plans, estate } = await buildRows();
    if (destroyed) return;
    mapRows = rows;
    const withShape = rows.some((r) => r.planShape);
    // Sin formas y con los espacios de Booking, la lista de siempre ya abre la ficha: no se repite.
    if (!withShape && !o.fromResources()) {
      map?.destroy(); map = null;
      return void replace(mapHost);
    }
    if (!map) {
      map = createSpaceMap({
        source, plans, label: 'Plano de los espacios', feedbackId: 'booking.espacios.plano', drill: true, showDecor: false, ...(estate ? { plan: estate } : {}),
        planUrl: (fileId) => `/api/v1/resources/files/${fileId}`,
        layer: (s) => {
          if (s.kind !== 'cama') return null;
          const bed = data.beds.find((b) => b.id === s.id);
          if (!bed || bed.active === false) return { state: 'off', label: 'Inactiva' };
          return data.occupied.has(bed.id) ? { state: 'occupied', label: 'Ocupada esta noche' } : { state: selected === bed.space_id ? 'picked' : 'free', label: 'Libre esta noche' };
        },
        // la finca, los edificios y las plantas son de Recursos: solo bajan, no abren ficha
        onPick: (s) => { const id = s.kind === 'cama' ? (s.parentId ?? s.id) : s.id; if (data.spaces.some((x) => x.id === id)) pick(id); },
        selected,
      });
      replace(mapHost, el('h3', { class: 'sectionlabel' }, 'Plano'), map.element);
    }
    listeners.forEach((l) => l(rows));
    await map.refresh();
    map.repaint();
  }

  function pick(id: string | null): void {
    selected = id;
    map?.select(id);
    map?.repaint();
    paintCard();
    if (id) card.scrollIntoView({ block: 'nearest' });
  }

  function paintCard(): void {
    const space = selected ? data.spaces.find((s) => s.id === selected) : null;
    if (!space) { card.hidden = true; dormitorio?.instance.destroy(); dormitorio = null; return void replace(card); }
    card.hidden = false;
    const own = data.beds.filter((b) => b.space_id === space.id);
    const places = spaceCapacity(space as never, own as never), extra = extraCapacity(space as never, own as never);
    const free = own.filter((b) => b.active !== false && !data.occupied.has(b.id)).length;
    const path = [space.zone, label(space.kind)].filter(Boolean).join(' · ');
    const fromResources = o.fromResources();

    // «Monta el dormitorio»: se conserva mientras se edita (el borrador no se pierde al llegar datos nuevos).
    const sig = `${space.id}:${space.revision}:${own.map((b) => `${b.id}:${b.revision}`).join('|')}:${[...data.occupied].sort().join(',')}`;
    if (!dormitorio || dormitorio.spaceId !== space.id || (!dormitorio.instance.editing() && dormitorio.revisionSig !== sig)) {
      dormitorio?.instance.destroy();
      dormitorio = { spaceId: space.id, revisionSig: sig, instance: createDormitorio({ client: o.client, space, beds: own, assignments: data.assignments, occupied: data.occupied, canEdit: o.owner && space.kind !== 'zona_exterior', fromResources }) };
    }
    const kv = (dt: string, dd: string | null) => (dd ? [el('dt', null, dt), el('dd', null, dd)] : []);
    replace(card,
      el('div', { class: 'bk-space-head' },
        renderMedal({ name: String(space.name), size: 44 }),
        el('div', null,
          el('h3', { id: 'spaceCardTitle' }, String(space.name)),
          el('p', { class: 'hint' }, path),
          el('p', { id: 'spaceCardPlaces' }, own.length || space.kind === 'habitacion'
            ? `${plural(places, 'plaza', 'plazas')}${extra ? ` + ${plural(extra, 'supletoria', 'supletorias')}` : ''} · ${plural(free, 'cama libre', 'camas libres')} esta noche`
            : space.capacity ? `Capacidad: ${plural(Number(space.capacity), 'persona', 'personas')}` : 'Sin camas')),
        el('button', { type: 'button', class: 'iconbtn', id: 'spaceCardClose', 'aria-label': `Cerrar la ficha de ${space.name}`, 'data-feedback-id': 'booking.espacios.ficha.cerrar', 'data-feedback-label': 'Cerrar la ficha', onclick: () => pick(null) }, '×')),
      el('div', { class: 'btnrow' },
        space.accessible ? el('span', { class: 'chip' }, 'Accesible') : null,
        space.active === false ? el('span', { class: 'chip' }, 'Inactivo') : null,
        space.bookable === false ? el('span', { class: 'chip' }, 'No reservable') : null),
      el('details', { class: 'bk-fold', id: 'spaceCardData', 'data-feedback-id': 'booking.espacios.ficha.datos', 'data-feedback-label': 'Datos del espacio' },
        el('summary', null, 'Datos del espacio'),
        el('dl', { class: 'kv' },
          ...kv('Tipo', label(space.kind)), ...kv('Zona', space.zone ?? null), ...kv('Nombre para el público', space.public_name ?? null),
          ...kv('Capacidad', !own.length && space.capacity !== null && space.capacity !== undefined ? String(space.capacity) : null),
          ...kv('Accesible', space.accessible ? 'Sí' : 'No'), ...kv('Reservable', space.bookable === false ? 'No' : 'Sí'), ...kv('Notas', space.notes ?? null)),
        o.writable && !fromResources ? el('p', null, el('button', { type: 'button', class: 'ghost small', id: 'spaceCardEdit', 'data-feedback-id': 'booking.espacios.ficha.editar', 'data-feedback-label': 'Editar el espacio', onclick: () => o.edit(space) }, 'Editar')) : null),
      space.kind === 'zona_exterior'
        ? el('p', { class: 'hint' }, 'Una zona exterior no tiene camas.')
        : el('details', { class: 'bk-fold', id: 'spaceCardDorm', open: true, 'data-feedback-id': 'booking.espacios.ficha.dormitorio', 'data-feedback-label': 'Monta el dormitorio' },
          el('summary', null, 'Monta el dormitorio'), dormitorio.instance.element));
  }

  return {
    element,
    /** Datos nuevos de la pantalla. */
    update(next: SpacesData): void {
      data = next;
      if (selected && !data.spaces.some((s) => s.id === selected)) selected = null;
      void paintMap();
      paintCard();
    },
    pick,
    destroy(): void {
      destroyed = true;
      map?.destroy();
      dormitorio?.instance.destroy();
      if (resources) { resources.off(); resources.source.destroy(); resources.client.stop(); }
      listeners.clear();
    },
  };
}
