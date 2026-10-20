import type { PendingConflict, RejectedBatch } from '@ikisai/sync-client';
import { confirmDialog, conflictIntro, el, formatDate, renderConflicts, renderRejectedList, replace, toast } from '@ikisai/ui-kit';
import { loadMirror, supplierName, type Mirror } from '../app/data.ts';
import { categoryLabel, describeError } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

const FIELD_LABELS: Record<string, string> = {
  name: 'Nombre', tax_id: 'NIF', default_category: 'Categoría', notes: 'Notas', deleted_at: 'Borrado',
  expense_category: 'Categoría de gasto', invoice_date: 'Fecha', invoice_number: 'Número', object: 'Objeto', source_total: 'Total del documento',
  status: 'Estado', payment_status: 'Pago', declared_period: 'Se declara en', due_date: 'Vencimiento', label: 'Mi nombre', description: 'Descripción',
  // Tanda 27: los que faltaban (R4 y pago)
  item_id: 'Artículo', payment_source: 'Pago confirmado', paid_at: 'Fecha de pago', payment_method: 'Forma de pago', deductibility: 'Deducibilidad',
};
/** Kit 0.28.0: «Un registro de {tabla}» cuando no hay nombre legible; nunca el id. */
const TABLE_LABELS: Record<string, string> = { 'invoices.invoices': 'facturas', 'invoices.suppliers': 'proveedores', 'invoices.invoice_lines': 'artículos', 'invoices.tax_lines': 'impuestos', 'invoices.issued_invoices': 'emitidas' };

/** Áreas de la bandeja (tanda 27, MUELA-046 y 070): la de Central y Food, con lo de Finance. */
const AREAS: Record<string, { key: string; label: string; order: number }> = {
  'invoices.invoices': { key: 'facturas', label: 'Facturas', order: 1 }, 'invoices.invoice_lines': { key: 'facturas', label: 'Facturas', order: 1 },
  'invoices.tax_lines': { key: 'facturas', label: 'Facturas', order: 1 }, 'invoices.invoice_files': { key: 'facturas', label: 'Facturas', order: 1 },
  'invoices.suppliers': { key: 'proveedores', label: 'Proveedores', order: 2 },
  'invoices.issued_invoices': { key: 'emitidas', label: 'Emitidas', order: 3 }, 'invoices.issued_invoice_lines': { key: 'emitidas', label: 'Emitidas', order: 3 },
  'invoices.issued_allocations': { key: 'emitidas', label: 'Emitidas', order: 3 }, 'invoices.allocations': { key: 'compras', label: 'Compras', order: 4 },
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'default_category' || field === 'expense_category') return categoryLabel(value);
  if (field === 'deleted_at') return formatDate(String(value));
  return String(value);
}

/** Un «Validar» aparcado: lo que choca es la validación. */
const isValidation = (c: PendingConflict) => c.procedure === 'invoices.validate';

/**
 * Conflictos (§6.3) y lotes rechazados por el servidor, con los componentes del kit. Tanda 27: la bandeja por áreas
 * (`renderConflicts` con `layout: 'tray'`) con «Lo mío» y «Lo del otro» al mismo nivel y «Deshacer» unos segundos (la
 * decisión no sale hasta entonces; si se cierra la app, el conflicto sigue ahí). «Ver diferencias» abre la tarjeta de
 * siempre, con «Combinar campo a campo». El «Validar» aparcado va aparte, con «Validar igualmente» (reenvía la validación
 * con las mismas comprobaciones) y «Revisarla primero» (no valida y abre la ficha). Los rechazados, con su motivo,
 * «Corregir en Facturas», «Descartar» (con confirmación) y «Reintentar», más discreto. Al acabar, vuelve atrás.
 */
