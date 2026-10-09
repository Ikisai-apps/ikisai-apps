import type { RowOperation } from '@ikisai/sync-client';
import { supplierName } from '../app/data.ts';
import { closeSheet, confirmDialog, el, formatDate, icon, listRow, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { fbRows } from './feedback.ts';
import { guard } from '../app/guard.ts';
import { CATEGORIES, CATEGORY_LABELS, SUPPLIERS, SUPPLIER_TEMPLATES, categoryLabel, describeError, type LocalSupplierTemplate, type SupplierRow } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

interface FormValues {
  name: string;
  label: string;
  tax_id: string;
  default_category: string;
  default_is_investment: boolean;
  aliases: string;
  notes: string;
}

function valuesOf(row: SupplierRow | null): FormValues {
  return {
    name: row?.name ?? '',
    label: row?.label ?? '',
    tax_id: row?.tax_id ?? '',
    default_category: row?.default_category ?? '',
    default_is_investment: row?.default_is_investment ?? false,
    aliases: (row?.aliases ?? []).join(', '),
    notes: row?.notes ?? '',
  };
}

function sameValues(a: FormValues, b: FormValues): boolean {
  return a.name === b.name && a.label === b.label && a.tax_id === b.tax_id && a.default_category === b.default_category && a.default_is_investment === b.default_is_investment && a.aliases === b.aliases && a.notes === b.notes;
}

function toFields(values: FormValues): Record<string, unknown> {
  return {
    name: values.name.trim(),
    label: values.label.trim() || null,
    tax_id: values.tax_id.trim() || null,
    default_category: values.default_category || null,
    default_is_investment: values.default_is_investment,
    aliases: values.aliases.split(',').map((a) => a.trim()).filter(Boolean).slice(0, 20),
    notes: values.notes.trim() || null,
  };
}

/** Vista Proveedores: lista en modo lectura, hoja de edición del kit, papelera y marca de pendiente por fila. */
export const mountSuppliers: ViewMount = ({ main, client }) => {
  let rows: SupplierRow[] = [];
  let templates: LocalSupplierTemplate[] = [];
  let query = '';
  let sheet: Sheet | null = null;

  const search = el('input', { 'data-feedback-id': 'invoices.proveedores.buscar', 'data-feedback-label': 'Buscar proveedores', type: 'search', id: 'supplierSearch', placeholder: 'Buscar por nombre o NIF', 'aria-label': 'Buscar proveedores', autocomplete: 'off',
    oninput: () => { query = search.value.trim().toLowerCase(); paint(); } });
  const list = el('ul', { class: 'list', id: 'supplierList', 'aria-label': 'Proveedores' });
  const activeLabel = el('div', { class: 'sectionlabel' }, 'Activos', el('span', { class: 'count', id: 'supplierCount' }, '0'));
  const trashLabel = el('summary', { class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera', el('span', { class: 'count', id: 'trashCount' }, '0'));
  const trashList = el('ul', { class: 'list', 'aria-label': 'Proveedores en la papelera' });
  const trash = el('details', { 'data-feedback-id': 'invoices.proveedores.papelera', 'data-feedback-label': 'Papelera', id: 'trash' }, trashLabel, trashList);
  const emptyActive = el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay proveedores'), 'Crea el primero con «Nuevo proveedor». Funciona también sin conexión.');
  const emptyFiltered = el('div', { class: 'empty plain' }, 'Ningún proveedor coincide con la búsqueda.');
  const listHost = el('div');
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  const newButton = el('button', { 'data-feedback-id': 'invoices.proveedores.nuevo', 'data-feedback-label': 'Nuevo proveedor', class: 'fab', type: 'button', id: 'newSupplier', hidden: !canEdit, onclick: () => openEditor(null) }, icon('plus'), 'Nuevo proveedor');

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Proveedores'), el('p', null, 'Quién te factura: nombre, NIF, categoría habitual y notas.'))),
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)),
    activeLabel,
    listHost,
    trash,
    newButton,
  );

  function matches(row: SupplierRow): boolean {
    if (!query) return true;
    return row.name.toLowerCase().includes(query) || (row.label ?? '').toLowerCase().includes(query) || (row.tax_id ?? '').toLowerCase().includes(query);
  }

  function rowItem(row: SupplierRow, deleted: boolean): HTMLElement {
    const edit = canEdit ? el('button', { 'data-feedback-id': 'invoices.proveedores.lista.fila.editar', 'data-feedback-label': 'Editar', class: 'linkbtn', type: 'button', 'aria-label': `Editar ${row.name}`, onclick: () => openEditor(row) }, 'Editar') : null;
    const restore = el('button', { 'data-feedback-id': 'invoices.proveedores.papelera.restaurar', 'data-feedback-label': 'Restaurar', class: 'linkbtn', type: 'button', 'aria-label': `Restaurar ${row.name}`, onclick: () => void restoreRow(row) }, icon('restore', 18), 'Restaurar');
    return listRow({
      id: row.id,
      title: supplierName(row),
      meta: [row.label ? row.name : null, row.tax_id ? `NIF ${row.tax_id}` : 'Sin NIF', categoryLabel(row.default_category)].filter(Boolean) as string[],
      pending: row._pending === true,
      deleted,
      actions: [deleted ? restore : edit],
    });
  }

  function paint(): void {
    const sorted = [...rows].sort((a, b) => supplierName(a).localeCompare(supplierName(b), 'es'));
    const active = sorted.filter((r) => !r.deleted_at);
    const deleted = sorted.filter((r) => r.deleted_at);
    const visible = active.filter(matches);
    activeLabel.querySelector('.count')!.textContent = String(active.length);
    trashLabel.querySelector('.count')!.textContent = String(deleted.length);
    replace(list, ...visible.map((r) => rowItem(r, false)));
    fbRows(list, { feedbackId: 'invoices.proveedores.lista', feedbackLabel: 'Proveedores' }, { feedbackId: 'invoices.proveedores.lista.fila', feedbackLabel: 'Proveedor' });
    replace(listHost, active.length === 0 ? emptyActive : visible.length === 0 ? emptyFiltered : list);
    replace(trashList, ...deleted.filter(matches).map((r) => rowItem(r, true)));
    fbRows(trashList, { feedbackId: 'invoices.proveedores.papelera.lista', feedbackLabel: 'Proveedores en la papelera' }, { feedbackId: 'invoices.proveedores.papelera.fila', feedbackLabel: 'Proveedor' });
    trash.hidden = deleted.length === 0;
  }

  async function load(): Promise<void> {
    rows = (await client.list(SUPPLIERS, { includeDeleted: true })) as SupplierRow[];
    templates = ((await client.list(SUPPLIER_TEMPLATES)) as LocalSupplierTemplate[]).filter((t) => !t.deleted_at);
    paint();
  }

  async function commitSafely(operations: RowOperation[], okMessage: string): Promise<boolean> {
    try {
      await client.commit(operations);
      const status = client.status();
      toast(status.network === 'offline' ? `${okMessage} Se sincronizará cuando haya red.` : okMessage);
      await load();
      return true;
    } catch (error) {
      toast(describeError(error));
      return false;
    }
  }

  async function restoreRow(row: SupplierRow): Promise<void> {
    await commitSafely([{ op: 'restore', table: SUPPLIERS, id: row.id, expectedRevision: row.revision }], `«${row.name}» restaurado.`);
  }

  // --- Hoja de edición (kit) ----------------------------------------------------
  function openEditor(row: SupplierRow | null): void {
    const initial = valuesOf(row);
    const expectedRevision = row?.revision ?? null;
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });

    const name = el('input', { 'data-feedback-ignore': '', id: 'f-name', name: 'name', type: 'text', required: true, maxlength: '200', autocomplete: 'organization', value: initial.name });
    const label = el('input', { 'data-feedback-ignore': '', id: 'f-label', name: 'label', type: 'text', maxlength: '120', autocomplete: 'off', value: initial.label, placeholder: 'Cómo lo llamas tú (p. ej. «Makro»)' });
    const taxId = el('input', { 'data-feedback-ignore': '', id: 'f-tax', name: 'tax_id', type: 'text', maxlength: '32', autocomplete: 'off', spellcheck: 'false', value: initial.tax_id, style: 'text-transform:uppercase' });
    const category = el('select', { 'data-feedback-id': 'invoices.proveedores.ficha.categoria', 'data-feedback-label': 'Categoría por defecto', id: 'f-category', name: 'default_category' },
      el('option', { value: '' }, 'Sin categoría'),
      ...CATEGORIES.map((c) => el('option', { value: c, selected: initial.default_category === c }, CATEGORY_LABELS[c])),
    );
    const notes = el('textarea', { 'data-feedback-ignore': '', id: 'f-notes', name: 'notes', rows: '3' });
    notes.value = initial.notes;
    const aliases = el('input', { 'data-feedback-ignore': '', id: 'f-aliases', name: 'aliases', type: 'text', autocomplete: 'off', value: initial.aliases, placeholder: 'MAKRO ESPAÑA S.A., Makro Alcorcón' });
    const investment = el('input', { 'data-feedback-id': 'invoices.proveedores.ficha.inversion', 'data-feedback-label': 'Suelen ser inversión', id: 'f-investment', name: 'default_is_investment', type: 'checkbox', checked: initial.default_is_investment });

    const current = (): FormValues => ({ name: name.value, label: label.value, tax_id: taxId.value.toUpperCase(), default_category: category.value, default_is_investment: investment.checked, aliases: aliases.value, notes: notes.value });
    const isDirty = () => !sameValues(current(), initial);
    const refreshDirty = () => {
      const dirty = isDirty();
      sheet?.setFootHidden(!dirty && row !== null);
      guard.dirtyEditor = dirty;
    };

    const save = el('button', { 'data-feedback-id': 'invoices.proveedores.ficha.guardar', 'data-feedback-label': 'Guardar', class: 'primary', type: 'submit', id: 'saveSupplier', form: 'supplierForm' }, 'Guardar');
    const cancel = el('button', { 'data-feedback-id': 'invoices.proveedores.ficha.cerrar', 'data-feedback-label': 'Cerrar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, row ? 'Cerrar' : 'Cancelar');

    const form = el('form', { 'data-feedback-id': 'invoices.proveedores.ficha', 'data-feedback-label': 'Ficha de proveedor', novalidate: true, id: 'supplierForm',
      oninput: refreshDirty,
      onchange: refreshDirty,
      onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        const values = current();
        if (!values.name.trim()) { error.textContent = 'El nombre es obligatorio.'; name.focus(); return; }
        if (values.name.trim().length > 200) { error.textContent = 'El nombre no puede superar 200 caracteres.'; name.focus(); return; }
        if (values.tax_id.trim().length > 32) { error.textContent = 'El NIF no puede superar 32 caracteres.'; taxId.focus(); return; }
        save.disabled = true;
        const fields = toFields(values);
        const operations: RowOperation[] = row && expectedRevision !== null
          ? [{ op: 'update', table: SUPPLIERS, id: row.id, expectedRevision, fields: changedFields(fields, row) }]
          : [{ op: 'insert', table: SUPPLIERS, id: crypto.randomUUID(), fields }];
        const ok = await commitSafely(operations, row ? 'Cambios guardados en este dispositivo.' : 'Proveedor creado en este dispositivo.');
        save.disabled = false;
        if (ok) {
          guard.dirtyEditor = false;
          await sheet?.close(true);
        }
      } },
      el('label', { class: 'field' }, el('span', null, 'Mi nombre'), label, el('span', { class: 'hint' }, 'El nombre por el que lo conoces. Es el que verás en la app.')),
      el('label', { class: 'field' }, el('span', null, 'Razón social (la de la factura)'), name, el('span', { class: 'hint' }, 'La que va a la gestoría.')),
      el('label', { class: 'field' }, el('span', null, 'NIF'), taxId, el('span', { class: 'hint' }, 'Opcional. Hasta 32 caracteres.')),
      el('label', { class: 'field' }, el('span', null, 'Categoría por defecto'), category),
      el('label', { class: 'check' }, investment, el('span', null, 'Sus facturas suelen ser inversión')),
      el('label', { class: 'field' }, el('span', null, 'Alias'), aliases, el('span', { class: 'hint' }, 'Otros nombres con los que aparece en las facturas, separados por comas. Sirven para emparejar la importación.')),
      el('label', { class: 'field' }, el('span', null, 'Notas'), notes),
      error,
      row ? templatesBlock(row) : null,
      row ? el('div', { class: 'zone' },
        el('button', { 'data-feedback-id': 'invoices.proveedores.ficha.papelera', 'data-feedback-label': 'Enviar a papelera', class: 'danger', type: 'button', id: 'deleteSupplier', onclick: () => void deleteRow(row) }, icon('trash', 18), 'Enviar a papelera'),
        el('span', { class: 'hint', style: 'color:var(--muted);font-size:12.5px' }, 'Se puede restaurar desde la papelera.'),
      ) : null,
    );

    sheet = openSheet({
      title: row ? 'Editar proveedor' : 'Nuevo proveedor',
      meta: row ? `Revisión ${row.revision} · actualizado ${formatDate(row.updated_at)}${row._pending ? ' · pendiente de sincronizar' : ''}` : undefined,
      body: form,
      foot: [cancel, save],
      footHidden: row !== null,
      initialFocus: name,
      beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
      onClose: () => { guard.dirtyEditor = false; sheet = null; },
    });
    refreshDirty();
  }

  /** Plantillas aprendidas de sus facturas confirmadas (API.md §6.9): versión, estado, evidencia y qué lee. */
  function templatesBlock(row: SupplierRow): HTMLElement | null {
    const mine = templates.filter((t) => t.supplier_id === row.id).sort((a, b) => b.version - a.version);
    if (!mine.length) return el('p', { 'data-feedback-id': 'invoices.proveedores.ficha.plantillas', 'data-feedback-label': 'Plantillas de lectura', class: 'hint', id: 'supplierTemplates' }, 'Sin plantilla todavía: lee la primera factura con IA (o rellénala a mano) y valídala; Finance aprende dónde están los datos y las siguientes se leen solas.');
    const isOwner = client.bootstrap()?.membership.role === 'owner';
    const STATUS: Record<string, string> = { aprendiendo: 'Aprendiendo', activa: 'Activa', retirada: 'Retirada' };
    const FIELD: Record<string, string> = { invoice_number: 'número', invoice_date: 'fecha', supplier_tax_id: 'NIF', base: 'base', total: 'total', withholding: 'retención', __items: 'artículos (tabla)' };
    return el('div', { 'data-feedback-id': 'invoices.proveedores.ficha.plantillas', 'data-feedback-label': 'Plantillas de lectura', class: 'field', id: 'supplierTemplates' }, el('span', null, 'Plantillas de lectura'),
      el('ul', { class: 'list plain' }, ...mine.map((t) => {
        const reads = Object.entries(t.fields).filter(([, r]) => !r.retired).map(([k]) => (k.startsWith('vat:') ? `IVA ${k.slice(4)} %` : FIELD[k] ?? k));
        return el('li', { class: 'tpl-row', dataset: { version: String(t.version) } },
          el('strong', null, `v${t.version} · ${STATUS[t.status] ?? t.status}`),
          el('span', { class: 'hint' }, ` · aprendida el ${new Date(t.created_at).toLocaleDateString('es-ES')}`),
          el('span', { class: 'hint' }, ` ${t.confirmations} factura${t.confirmations === 1 ? '' : 's'} confirmada${t.confirmations === 1 ? '' : 's'} · ${t.full_hits} sin correcciones · lee ${reads.join(', ') || 'nada todavía'}`),
          isOwner && t.status !== 'retirada' ? el('button', { 'data-feedback-id': 'invoices.proveedores.ficha.plantillas.retirar', 'data-feedback-label': 'Retirar plantilla', class: 'linkbtn', type: 'button', 'aria-label': `Retirar plantilla v${t.version}`, onclick: async () => {
            const ok = await confirmDialog({ title: `¿Retirar la plantilla v${t.version}?`, text: 'Deja de usarse al leer sus PDF. Se conserva y las siguientes confirmaciones pueden crear otra.', confirmLabel: 'Retirar', danger: true });
            if (ok) await commitSafely([{ op: 'update', table: SUPPLIER_TEMPLATES, id: t.id, expectedRevision: t.revision, fields: { status: 'retirada' } }], 'Plantilla retirada.');
          } }, 'Retirar') : null);
      })),
      el('span', { class: 'hint' }, 'Se aprenden solo de facturas validadas; no hace falta tocarlas.'));
  }

  async function deleteRow(row: SupplierRow): Promise<void> {
    const ok = await confirmDialog({ title: `¿Enviar «${row.name}» a la papelera?`, text: 'Se puede restaurar desde la papelera.', confirmLabel: 'Enviar a papelera', danger: true });
    if (!ok) return;
    guard.dirtyEditor = false;
    const done = await commitSafely([{ op: 'delete', table: SUPPLIERS, id: row.id, expectedRevision: row.revision }], `«${row.name}» enviado a la papelera.`);
    if (done) await sheet?.close(true);
  }

  void load();
  const offTable = client.onTable(SUPPLIERS, () => void load());
  const offStatus = client.onStatus(() => void load());
  return () => {
    offTable();
    offStatus();
    void closeSheet(true);
  };
};

/** Solo los campos que cambian respecto a la fila abierta: menos solapamientos en los conflictos (§6.3). */
function changedFields(fields: Record<string, unknown>, row: SupplierRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const before = row[key] ?? null;
    const same = Array.isArray(value) ? JSON.stringify(before ?? []) === JSON.stringify(value) : before === (value ?? null);
    if (!same) out[key] = value;
  }
  return Object.keys(out).length ? out : fields;
}
