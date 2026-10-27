/**
 * «Montaje» en la ficha del evento (encargo de VG del 27-10-2026; DECORACION_Y_FINCA.md; docs/booking/API.md §34): el
 * plano de la finca con la decoración general y los cambios de este evento encima (añadir, quitar o sustituir piezas).
 * - Editor u owner en el ordenador: se ponen, se mueven, se giran y se quitan objetos (`createSpaceMap({ decorEdit })`).
 *   Cada cambio va a Recursos (`resources.set_event_decor`) y después a Tasks (`POST montage/:id/sync`), que tiene una
 *   tarea hija de «Montaje del evento» por objeto.
 * - En el móvil (o sin permiso de escritura) solo se ve.
 * - Se baja de la finca al edificio y a la habitación tocando (`drill`).
 */
import { createSyncClient, type SyncClient, type SyncedRow } from '@ikisai/sync-client';
import { createSpaceMap, createSyncSpaceSource, el, floorPlanFromRow, plural, replace, toast, type DecorChange, type DecorIcon, type DecorItem, type FloorPlan, type SpaceMap } from '@ikisai/ui-kit';
import { montage } from '@ikisai/domain-booking';
import { describeError } from '../app/client.ts';
import { settleBatch } from '../app/settle.ts';
import { estatePlanId, FLOOR_PLANS } from './bedMap.ts';

type Row = SyncedRow & Record<string, any>;
const DECOR = 'resources.decor_items';
const ICONS = 'resources.decor_icons';
const fileUrl = (id: string) => `/api/v1/resources/files/${id}`;

/** Fila de `resources.decor_items` → la forma del dominio (con su revisión, para cambiarla). */
export function decorRowOf(r: Row): montage.DecorRow & { revision: number } {
  return {
    id: r.id, planId: r.plan_id, iconId: r.icon_id ?? null, cellX: Number(r.cell_x), cellY: Number(r.cell_y), scale: Number(r.scale ?? 1),
    size: Number(r.size) === 4 ? 4 : 1, rotation: Number(r.rotation ?? 0), layer: r.layer === 'event' ? 'event' : 'general', eventId: r.event_id ?? null,
    op: r.op === 'remove' || r.op === 'replace' ? r.op : 'add', replacesItemId: r.replaces_item_id ?? null, revision: Number(r.revision),
  };
}

export interface MontageOptions {
  client: SyncClient;
  reservationId: string;
  event: Row;
  /** Editor u owner, y la reserva no está en la papelera. */
  editable: boolean;
  /** Ordenador (la misma consulta que la ficha). */
  wide: MediaQueryList;
}

