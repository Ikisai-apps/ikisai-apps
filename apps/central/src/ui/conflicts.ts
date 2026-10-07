import type { PendingConflict, SyncedRow } from '@ikisai/sync-client';
import { confirmDialog, el, formatDate, renderConflicts, renderRejectedList, replace, toast } from '@ikisai/ui-kit';
import { AVAILABILITY_LABELS, BASE_ROLE_LABELS, ENGAGEMENT_LABELS, RECORD_STATUS_LABELS, RECORD_TYPE_LABELS, RELATION_LABELS } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

const FIELD_LABELS: Record<string, string> = {
  display_name: 'Nombre', relation: 'Relación', base_role: 'Función', coverage: 'Cobertura', availability: 'Disponibilidad',
  availability_notes: 'Notas de disponibilidad', active: 'Activa', committed_post: 'Puesto comprometido', user_id: 'Cuenta', position: 'Orden',
  legal_name: 'Nombre completo', phone: 'Teléfono', email: 'Correo', engagement: 'Vinculación', engaged_from: 'Desde', engaged_until: 'Hasta',
  emergency_contact: 'Contacto de emergencia', notes: 'Notas', kind: 'Clase', record_type: 'Tipo', title: 'Título', status: 'Estado',
  issued_on: 'Fecha', expires_on: 'Caduca', reviewed_on: 'Revisado', file_id: 'Archivo', deleted_at: 'Borrado',
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
  relation: RELATION_LABELS, base_role: BASE_ROLE_LABELS, availability: AVAILABILITY_LABELS, engagement: ENGAGEMENT_LABELS,
  record_type: RECORD_TYPE_LABELS, status: RECORD_STATUS_LABELS,
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'deleted_at') return formatDate(String(value));
  if (field === 'file_id') return 'Archivo';
  if (field === 'user_id') return 'Cuenta enlazada';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return VALUE_LABELS[field]?.[String(value)] ?? String(value);
}

/** Conflictos (§6.3) y lotes rechazados por el servidor, con los componentes del kit. */
export const mountConflicts: ViewMount = ({ main, client, navigate }) => {
  const conflictHost = el('div', { id: 'conflictList' });
  const rejectedHost = el('div', { id: 'rejectedList' });
  const names = new Map<string, string>();
  function rowName(table: string, row: SyncedRow | null | undefined): string {
    if (!row) return 'Elemento';
    const person = names.get(String(row.person_id ?? row.id)) ?? '';
    switch (table) {
      case T.people: return `Persona: ${String(row.display_name ?? person)}`;
      case T.personPrivate: return `Datos reservados de ${person || 'una persona'}`;
      case T.personRecords: return `${RECORD_TYPE_LABELS[String(row.record_type)] ?? 'Registro'} de ${person || 'una persona'}`;
      default: return 'Elemento';
    }
  }

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
      if ((await client.conflicts()).length === 0 && (await client.rejected()).length === 0) navigate('#/');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function load(): Promise<void> {
    const [conflicts, rejected] = await Promise.all([client.conflicts(), client.rejected()]);
    for (const row of await client.list(T.people, { includeDeleted: true })) names.set(row.id, String(row.display_name ?? ''));
    replace(conflictHost, ...renderConflicts(conflicts, {
      fieldLabels: FIELD_LABELS, show, onResolve: resolve,
      rowName: (conflict) => rowName(conflict.operation.table, conflict.current ?? conflict.base),
    }));
    rejectedSection.hidden = rejected.length === 0;
    replace(rejectedHost, ...renderRejectedList(rejected, {
      describeError: (error) => describeError(error),
      rowName: (batch, key) => rowName(key.slice(0, key.indexOf('|')), batch.baseRows[key]),
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
