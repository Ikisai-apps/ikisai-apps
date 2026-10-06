import type { PendingConflict, RejectedBatch } from '@ikisai/sync-client';
import { el, renderConflicts, renderRejectedList, replace, toast, type ConflictDecision } from '@ikisai/ui-kit';
import { describeError, statusLabel } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

const FIELD_LABELS: Record<string, string> = {
  title: 'Nombre', event_type: 'Tipo', status: 'Estado', start_date: 'Entrada', end_date: 'Salida', expected_guests: 'Personas previstas',
  contact_name: 'Contacto', contact_phone: 'Teléfono', final_guests: 'Personas finales', deleted_at: 'Borrado',
};

/** Lo que espera una decisión: conflictos con otra persona (contrato §6.3) y lotes que el servidor rechazó. */
export const mountPending: ViewMount = ({ main, client }) => {
  const conflictsHost = el('div');
  const rejectedHost = el('div');
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Por resolver'), el('p', null, 'Cambios tuyos que no se pudieron aplicar tal cual. Nada se pierde hasta que decidas.'))),
    el('div', { class: 'sectionlabel' }, 'Conflictos'),
    conflictsHost,
    el('div', { class: 'sectionlabel', style: 'margin-top:18px' }, 'Rechazados por el servidor'),
    rejectedHost,
  );

  async function resolve(conflict: PendingConflict, decision: ConflictDecision): Promise<void> {
    try {
      await client.resolveConflict(conflict.requestId, decision);
      toast('Conflicto resuelto. Se enviará tu decisión al servidor.');
    } catch (error) {
      toast(describeError(error));
    }
    await load();
  }

  async function retry(batch: RejectedBatch): Promise<void> {
    try {
      await client.retryRejected(batch.requestId);
      toast('Se volverá a enviar.');
    } catch (error) {
      toast(describeError(error));
    }
    await load();
  }

  async function discard(batch: RejectedBatch): Promise<void> {
    await client.discardRejected(batch.requestId);
    await load();
  }

  async function load(): Promise<void> {
    const [conflicts, rejected] = await Promise.all([client.conflicts(), client.rejected()]);
    replace(conflictsHost, renderConflicts(conflicts, {
      fieldLabels: FIELD_LABELS,
      show: (field, value) => (field === 'status' ? statusLabel(value) : value === null || value === undefined || value === '' ? '—' : String(value)),
      onResolve: resolve,
      emptyTitle: 'Sin conflictos',
      emptyText: 'Todo lo tuyo se ha podido aplicar sin pisar cambios de nadie.',
    }));
    replace(rejectedHost, rejected.length === 0
      ? el('div', { class: 'empty plain' }, 'Ningún cambio rechazado.')
      : renderRejectedList(rejected, { describeError: (error) => describeError(error), onRetry: retry, onDiscard: discard }));
  }

  void load();
  const off = client.onStatus(() => void load());
  return () => off();
};
