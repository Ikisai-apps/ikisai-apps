import type { PendingConflict } from '@ikisai/sync-client';
import { confirmDialog, conflictIntro, el, formatDate, renderConflicts, renderRejectedList, replace, toast } from '@ikisai/ui-kit';
import { loadMirror, supplierName } from '../app/data.ts';
import { categoryLabel, describeError } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

const FIELD_LABELS: Record<string, string> = {
  name: 'Nombre', tax_id: 'NIF', default_category: 'Categoría', notes: 'Notas', deleted_at: 'Borrado',
  expense_category: 'Categoría de gasto', invoice_date: 'Fecha', invoice_number: 'Número', object: 'Objeto', source_total: 'Total del documento',
  status: 'Estado', payment_status: 'Pago', declared_period: 'Se declara en', due_date: 'Vencimiento', label: 'Mi nombre', description: 'Descripción',
};
/** Kit 0.28.0: «Un registro de {tabla}» cuando no hay nombre legible; nunca el id. */
const TABLE_LABELS: Record<string, string> = { 'invoices.invoices': 'facturas', 'invoices.suppliers': 'proveedores', 'invoices.invoice_lines': 'artículos', 'invoices.tax_lines': 'impuestos', 'invoices.issued_invoices': 'emitidas' };

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'default_category' || field === 'expense_category') return categoryLabel(value);
  if (field === 'deleted_at') return formatDate(String(value));
  return String(value);
}

/** Conflictos (§6.3) y lotes rechazados por el servidor, con los componentes del kit. */
export const mountConflicts: ViewMount = ({ main, client, navigate }) => {
  const conflictHost = el('div', { 'data-feedback-id': 'invoices.conflictos.lista', 'data-feedback-label': 'Conflictos', 'data-feedback-ignore': '', id: 'conflictList' });
  const rejectedHost = el('div', { 'data-feedback-id': 'invoices.conflictos.rechazados', 'data-feedback-label': 'Rechazados por el servidor', 'data-feedback-ignore': '', id: 'rejectedList' });
  const rejectedSection = el('section', { hidden: true }, el('div', { class: 'sectionlabel' }, 'Rechazados por el servidor'), rejectedHost);
  const intro = el('p', { id: 'conflictIntro' }, 'Nada se pierde hasta que decidas.');
  const userId = client.bootstrap()?.profile.userId ?? null;
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Conflictos'), intro)),
    conflictHost,
    rejectedSection,
  );

  async function resolve(conflict: PendingConflict, decision: Parameters<typeof client.resolveConflict>[1]): Promise<void> {
    try {
      await client.resolveConflict(conflict.requestId, decision);
      toast('Conflicto resuelto. Se enviará tu decisión al servidor.');
      await load();
      if ((await client.conflicts()).length === 0 && (await client.rejected()).length === 0) navigate('#/proveedores');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function load(): Promise<void> {
    const [conflicts, rejected, mirror] = await Promise.all([client.conflicts(), client.rejected(), loadMirror(client)]);
    // Kit 0.28.0: nombre legible («FVR_2026_003 · Intermodalidad de Levante»), quién lo cambió y la frase de cabecera.
    const rowName = (c: PendingConflict): string | null => {
      const row = c.current as Record<string, unknown>;
      // Un `call` aparcado (p. ej. validar) no lleva tabla: la fila es una factura si tiene código y proveedor.
      const table = (c.operation as { table?: string }).table ?? ('supplier_id' in row && 'code' in row ? 'invoices.invoices' : null);
      if (table === 'invoices.invoices') {
        const supplier = mirror.supplierById.get(String(row.supplier_id ?? ''));
        return [row.code ?? 'Factura sin código', supplier?.slug === 'sin_identificar' ? null : supplierName(supplier, '')].filter(Boolean).join(' · ');
      }
      if (table === 'invoices.suppliers') return row.name ? String(row.name) : null;
      return null;
    };
    replace(intro, conflicts.length ? conflictIntro(conflicts, userId) : 'Nada se pierde hasta que decidas.');
    replace(conflictHost, ...renderConflicts(conflicts, { fieldLabels: FIELD_LABELS, show, onResolve: resolve, currentUserId: userId ?? undefined, rowName, tableLabels: TABLE_LABELS }));
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
