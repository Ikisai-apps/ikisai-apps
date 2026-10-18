/**
 * Fase R2 de Recursos (RECURSOS.md §4.2 y §17): «Espacios y camas» con el árbol común del kit cuando el interruptor está en
 * `resources`, y la tarjeta del owner para pasar a Recursos (vista previa del enlace, «Enlazar» e interruptor).
 * Decisión del usuario (13-10-2026): crear, cambiar o quitar espacios y camas, solo dirección (owner).
 */
import { createSyncClient, type RowOperation, type SyncClient, type SyncedRow, type TableName } from '@ikisai/sync-client';
import { confirmDialog, createSpaceTree, createSyncSpaceSource, el, replace, toast, type SpaceRowAction } from '@ikisai/ui-kit';
import { TABLES } from '@ikisai/domain-booking';
import { describeError } from '../app/client.ts';

type Row = SyncedRow & Record<string, any>;
export const MODULE_SETTINGS: TableName = TABLES.moduleSettings as TableName;

/** Fuente de espacios y camas según el interruptor (sin fila o sin permiso de lectura: la de hoy). */
export async function spacesSource(client: SyncClient): Promise<'booking' | 'resources'> {
  try {
    const row = ((await client.list(MODULE_SETTINGS)) as Row[]).find((r) => !r.deleted_at);
    return row?.spaces_source === 'resources' ? 'resources' : 'booking';
  } catch {
    return 'booking';
  }
}

/** Manda al espejo de Booking lo que falta tras un cambio en Recursos (el tick lo haría en un minuto; así no se espera). */
async function syncMirror(client: SyncClient): Promise<void> {
  if (!navigator.onLine) return;
  try {
    const pending = await client.api<{ operations: RowOperation[] }>('/read/booking.spaces_mirror_pending', { method: 'POST', json: {} });
    if (pending.operations?.length) await client.commit(pending.operations);
  } catch { /* lo recoge el tick */ }
}

const BOOKING_KINDS = new Set(['edificio', 'habitacion', 'sala', 'exterior', 'cama']);

/** Árbol de Recursos limitado a lo que usa Booking (alturas y edificios, para la ruta, y lo de dentro). */
export function mountResourcesSpaces(host: HTMLElement, client: SyncClient): () => void {
  const role = client.bootstrap()?.membership.role;
  const owner = role === 'owner';
  const resources = createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: client, clearOnLogout: true });
  const source = createSyncSpaceSource(resources, { onError: (message) => toast(`No se ha guardado: ${message}`) });
  const container = el('div');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tree = createSpaceTree({
    source, container, label: 'Espacios y camas', feedbackId: 'booking.espacios.arbol', storageKey: 'booking.espacios.arbol',
    permissions: { edit: role === 'editor' || owner, structure: owner },
    filter: (row) => BOOKING_KINDS.has(row.kind),
    // «Añadir cama» y «Duplicar» a un toque en la fila, como hoy (solo dirección). Texto corto para que quepa en el móvil:
    // el kit ya pone el nombre del espacio en la etiqueta accesible («Añadir cama: Hab 1»).
    rowActions: (row): SpaceRowAction[] => !owner || !['habitacion', 'sala'].includes(row.kind) ? [] : [
      { label: 'Añadir cama', feedbackId: 'booking.espacios.arbol.anadir_cama', onClick: (r) => tree.create(r.id, 'cama') },
      { label: 'Duplicar', feedbackId: 'booking.espacios.arbol.duplicar', onClick: (r) => void tree.duplicate(r.id) },
    ],
  });
  const off = owner ? resources.onTable('resources.spaces' as TableName, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncMirror(client), 800);
  }) : () => undefined;
  void resources.start();
  replace(host, el('p', { class: 'hint' }, owner ? 'Los espacios y las camas son los de Recursos, comunes a todas las apps.' : 'Los espacios y las camas son los de Recursos. Solo dirección los crea, mueve o quita.'),
    tree.element, container);
  return () => {
    if (timer) clearTimeout(timer);
    off();
    tree.destroy();
    source.destroy();
  };
}

interface Preview {
  source: 'booking' | 'resources';
  counts: Record<string, number>;
  rows: Array<{ tbl: string; row_id: string; revision: number; field: string; booking_name: string | null; resource_id: string | null; resource_name: string | null; status: string }>;
  spaces_without_twin: Array<{ name: string }>;
  beds_without_twin: Array<{ label: string; space: string }>;
}