export const mountConflicts: ViewMount = ({ main, client, navigate }) => {
  const conflictHost = el('div', { 'data-feedback-id': 'invoices.conflictos.lista', 'data-feedback-label': 'Conflictos', id: 'conflictList' });
  const rejectedHost = el('div', { 'data-feedback-id': 'invoices.conflictos.rechazados', 'data-feedback-label': 'Rechazados por el servidor', 'data-feedback-ignore': '', id: 'rejectedList' });
  const rejectedSection = el('section', { hidden: true }, el('div', { class: 'sectionlabel' }, 'Rechazados por el servidor'), rejectedHost);
  const intro = el('p', { id: 'conflictIntro' }, 'Nada se pierde hasta que decidas.');
  const userId = client.bootstrap()?.profile.userId ?? null;
  const back = () => { if (history.length > 1) history.back(); else navigate('#/'); };
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Conflictos'), intro)),
    conflictHost,
    rejectedSection,
  );

  async function resolve(conflict: PendingConflict, decision: Parameters<typeof client.resolveConflict>[1], openAfter: string | null = null): Promise<void> {
    try {
      await client.resolveConflict(conflict.requestId, decision);
      toast('Conflicto resuelto. Se enviará tu decisión al servidor.');
      if (openAfter) { navigate(`#/facturas/${openAfter}`); return; }
      await load();
      // Al acabar, a donde se estaba (antes saltaba a Proveedores)
      if ((await client.conflicts()).length === 0 && (await client.rejected()).length === 0) back();
    } catch (error) {
      toast(describeError(error));
    }
  }

  /** La factura de un rechazado (por su fila, su línea o su asignación), para «Corregir en Facturas». */
  function invoiceOf(batch: RejectedBatch, m: Mirror): string | null {
    for (const op of batch.operations as Array<{ table?: string; id?: string; procedure?: string; args?: Record<string, unknown>; fields?: Record<string, unknown> }>) {
      if (op.procedure && typeof op.args?.invoice_id === 'string') return op.args.invoice_id;
      if (op.table === 'invoices.invoices' && op.id) return op.id;
      const lineId = op.table === 'invoices.invoice_lines' ? op.id : op.table === 'invoices.allocations' ? String(op.fields?.invoice_line_id ?? m.allocations.find((a) => a.id === op.id)?.invoice_line_id ?? '') : null;
      const line = lineId ? m.lines.find((l) => l.id === lineId) : null;
      if (line) return line.invoice_id;
      if (op.table === 'invoices.invoice_lines' && typeof op.fields?.invoice_id === 'string') return op.fields.invoice_id;
    }
    return null;
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
      if (table === 'invoices.invoice_lines') {
        const invoice = mirror.invoices.find((i) => i.id === row.invoice_id);
        return `Artículo «${String(row.description ?? '')}»${invoice?.code ? ` de ${invoice.code}` : ''}`;
      }
      return null;
    };
    const medal = (c: PendingConflict) => {
      const row = c.current as Record<string, unknown>;
      const supplier = mirror.supplierById.get(String(row.supplier_id ?? ''));
      const name = supplier ? supplierName(supplier, '') : String(row.name ?? row.recipient_name ?? '');
      return name ? { name } : null;
    };
    const groupBy = (c: PendingConflict) => AREAS[(c.operation as { table?: string }).table ?? 'invoices.invoices'] ?? { key: 'otros', label: 'Otros cambios', order: 9 };
    const common = { fieldLabels: FIELD_LABELS, show, currentUserId: userId ?? undefined, rowName, tableLabels: TABLE_LABELS, layout: 'tray' as const, groupBy, medal, undoMs: 6000 };
    const plain = conflicts.filter((c) => !isValidation(c));
    const validations = conflicts.filter(isValidation);
    replace(intro, conflicts.length ? conflictIntro(conflicts, userId) : 'Nada se pierde hasta que decidas.');
    replace(conflictHost,
      ...(plain.length ? renderConflicts(plain, { ...common, feedbackId: 'invoices.conflictos.linea', onResolve: (c, d) => resolve(c, d) }) : []),
      // Lo que choca es la validación: «Validar igualmente» la reenvía (con las mismas comprobaciones; si falta algo, no
      // valida y lo dice el rechazo) y «Revisarla primero» no valida y abre la ficha.
      ...(validations.length ? [el('p', { class: 'hint', id: 'validationClash' }, 'Lo que choca es la validación: querías validar y la factura cambió mientras.'),
        ...renderConflicts(validations, { ...common, feedbackId: 'invoices.conflictos.validar', groupBy: () => ({ key: 'validar', label: 'Validaciones', order: 0 }),
          labels: { mine: 'Validar igualmente', theirs: 'Revisarla primero' }, both: false,
          onResolve: (c, d) => resolve(c, d, d.choice === 'theirs' ? String((c.current as { id?: string }).id ?? '') || null : null) })] : []),
      ...(conflicts.length ? [] : [el('div', { class: 'empty', id: 'conflictsEmpty' }, el('strong', null, 'Sin conflictos'), 'Todo lo tuyo se ha podido aplicar sin pisar cambios de nadie.',
        el('p', null, el('button', { 'data-feedback-id': 'invoices.conflictos.volver', 'data-feedback-label': 'Volver', class: 'ghost', type: 'button', id: 'conflictsBack', onclick: back }, 'Volver')))]),
    );
    rejectedSection.hidden = rejected.length === 0;
    const cards = renderRejectedList(rejected, {
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
        if ((await client.conflicts()).length === 0 && (await client.rejected()).length === 0) back();
      },
    });
    // «Corregir en Facturas» delante; «Reintentar» queda como acción discreta (por si el motivo era pasajero)
    for (const card of cards) {
      const batch = rejected.find((b) => b.requestId === card.dataset.requestId);
      const retry = card.querySelector<HTMLButtonElement>('[data-choice="retry"]');
      if (retry) retry.className = 'linkbtn';
      const invoice = batch ? invoiceOf(batch, mirror) : null;
      const choices = card.querySelector('.choices');
      if (invoice && choices) choices.prepend(el('button', { 'data-feedback-id': 'invoices.conflictos.rechazados.corregir', 'data-feedback-label': 'Corregir en Facturas', class: 'primary', type: 'button', 'data-choice': 'fix', onclick: () => navigate(`#/facturas/${invoice}`) }, 'Corregir en Facturas'));
    }
    replace(rejectedHost, ...cards);
  }

  void load();
  const off = client.onStatus(() => void load());
  return () => off();
};
