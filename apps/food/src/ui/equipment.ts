import type { RowOperation } from '@ikisai/sync-client';
import { validateOperations, type Equipment } from '@ikisai/domain-food';
import { closeSheet, confirmDialog, el, formatDate, icon, listRow, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { guard } from '../app/guard.ts';
import { EQUIPMENT_STATUSES, EQUIPMENT_STATUS_LABELS, T, describeError, type Mirror } from '../app/client.ts';
import { usage } from '../app/usage.ts';
import { fb } from './feedback.ts';
import type { ViewMount } from './shell.ts';

type Row = Mirror<Equipment>;

const text = (value: string) => value.trim() || null;

/** Maquinaria: lista sencilla en lectura, hoja de edición y papelera. Sin fotos ni optimizador (docs/food/API.md §9). */
export const mountEquipment: ViewMount = ({ main, client }) => {
  let rows: Row[] = [];
  let sheet: Sheet | null = null;

  const list = el('ul', { 'data-feedback-id': 'food.maquinaria.lista', 'data-feedback-label': 'Lista de maquinaria', class: 'list', id: 'equipmentList', 'aria-label': 'Maquinaria' });
  const trashList = el('ul', { class: 'list', 'aria-label': 'Maquinaria en la papelera' });
  const trashLabel = el('summary', { 'data-feedback-id': 'food.maquinaria.papelera.abrir', 'data-feedback-label': 'Abrir papelera', class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera', el('span', { class: 'count' }, '0'));
  const trash = el('details', { 'data-feedback-id': 'food.maquinaria.papelera', 'data-feedback-label': 'Papelera', id: 'trash' }, trashLabel, trashList);
  const empty = el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay maquinaria'), 'Añade hornos, fuegos, ollas grandes o lo que condicione qué se puede cocinar.');
  const host = el('div');

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Maquinaria'), el('p', null, 'Qué hay en la cocina, cuánto y en qué estado.'))),
    host,
    trash,
    el('button', { 'data-feedback-id': 'food.maquinaria.nueva', 'data-feedback-label': 'Nueva máquina', class: 'fab', type: 'button', id: 'newEquipment', onclick: () => openEditor(null) }, icon('plus'), 'Nueva máquina'),
  );

  function item(row: Row, deleted: boolean): HTMLElement {
    const chip = row.status === 'operativo' ? [] : [el('span', { class: row.status === 'limitado' ? 'chip' : 'chip alert' }, EQUIPMENT_STATUS_LABELS[row.status])];
    const node = listRow({
      id: row.id,
      title: row.name,
      meta: [row.quantity === 1 ? '1 unidad' : `${row.quantity} unidades`, row.category ?? '', row.location ?? ''].filter(Boolean),
      chips: chip,
      pending: row._pending === true,
      deleted,
      actions: [deleted
        ? el('button', { 'data-feedback-id': 'food.maquinaria.papelera.restaurar', 'data-feedback-label': 'Restaurar máquina', class: 'linkbtn', type: 'button', 'aria-label': `Restaurar ${row.name}`, onclick: () => void commitSafely([{ op: 'restore', table: T.equipment, id: row.id, expectedRevision: row.revision }], `«${row.name}» restaurada.`) }, icon('restore', 18), 'Restaurar')
        : el('button', { 'data-feedback-id': 'food.maquinaria.lista.editar', 'data-feedback-label': 'Editar máquina', class: 'linkbtn', type: 'button', 'aria-label': `Editar ${row.name}`, onclick: () => openEditor(row) }, 'Editar')],
    });
    return deleted
      ? fb(node, { feedbackId: 'food.maquinaria.papelera.fila', feedbackLabel: 'Máquina en la papelera' })
      : fb(node, { feedbackId: 'food.maquinaria.lista.fila', feedbackLabel: 'Máquina' });
  }

  function paint(): void {
    const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const active = sorted.filter((r) => !r.deleted_at);
    const deleted = sorted.filter((r) => r.deleted_at);
    replace(list, ...active.map((r) => item(r, false)));
    replace(host, active.length ? list : empty);
    replace(trashList, ...deleted.map((r) => item(r, true)));
    trashLabel.querySelector('.count')!.textContent = String(deleted.length);
    trash.hidden = deleted.length === 0;
  }

  async function load(): Promise<void> {
    rows = (await client.list(T.equipment, { includeDeleted: true })) as Row[];
    paint();
  }

  /** `track` envuelve el envío para medir el uso (p. ej. `usage.run` al guardar); el error sigue llegando al `catch`. */
  async function commitSafely(operations: RowOperation[], okMessage: string, track: (send: () => Promise<unknown>) => Promise<unknown> = (send) => send()): Promise<boolean> {
    const issue = validateOperations(operations);
    if (issue) { toast(issue.message); return false; }
    try {
      await track(() => client.commit(operations));
      toast(client.status().network === 'offline' || !navigator.onLine ? `${okMessage} Se sincronizará cuando haya red.` : okMessage);
      await load();
      return true;
    } catch (error) {
      toast(describeError(error));
      return false;
    }
  }

  function openEditor(row: Row | null): void {
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
    const name = el('input', { 'data-feedback-id': 'food.maquinaria.formulario.nombre', 'data-feedback-label': 'Nombre', id: 'e-name', type: 'text', required: true, maxlength: '120', value: row?.name ?? '' });
    const category = el('input', { 'data-feedback-id': 'food.maquinaria.formulario.tipo', 'data-feedback-label': 'Tipo', id: 'e-category', type: 'text', maxlength: '60', value: row?.category ?? '', placeholder: 'Horno, fuego, olla…' });
    const quantity = el('input', { 'data-feedback-id': 'food.maquinaria.formulario.cantidad', 'data-feedback-label': 'Cantidad', id: 'e-quantity', type: 'number', min: '0', step: '1', inputmode: 'numeric', value: String(row?.quantity ?? 1) });
    const capacity = el('input', { 'data-feedback-id': 'food.maquinaria.formulario.capacidad', 'data-feedback-label': 'Capacidad', id: 'e-capacity', type: 'text', value: row?.capacity ?? '', placeholder: '70 cm, 40 litros…' });
    const location = el('input', { 'data-feedback-id': 'food.maquinaria.formulario.ubicacion', 'data-feedback-label': 'Ubicación', id: 'e-location', type: 'text', value: row?.location ?? '' });
    const status = el('select', { 'data-feedback-id': 'food.maquinaria.formulario.estado', 'data-feedback-label': 'Estado', id: 'e-status' }, ...EQUIPMENT_STATUSES.map((s) => el('option', { value: s, selected: (row?.status ?? 'operativo') === s }, EQUIPMENT_STATUS_LABELS[s])));
    const notes = el('textarea', { 'data-feedback-id': 'food.maquinaria.formulario.notas', 'data-feedback-label': 'Notas', id: 'e-notes', rows: '3' });
    notes.value = row?.notes ?? '';

    const fields = (): Record<string, unknown> => ({
      name: name.value.trim(), category: text(category.value), quantity: Number(quantity.value), capacity: text(capacity.value),
      location: text(location.value), status: status.value, notes: text(notes.value),
    });
    const changed = (): Record<string, unknown> => {
      const all = fields();
      if (!row) return all;
      return Object.fromEntries(Object.entries(all).filter(([key, value]) => (row[key] ?? null) !== (value ?? null)));
    };
    const refreshDirty = () => {
      const dirty = Object.keys(changed()).length > 0;
      guard.dirtyEditor = row ? dirty : fields().name !== '';
      sheet?.setFootHidden(row !== null && !dirty);
    };

    const save = el('button', { 'data-feedback-id': 'food.maquinaria.formulario.guardar', 'data-feedback-label': 'Guardar máquina', class: 'primary', type: 'submit', id: 'saveEquipment', form: 'equipmentForm' }, 'Guardar');
    const form = el('form', { 'data-feedback-id': 'food.maquinaria.formulario', 'data-feedback-label': 'Formulario de máquina', novalidate: true, id: 'equipmentForm', oninput: refreshDirty, onchange: refreshDirty,
      onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        if (!name.value.trim()) { error.textContent = 'El nombre es obligatorio.'; name.focus(); return; }
        if (!Number.isInteger(Number(quantity.value)) || Number(quantity.value) < 0) { error.textContent = 'La cantidad debe ser un número entero.'; quantity.focus(); return; }
        const operations: RowOperation[] = row
          ? [{ op: 'update', table: T.equipment, id: row.id, expectedRevision: row.revision, fields: changed() }]
          : [{ op: 'insert', table: T.equipment, id: crypto.randomUUID(), fields: fields() }];
        save.disabled = true;
        const ok = await commitSafely(operations, row ? 'Cambios guardados en este dispositivo.' : 'Máquina creada en este dispositivo.', (send) => usage.run('food.maquinaria.guardar', send));
        save.disabled = false;
        if (ok) { guard.dirtyEditor = false; await sheet?.close(true); }
      } },
      el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
      el('label', { class: 'field' }, el('span', null, 'Tipo'), category),
      el('label', { class: 'field' }, el('span', null, 'Cantidad'), quantity),
      el('label', { class: 'field' }, el('span', null, 'Capacidad'), capacity),
      el('label', { class: 'field' }, el('span', null, 'Ubicación'), location),
      el('label', { class: 'field' }, el('span', null, 'Estado'), status),
      el('label', { class: 'field' }, el('span', null, 'Notas'), notes),
      error,
      row ? el('div', { class: 'zone' },
        el('button', { 'data-feedback-id': 'food.maquinaria.formulario.papelera', 'data-feedback-label': 'Enviar máquina a papelera', class: 'danger', type: 'button', id: 'deleteEquipment', onclick: () => void deleteRow(row) }, icon('trash', 18), 'Enviar a papelera'),
        el('span', { class: 'hint', style: 'color:var(--muted);font-size:12.5px' }, 'Si alguna receta la necesita, márcala fuera de servicio en lugar de borrarla.'),
      ) : null,
    );

    sheet = openSheet({
      title: row ? 'Editar máquina' : 'Nueva máquina',
      meta: row ? `Revisión ${row.revision} · actualizada ${formatDate(row.updated_at)}${row._pending ? ' · pendiente de sincronizar' : ''}` : undefined,
      body: form,
      foot: [el('button', { 'data-feedback-id': 'food.maquinaria.formulario.cerrar', 'data-feedback-label': 'Cerrar o cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, row ? 'Cerrar' : 'Cancelar'), save],
      footHidden: row !== null,
      initialFocus: name,
      beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
      onClose: () => { guard.dirtyEditor = false; sheet = null; },
    });
    refreshDirty();
  }

  async function deleteRow(row: Row): Promise<void> {
    if (!(await confirmDialog({ title: `¿Enviar «${row.name}» a la papelera?`, text: 'Se puede restaurar desde la papelera.', confirmLabel: 'Enviar a papelera', danger: true }))) return;
    guard.dirtyEditor = false;
    if (await commitSafely([{ op: 'delete', table: T.equipment, id: row.id, expectedRevision: row.revision }], `«${row.name}» enviada a la papelera.`)) await sheet?.close(true);
  }

  void load();
  const offTable = client.onTable(T.equipment, () => void load());
  const offStatus = client.onStatus(() => void load());
  return () => {
    offTable();
    offStatus();
    void closeSheet(true);
  };
};