/** Tarjeta del owner: vista previa del enlace con Recursos, «Enlazar» y el interruptor (con vuelta atrás). */
export function resourcesCard(client: SyncClient, onSwitch: () => void): HTMLElement | null {
  if (client.bootstrap()?.membership.role !== 'owner') return null;
  const body = el('div', null, el('p', { class: 'hint' }, 'Cargando la vista previa…'));
  const card = el('article', { class: 'card', id: 'resourcesCard', 'data-feedback-id': 'booking.espacios.recursos', 'data-feedback-label': 'Espacios desde Recursos' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Espacios desde Recursos')), body);

  async function paint(): Promise<void> {
    if (!navigator.onLine) return void replace(body, el('p', { class: 'hint' }, 'La vista previa necesita conexión.'));
    let preview: Preview;
    try {
      preview = await client.api<Preview>('/read/booking.r2_preview', { method: 'POST', json: {} });
    } catch (error) {
      return void replace(body, el('p', { class: 'hint' }, `La vista previa no está disponible: ${describeError(error)}`));
    }
    const pending = preview.rows.filter((r) => r.status === 'por_enlazar');
    const doubtful = preview.rows.filter((r) => r.status === 'sin_pareja' || r.status === 'tipo_distinto');
    const on = preview.source === 'resources';
    replace(body,
      el('p', null, on ? 'Ahora: espacios y camas de Recursos.' : 'Ahora: espacios y camas de Booking.'),
      el('dl', { class: 'kv', id: 'resourcesCounts' },
        el('dt', null, 'Ya enlazadas'), el('dd', null, String(preview.counts.enlazada ?? 0)),
        el('dt', null, 'Por enlazar'), el('dd', null, String(pending.length)),
        el('dt', null, 'Dudosas'), el('dd', null, String(doubtful.length)),
        el('dt', null, 'Espacios sin pareja'), el('dd', null, String(preview.spaces_without_twin.length)),
        el('dt', null, 'Camas sin pareja'), el('dd', null, String(preview.beds_without_twin.length))),
      doubtful.length ? el('ul', { class: 'list', id: 'resourcesDoubtful' }, doubtful.map((r) => el('li', { class: 'row' },
        `${r.booking_name ?? '—'} (${r.tbl.split('.').pop()}): ${r.status === 'sin_pareja' ? 'sin pareja en Recursos' : 'tipo distinto'}`))) : null,
      preview.spaces_without_twin.length ? el('p', { class: 'hint' }, `Sin pareja en Recursos: ${preview.spaces_without_twin.map((s) => s.name).join(', ')}. Créalos en Recursos o quítalos aquí antes de pasar.`) : null,
      el('div', { class: 'btnrow' },
        pending.length ? el('button', { class: 'ghost small', type: 'button', id: 'resourcesLink', 'data-feedback-id': 'booking.espacios.recursos.enlazar', 'data-feedback-label': 'Enlazar con Recursos',
          onclick: () => void link(pending) }, `Enlazar ${pending.length}`) : null,
        el('button', { class: on ? 'ghost small' : 'primary small', type: 'button', id: 'resourcesSwitch', 'data-feedback-id': 'booking.espacios.recursos.interruptor', 'data-feedback-label': 'Cambiar la fuente de espacios',
          onclick: () => void toggle(on, pending.length + doubtful.length) }, on ? 'Volver a los espacios de Booking' : 'Usar los espacios de Recursos')));
  }

  async function link(pending: Preview['rows']): Promise<void> {
    const byRow = new Map<string, RowOperation>();
    for (const r of pending) {
      const op = byRow.get(r.row_id) ?? { op: 'update', table: r.tbl as TableName, id: r.row_id, expectedRevision: Number(r.revision), fields: {} } as RowOperation & { fields: Record<string, unknown> };
      (op as any).fields[r.field === 'bed' ? 'resource_bed_id' : 'resource_space_id'] = r.resource_id;
      byRow.set(r.row_id, op);
    }
    try {
      await client.commit([...byRow.values()]);
      toast(`Enlazadas ${byRow.size}.`);
    } catch (error) {
      toast(describeError(error));
    }
    await paint();
  }

  async function toggle(on: boolean, unresolved: number): Promise<void> {
    const row = ((await client.list(MODULE_SETTINGS)) as Row[]).find((r) => !r.deleted_at);
    if (!row) return void toast('No se encuentra el ajuste. Sincroniza y vuelve a intentarlo.');
    const ok = await confirmDialog(on
      ? { title: 'Volver a los espacios de Booking', text: 'Booking deja de copiar los espacios de Recursos y se vuelven a editar aquí. No se pierde nada.', confirmLabel: 'Volver' }
      : { title: 'Usar los espacios de Recursos', text: unresolved ? `Quedan ${unresolved} filas por enlazar o dudosas: se quedan como están. Puedes volver atrás cuando quieras.` : 'Los espacios y las camas pasan a ser los de Recursos. Puedes volver atrás cuando quieras.', confirmLabel: 'Usar Recursos' });
    if (!ok) return;
    try {
      await client.commit([{ op: 'update', table: MODULE_SETTINGS, id: row.id, expectedRevision: row.revision, fields: { spaces_source: on ? 'booking' : 'resources' } }]);
      if (!on) await syncMirror(client);
      toast(on ? 'Espacios de Booking.' : 'Espacios de Recursos.');
      onSwitch();
    } catch (error) {
      toast(describeError(error));
    }
  }

  void paint();
  return card;
}