export function createMontage(o: MontageOptions): { element: HTMLElement; destroy(): void } {
  const eventId = String(o.event.id);
  const host = el('div', { class: 'bk-montage-map', id: 'montageMap' });
  const note = el('p', { class: 'hint', id: 'montageNote' });
  const status = el('p', { class: 'hint', id: 'montageStatus', 'aria-live': 'polite' });
  const element = el('article', { class: 'card', id: 'blockMontage', hidden: true, 'data-feedback-id': 'booking.reserva.montaje', 'data-feedback-label': 'Montaje' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Montaje')), note, host, status);
  const resources = createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: o.client, clearOnLogout: true });
  const source = createSyncSpaceSource(resources);
  let rows: Array<montage.DecorRow & { revision: number }> = [];
  let icons = new Map<string, DecorIcon>();
  let map: SpaceMap | null = null;
  let mapEditing: boolean | null = null;
  let destroyed = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const canEdit = () => o.editable && o.wide.matches;

  function items(): DecorItem[] {
    return montage.resolveEventDecor(rows, eventId).flatMap((r) => {
      const icon = r.iconId ? icons.get(r.iconId) : undefined;
      return icon ? [{ id: r.id, planId: r.planId, iconId: r.iconId, iconUrl: icon.url, cellX: r.cellX, cellY: r.cellY, scale: r.scale as DecorItem['scale'], size: r.size, rotation: r.rotation as DecorItem['rotation'], label: icon.label }] : [];
    });
  }

  function changesText(): string {
    const n = montage.eventChanges(rows, eventId).length;
    return n ? `${plural(n, 'cambio', 'cambios')} sobre la decoración general: ${plural(n, 'tarea', 'tareas')} en «Montaje del evento».` : 'Sin cambios: el evento usa la decoración general.';
  }

  async function load(): Promise<void> {
    const live = (list: SyncedRow[]) => (list as Row[]).filter((r) => !r.deleted_at);
    const [decorRows, iconRows, planRows] = await Promise.all([resources.list(DECOR), resources.list(ICONS), resources.list(FLOOR_PLANS)]).catch(() => [[], [], []] as SyncedRow[][]);
    if (destroyed) return;
    rows = live(decorRows).map(decorRowOf).filter((r) => r.layer === 'general' || r.eventId === eventId);
    icons = new Map(live(iconRows).filter((i) => typeof i.file_id === 'string').map((i): [string, DecorIcon] => [i.id, { id: i.id, url: fileUrl(i.file_id), label: String(i.name ?? 'Objeto'), size: Number(i.default_size) === 4 ? 4 : 1 }]));
    const plans: FloorPlan[] = live(planRows).map((r) => ({ ...floorPlanFromRow(r), grid: r.grid ?? null }));
    const editing = canEdit();
    note.textContent = editing
      ? 'Cambia la decoración solo para este evento: pon, mueve, gira o quita objetos. Cada cambio es una tarea de «Montaje del evento» en Tasks.'
      : o.editable ? 'La decoración de este evento. Se cambia desde el ordenador.' : 'La decoración de este evento.';
    // sin planos (o sin acceso a Recursos) no hay nada que montar: la tarjeta no sale
    element.hidden = !plans.length;
    if (!plans.length) { map?.destroy(); map = null; mapEditing = null; replace(host); return; }
    if (!map || mapEditing !== editing) {
      map?.destroy();
      const estate = estatePlanId(planRows);
      map = createSpaceMap({
        source, plans, mode: 'plan', drill: true, decor: items(), ...(estate ? { plan: estate } : {}),
        label: 'Plano del montaje', feedbackId: 'booking.reserva.montaje.plano', planUrl: fileUrl,
        ...(editing ? { decorEdit: { icons: [...icons.values()], onDecorChange: (change: DecorChange) => void save(change) } } : {}),
      });
      mapEditing = editing;
      replace(host, map.element);
    } else {
      map.setDecor(items());
    }
    if (!busy) status.textContent = changesText();
  }

  /** Un cambio del plano: a Recursos y, un momento después (para juntar varios), la lista entera a Tasks. */
  async function save(change: DecorChange): Promise<void> {
    const args = montage.eventDecorArgs(rows, eventId, change);
    if (!args) return void load();
    try {
      const { requestId } = await resources.commit([{ op: 'call', procedure: 'resources.set_event_decor', args } as never]);
      const rejected = await settleBatch(resources, requestId);
      if (rejected) { toast(describeError(rejected.error)); return void load(); }
    } catch (e) {
      toast(describeError(e));
      return void load();
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncTasks(), 1500);
  }

  async function syncTasks(): Promise<void> {
    if (destroyed) return;
    if (!navigator.onLine) { status.textContent = 'Sin conexión: las tareas de montaje se actualizarán con el siguiente cambio.'; return; }
    busy = true;
    status.textContent = 'Actualizando las tareas de montaje…';
    try {
      const out = await o.client.api<{ status: string; children: number }>(`/montage/${encodeURIComponent(o.reservationId)}/sync`, { method: 'POST', json: {} });
      status.textContent = out.status === 'sent' ? `Tasks al día: ${plural(out.children, 'tarea', 'tareas')} en «Montaje del evento».` : changesText();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      status.textContent = code === 'PROJECT_NOT_READY' ? 'El proyecto del retiro aún no está en Tasks: las tareas se crearán con el siguiente cambio cuando exista.'
        : code === 'NEEDS_ACCESS' ? 'Pide acceso a Recursos: tu cuenta no puede leer la decoración.'
        : `No se han actualizado las tareas: ${describeError(error)}`;
    } finally {
      busy = false;
    }
  }

  const offs = [resources.onTable(DECOR, () => void load()), resources.onTable(ICONS, () => void load()), source.subscribe(() => void map?.refresh())];
  const onWide = () => void load();
  o.wide.addEventListener('change', onWide);
  void resources.start().then(() => load(), () => load());
  return {
    element,
    destroy(): void {
      destroyed = true;
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
      o.wide.removeEventListener('change', onWide);
      map?.destroy();
      source.destroy();
      resources.stop();
    },
  };
}
