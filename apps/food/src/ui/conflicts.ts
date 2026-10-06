import type { PendingConflict } from '@ikisai/sync-client';
import { confirmDialog, el, formatDate, renderConflicts, renderRejectedList, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

const FIELD_LABELS: Record<string, string> = {
  name: 'Nombre', public_name: 'Nombre público', public_description: 'Descripción pública', category: 'Categoría', base_servings: 'Raciones base',
  method: 'Elaboración', conservation: 'Conservación', freezable: 'Congelable', regeneration: 'Regeneración', service_notes: 'Notas de servicio',
  prep_minutes: 'Antelación (min)', status: 'Estado', diet_tags: 'Dietas', allergens: 'Alérgenos', allergens_checked: 'Alérgenos revisados',
  photo_file_id: 'Foto', photo_thumb_file_id: 'Miniatura', preferred_unit: 'Unidad preferida', preferred_supplier: 'Proveedor habitual', active: 'Activo',
  quantity: 'Cantidad', unit: 'Unidad', notes: 'Notas', capacity: 'Capacidad', location: 'Ubicación', quantity_required: 'Unidades necesarias',
  deleted_at: 'Borrado',
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'deleted_at') return formatDate(String(value));
  if (field === 'photo_file_id' || field === 'photo_thumb_file_id') return 'Foto';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

/** Conflictos (§6.3) y lotes rechazados por el servidor, con los componentes del kit. */
export const mountConflicts: ViewMount = ({ main, client, navigate }) => {
  const conflictHost = el('div', { id: 'conflictList' });
  const rejectedHost = el('div', { id: 'rejectedList' });
  const rejectedSection = el('section', { hidden: true }, el('div', { class: 'sectionlabel' }, 'Rechazados por el servidor'), rejectedHost);
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Conflictos'), el('p', null, 'Otra persona cambió lo mismo que tú. Nada se pierde hasta que decidas.'))),
    conflictHost,
    rejectedSection,
  );

  async function resolve(conflict: PendingConflict, decision: Parameters<typeof client.resolveConflict>[1]): Promise<void> {
    try {
      await client.resolveConflict(conflict.requestId, decision);
      toast('Conflicto resuelto. Se enviará tu decisión al servidor.');
      await load();
      if ((await client.conflicts()).length === 0 && (await client.rejected()).length === 0) navigate('#/recetario');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function load(): Promise<void> {
    const [conflicts, rejected] = await Promise.all([client.conflicts(), client.rejected()]);
    replace(conflictHost, ...renderConflicts(conflicts, { fieldLabels: FIELD_LABELS, show, onResolve: resolve }));
    rejectedSection.hidden = rejected.length === 0;
    replace(rejectedHost, ...renderRejectedList(rejected, {
      describeError: (error) => describeError(error),
      onRetry: async (batch) => {
        try {
          await client.retryRejected(batch.requestId);
          toast('Reintentando el envío.');
          await load();
        } catch (error) {
          toast(describeError(error));
        }
      },
      onDiscard: async (batch) => {
        if (!(await confirmDialog({ title: '¿Descartar estos cambios?', text: 'Se olvidarán en este dispositivo; el servidor conserva su versión.', confirmLabel: 'Descartar', danger: true }))) return;
        await client.discardRejected(batch.requestId);
        toast('Cambios descartados.');
        await load();
      },
    }));
  }

  void load();
  const off = client.onStatus(() => void load());
  return () => off();
};
