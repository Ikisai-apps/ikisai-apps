import type { RowOperation } from '@ikisai/sync-client';
import { el, formatDate, icon, replace } from './dom.ts';
import { toast } from './toast.ts';
import { guard } from '../app/guard.ts';
import { CATEGORIES, CATEGORY_LABELS, SUPPLIERS, categoryLabel, describeError, type SupplierRow } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

interface FormValues {
  name: string;
  tax_id: string;
  default_category: string;
  notes: string;
}

function valuesOf(row: SupplierRow | null): FormValues {
  return {
    name: row?.name ?? '',
    tax_id: row?.tax_id ?? '',
    default_category: row?.default_category ?? '',
    notes: row?.notes ?? '',
  };
}

function sameValues(a: FormValues, b: FormValues): boolean {
  return a.name === b.name && a.tax_id === b.tax_id && a.default_category === b.default_category && a.notes === b.notes;
}

function toFields(values: FormValues): Record<string, unknown> {
  return {
    name: values.name.trim(),
    tax_id: values.tax_id.trim() || null,
    default_category: values.default_category || null,
    notes: values.notes.trim() || null,
  };
}

/** Vista Proveedores: lista en modo lectura, hoja de edición, papelera y marca de pendiente por fila. */
export const mountSuppliers: ViewMount = ({ main, client }) => {
  let rows: SupplierRow[] = [];
  let query = '';
  let sheet: { back: HTMLElement; close: () => void } | null = null;
  let lastFocus: HTMLElement | null = null;

  const search = el('input', { type: 'search', id: 'supplierSearch', placeholder: 'Buscar por nombre o NIF', 'aria-label': 'Buscar proveedores', autocomplete: 'off',
    oninput: () => { query = search.value.trim().toLowerCase(); paint(); } });
  const list = el('ul', { class: 'list', id: 'supplierList', 'aria-label': 'Proveedores' });
  const activeLabel = el('div', { class: 'sectionlabel' }, 'Activos', el('span', { class: 'count', id: 'supplierCount' }, '0'));
  const trashLabel = el('summary', { class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera', el('span', { class: 'count', id: 'trashCount' }, '0'));
  const trashList = el('ul', { class: 'list', 'aria-label': 'Proveedores en la papelera' });
  const trash = el('details', { id: 'trash' }, trashLabel, trashList);
  const emptyActive = el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay proveedores'), 'Crea el primero con «Nuevo proveedor». Funciona también sin conexión.');
  const emptyFiltered = el('div', { class: 'empty' }, 'Ningún proveedor coincide con la búsqueda.');
  const listHost = el('div');
  const newButton = el('button', { class: 'fab', type: 'button', id: 'newSupplier', onclick: () => openSheet(null) }, icon('plus'), 'Nuevo proveedor');

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
    return row.name.toLowerCase().includes(query) || (row.tax_id ?? '').toLowerCase().includes(query);
  }

  function rowItem(row: SupplierRow, deleted: boolean): HTMLElement {
    const pending = row._pending === true;
    const edit = el('button', { class: 'linkbtn', type: 'button', 'aria-label': `Editar ${row.name}`, onclick: (e: Event) => { lastFocus = e.currentTarget as HTMLElement; openSheet(row); } }, 'Editar');
    const restore = el('button', { class: 'linkbtn', type: 'button', 'aria-label': `Restaurar ${row.name}`, onclick: () => void restoreRow(row) }, icon('restore', 18), 'Restaurar');
    return el('li', { class: `row${deleted ? ' deleted' : ''}`, dataset: { id: row.id, pending: String(pending) } },
      el('div', { class: 'row-title' },
        el('span', { class: 'name' }, row.name),
        pending ? el('span', { class: 'chip pending', title: 'Guardado en este dispositivo; se enviará al servidor cuando haya red' }, 'Pendiente de sincronizar') : null,
        deleted ? el('span', { class: 'chip trash' }, 'En papelera') : null,
      ),
      el('div', { class: 'row-meta' },
        el('span', null, row.tax_id ? `NIF ${row.tax_id}` : 'Sin NIF'),
        el('span', null, '·'),
        el('span', null, categoryLabel(row.default_category)),
      ),
      el('div', { class: 'row-actions' }, deleted ? restore : edit),
    );
  }

  function paint(): void {
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const active = sorted.filter((r) => !r.deleted_at);
    const deleted = sorted.filter((r) => r.deleted_at);
    const visible = active.filter(matches);
    activeLabel.querySelector('.count')!.textContent = String(active.length);
    trashLabel.querySelector('.count')!.textContent = String(deleted.length);
    replace(list, ...visible.map((r) => rowItem(r, false)));
    replace(listHost, active.length === 0 ? emptyActive : visible.length === 0 ? emptyFiltered : list);
    replace(trashList, ...deleted.filter(matches).map((r) => rowItem(r, true)));
    trash.hidden = deleted.length === 0;
  }

  async function load(): Promise<void> {
    rows = (await client.list(SUPPLIERS, { includeDeleted: true })) as SupplierRow[];
    paint();
  }

  async function commitSafely(operations: RowOperation[], okMessage: string): Promise<boolean> {
    try {
      await client.commit(operations);
      const status = client.status();
      toast(status.network === 'online' ? okMessage : `${okMessage} Se sincronizará cuando haya red.`);
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

  // --- Hoja de edición ----------------------------------------------------
  function openSheet(row: SupplierRow | null): void {
    closeSheet(true);
    const initial = valuesOf(row);
    const expectedRevision = row?.revision ?? null;
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });

    const name = el('input', { id: 'f-name', name: 'name', type: 'text', required: true, maxlength: '200', autocomplete: 'organization', value: initial.name });
    const taxId = el('input', { id: 'f-tax', name: 'tax_id', type: 'text', maxlength: '32', autocomplete: 'off', spellcheck: 'false', value: initial.tax_id, style: 'text-transform:uppercase' });
    const category = el('select', { id: 'f-category', name: 'default_category' },
      el('option', { value: '' }, 'Sin categoría'),
      ...CATEGORIES.map((c) => el('option', { value: c, selected: initial.default_category === c }, CATEGORY_LABELS[c])),
    );
    const notes = el('textarea', { id: 'f-notes', name: 'notes', rows: '3' });
    notes.value = initial.notes;

    const save = el('button', { class: 'primary', type: 'submit', id: 'saveSupplier' }, 'Guardar');
    const cancel = el('button', { class: 'ghost', type: 'button', onclick: () => closeSheet() }, row ? 'Cerrar' : 'Cancelar');
    const foot = el('div', { class: 'sheet-foot', hidden: true }, cancel, save);

    const current = (): FormValues => ({ name: name.value, tax_id: taxId.value.toUpperCase(), default_category: category.value, notes: notes.value });
    const refreshDirty = () => {
      const dirty = !sameValues(current(), initial);
      foot.hidden = !dirty && row !== null;
      guard.dirtyEditor = dirty;
    };

    const form = el('form', { novalidate: true, id: 'supplierForm',
      oninput: refreshDirty,
      onchange: refreshDirty,
      onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        const values = current();
        if (!values.name.trim()) {
          error.textContent = 'El nombre es obligatorio.';
          name.focus();
          return;
        }
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
          closeSheet();
        }
      } },
      el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
      el('label', { class: 'field' }, el('span', null, 'NIF'), taxId, el('span', { class: 'hint' }, 'Opcional. Hasta 32 caracteres.')),
      el('label', { class: 'field' }, el('span', null, 'Categoría por defecto'), category),
      el('label', { class: 'field' }, el('span', null, 'Notas'), notes),
      error,
      row ? el('div', { class: 'zone' },
        el('button', { class: 'danger', type: 'button', id: 'deleteSupplier', onclick: () => void deleteRow(row) }, icon('trash', 18), 'Enviar a papelera'),
        el('span', { class: 'hint', style: 'color:var(--muted);font-size:12.5px' }, 'Se puede restaurar desde la papelera.'),
      ) : null,
    );

    const closeButton = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Cerrar', onclick: () => closeSheet() }, icon('close'));
    const titleId = 'sheetTitle';
    const panel = el('section', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      el('div', { class: 'handle', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet-head' },
        el('h2', { id: titleId }, row ? 'Editar proveedor' : 'Nuevo proveedor'),
        closeButton),
      el('div', { class: 'sheet-body' },
        row ? el('p', { class: 'meta' }, `Revisión ${row.revision} · actualizado ${formatDate(row.updated_at)}${row._pending ? ' · pendiente de sincronizar' : ''}`) : null,
        form),
      foot,
    );
    // El pie con «Guardar» va fuera del <form>: lo enlazamos por atributo.
    form.id = 'supplierForm';
    save.setAttribute('form', 'supplierForm');

    const back = el('div', { class: 'sheetback show', onclick: (e: Event) => { if (e.target === back) closeSheet(); } }, panel);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
      if (e.key === 'Tab') trapFocus(e, panel);
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    document.body.style.overflow = 'hidden';

    sheet = {
      back,
      close: () => {
        document.removeEventListener('keydown', onKey);
        back.remove();
        document.body.style.overflow = '';
      },
    };
    refreshDirty();
    if (!row) foot.hidden = false;
    name.focus();
  }

  function closeSheet(force = false): void {
    if (!sheet) return;
    if (!force && guard.dirtyEditor && !confirm('Hay cambios sin guardar. ¿Descartarlos?')) return;
    guard.dirtyEditor = false;
    sheet.close();
    sheet = null;
    lastFocus?.focus();
    lastFocus = null;
  }

  async function deleteRow(row: SupplierRow): Promise<void> {
    if (!confirm(`¿Enviar «${row.name}» a la papelera?`)) return;
    guard.dirtyEditor = false;
    const ok = await commitSafely([{ op: 'delete', table: SUPPLIERS, id: row.id, expectedRevision: row.revision }], `«${row.name}» enviado a la papelera.`);
    if (ok) closeSheet(true);
  }

  void load();
  const offTable = client.onTable(SUPPLIERS, () => void load());
  const offStatus = client.onStatus(() => void load());
  return () => {
    offTable();
    offStatus();
    closeSheet(true);
  };
};

/** Solo los campos que cambian respecto a la fila abierta: menos solapamientos en los conflictos (§6.3). */
function changedFields(fields: Record<string, unknown>, row: SupplierRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if ((row[key] ?? null) !== (value ?? null)) out[key] = value;
  }
  return Object.keys(out).length ? out : fields;
}

function trapFocus(event: KeyboardEvent, container: HTMLElement): void {
  const focusable = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
    .filter((n) => n.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
