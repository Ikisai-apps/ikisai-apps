/**
 * Fase R2 de Recursos (RECURSOS.md §4.2 y §17): «Espacios y camas» con el árbol común del kit cuando el interruptor está en
 * `resources`, y la tarjeta del owner para pasar a Recursos (vista previa del enlace, «Enlazar» e interruptor).
 * Decisión del usuario (13-10-2026): crear, cambiar o quitar espacios y camas, solo dirección (owner).
 * vg-52 (VG, 28-10-2026): los espacios se crean, renombran y mueven solo en Central › Planos › Colocar. Aquí el árbol es de
 * lectura para los espacios, con el enlace a Central, y Booking se queda con las camas: «Añadir cama» y «Quitar» (dirección)
 * y sus plazas (fijas y supletorias) y tipo («Plazas», también el editor).
 */
import { createSyncClient, type RowOperation, type SyncClient, type SyncedRow, type TableName } from '@ikisai/sync-client';
import { confirmDialog, createSpaceTree, createSyncSpaceSource, el, fieldAttrs, openSheet, replace, toast, type Sheet, type SpaceRow, type SpaceRowAction } from '@ikisai/ui-kit';
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
/** Central › Planos (vg-52): ahí se crean, renombran y colocan los espacios. */
export const CENTRAL_PLANS_URL = 'https://central.ikisai.com/#/entidad/planos';
const BED_KINDS: Array<[string, string]> = [['litera', 'Litera'], ['individual', 'Individual'], ['doble', 'Doble'], ['sofa_cama', 'Sofá cama']];

/** Árbol de Recursos limitado a lo que usa Booking (alturas y edificios, para la ruta, y lo de dentro). */
export function mountResourcesSpaces(host: HTMLElement, client: SyncClient): () => void {
  const role = client.bootstrap()?.membership.role;
  const owner = role === 'owner';
  const writer = owner || role === 'editor';
  const resources = createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: client, clearOnLogout: true });
  const source = createSyncSpaceSource(resources, { onError: (message) => toast(`No se ha guardado: ${message}`) });
  const container = el('div');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tree = createSpaceTree({
    source, container, label: 'Espacios y camas', feedbackId: 'booking.espacios.arbol', storageKey: 'booking.espacios.arbol',
    // vg-52: de lectura para los espacios (ni crear, ni renombrar, ni mover: eso es de Central)
    permissions: { edit: false, structure: false },
    filter: (row) => BOOKING_KINDS.has(row.kind),
    // Las camas, a un toque en la fila. Texto corto para que quepa en el móvil: el kit pone el nombre en la etiqueta accesible.
    rowActions: (row): SpaceRowAction[] => {
      if (!row.active) return [];
      if (['habitacion', 'sala'].includes(row.kind)) return owner ? [{ label: 'Añadir cama', feedbackId: 'booking.espacios.arbol.anadir_cama', onClick: (r) => tree.create(r.id, 'cama') }] : [];
      if (row.kind !== 'cama') return [];
      return [
        ...(writer ? [{ label: 'Plazas', feedbackId: 'booking.espacios.arbol.plazas', onClick: (r: SpaceRow) => openSeats(r) }] : []),
        ...(owner ? [{ label: 'Quitar', feedbackId: 'booking.espacios.arbol.quitar_cama', onClick: (r: SpaceRow) => void removeBed(r) }] : []),
      ];
    },
  });

  /** Tipo de cama y plazas fijas y supletorias (Recursos: `bed_kind`, `capacity`, `extra_capacity`). */
  function openSeats(r: SpaceRow): void {
    const a = r.attributes ?? {};
    const kind = el('select', { id: 'bedKind', ...fieldAttrs({ id: 'booking.espacios.cama.tipo', entity: 'resources.spaces', prop: 'attributes', label: 'Tipo de cama', confirm: 'event' }) },
      BED_KINDS.map(([v, t]) => el('option', { value: v }, t))) as HTMLSelectElement;
    kind.value = String(a.bed_kind ?? 'individual');
    const num = (id: string, fid: string, label: string, value: unknown) => el('input', { id, type: 'number', min: 0, max: 2, step: 1, inputmode: 'numeric', value: String(Number(value ?? 0)),
      ...fieldAttrs({ id: fid, entity: 'resources.spaces', prop: 'attributes', label, confirm: 'event' }) }) as HTMLInputElement;
    const fixed = num('bedFixed', 'booking.espacios.cama.fijas', 'Plazas fijas', a.capacity ?? 1);
    const extra = num('bedExtra', 'booking.espacios.cama.supletorias', 'Plazas supletorias', a.extra_capacity ?? 0);
    const save = el('button', { class: 'primary', type: 'button', id: 'bedSeatsSave', 'data-feedback-id': 'booking.espacios.cama.guardar', 'data-feedback-label': 'Guardar', onclick: async () => {
      const f = Math.round(Number(fixed.value)); const x = Math.round(Number(extra.value));
      if (![f, x].every((n) => Number.isInteger(n) && n >= 0 && n <= 2) || f + x < 1) return void toast('Las plazas van de 0 a 2, y al menos una en total.');
      save.disabled = true;
      try {
        await source.update(r.id, { attributes: { ...a, bed_kind: kind.value, capacity: f, extra_capacity: x } });
        await sheet.close(true);
        toast('Plazas guardadas.');
      } catch (error) { toast(describeError(error)); save.disabled = false; }
    } }, 'Guardar') as HTMLButtonElement;
    const sheet: Sheet = openSheet({ title: `Plazas · ${r.name}`, body: el('div', { 'data-feedback-id': 'booking.espacios.cama', 'data-feedback-label': 'Plazas de la cama' },
      el('label', { class: 'field' }, el('span', null, 'Tipo'), kind),
      el('label', { class: 'field' }, el('span', null, 'Plazas fijas'), fixed),
      el('label', { class: 'field' }, el('span', null, 'Plazas supletorias (la de arriba de una litera, un sofá cama)'), extra)),
      foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')), initialFocus: kind });
  }

  async function removeBed(r: SpaceRow): Promise<void> {
    if (!await confirmDialog({ title: `Quitar ${r.name}`, text: 'La cama se archiva en Recursos y deja de ofrecerse. Se puede recuperar desde Central.', confirmLabel: 'Quitar' })) return;
    try { await source.archive([r.id]); toast('Cama quitada.'); } catch (error) { toast(describeError(error)); }
  }
  const off = owner ? resources.onTable('resources.spaces' as TableName, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncMirror(client), 800);
  }) : () => undefined;
  void resources.start();
  replace(host, el('p', { class: 'hint' }, 'Los espacios y las camas son los de Recursos, comunes a todas las apps. Las camas y sus plazas se gestionan aquí; los espacios se crean, renombran y colocan en Central.'),
    el('p', null, el('a', { class: 'ghost small', href: CENTRAL_PLANS_URL, target: '_blank', rel: 'noopener', id: 'spacesInCentral', 'data-feedback-id': 'booking.espacios.central', 'data-feedback-label': 'Crear o renombrar espacios en Central' },
      'Crear, renombrar o colocar espacios en Central › Planos')),
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
