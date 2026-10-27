import type { RowOperation } from '@ikisai/sync-client';
import {
  EQUIPMENT_STAGES, equipmentJourney, machineStockMovement, validateOperations,
  type Equipment, type EquipmentNotice, type EquipmentStage, type EquipmentStatus, type MenuItem, type MenuService, type MovementLike, type RecipeEquipment, type ResourceItem,
} from '@ikisai/domain-food';
import type { SyncedRow } from '@ikisai/sync-client';
import { closeSheet, confirmDialog, createSpacePicker, el, formatDate, icon, listRow, openSheet, renderStages, replace, spaceFromRow, spaceShortPath, toast, type Sheet, type SpaceRow } from '@ikisai/ui-kit';
import { todayKey } from '../app/events.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { guard } from '../app/guard.ts';
import { EQUIPMENT_STATUSES, EQUIPMENT_STATUS_LABELS, T, describeError, type Mirror } from '../app/client.ts';
import { usage } from '../app/usage.ts';
import { fb } from './feedback.ts';
import type { ViewMount } from './shell.ts';
import { onlineBinder } from './online.ts';

type Row = Mirror<Equipment>;
/** Marca del selector de espacio; el kit pone las etiquetas de sus partes (`SPACE_PICKER_MARKS`). */
const SPACE_MARK = 'food.maquinaria.formulario.espacio';

const text = (value: string) => value.trim() || null;

/** Tanda 27 (MUELA-029 con 068 §4): el recorrido de la máquina que falla, con la palabra exacta de su estado. */
const STAGE_LABELS: Record<EquipmentStage, string> = { falla: 'Falla', avisado: 'Avisado', en_reparacion: 'En reparación', funciona: 'Funciona' };
/** «la máquina» está…: limitada, averiada o fuera de servicio. */
const STATUS_WORD: Record<EquipmentStatus, string> = { operativo: 'funciona', limitado: 'limitada', averiado: 'averiada', fuera_de_servicio: 'fuera de servicio' };
const NEXT_TEXT: Record<EquipmentStage, string> = {
  falla: 'Siguiente: avisar a Tasks para repararla',
  avisado: 'Siguiente: que Tasks la repare',
  en_reparacion: 'Siguiente: que vuelva a funcionar',
  funciona: '',
};

/** Maquinaria: lista sencilla en lectura, hoja de edición y papelera. Sin fotos ni optimizador (docs/food/API.md §9). */
export const mountEquipment: ViewMount = ({ main, client }) => {
  let rows: Row[] = [];
  // Recursos (R5): el artículo de cada máquina, los espacios y los movimientos (el stock).
  let articles: Array<ResourceItem & { default_space_id?: string | null; revision: number }> = [];
  let spaces: SpaceRow[] = [];
  let movements: MovementLike[] = [];
  const articleOf = (row: Row) => (row.item_id ? articles.find((a) => a.id === row.item_id) : undefined);
  /**
   * Bloque 2 (Maquinaria A, MUELA-077 §3): una sola línea de sitio. La ruta corta del espacio («Albergue › Almacén»,
   * `spaceShortPath` del kit 0.53), si no el texto escrito, si no «Sin sitio»; nunca las dos cosas.
   */
  const shortPlace = (spaceId: string | null | undefined): string => (spaceId ? spaceShortPath(spaces, spaceId) : '');
  const placeOf = (row: Row) => shortPlace(articleOf(row)?.default_space_id) || row.location || 'Sin sitio';
  /** Stock total del artículo en Recursos (lo que la ficha llama «Cantidad»). */
  const stockOf = (itemId: string) => Math.round(movements.filter((m) => !m.deleted_at && m.item_id === itemId).reduce((sum, m) => sum + Number(m.quantity), 0) * 1000) / 1000;
  const canWrite = () => client.bootstrap()?.membership.role !== 'reader';
  let sheet: Sheet | null = null;
  const net = onlineBinder(client);
  // Avisos a Tasks (1104) y lo que piden los menús que vienen: el «!» va en la etapa si la máquina hace falta.
  let notices: Array<Mirror<EquipmentNotice>> = [];
  let needed = new Set<string>();
  const journeyOf = (row: Row) => equipmentJourney(row as Row & { status_since?: string | null }, notices);

  /** El recorrido: pequeño en la fila, completo en la hoja; siempre con la palabra del estado y, en la hoja, lo siguiente. */
  function journey(row: Row, mini: boolean): HTMLElement {
    const { stage, status } = journeyOf(row);
    return renderStages({
      label: `Recorrido de ${row.name}`,
      stages: EQUIPMENT_STAGES.map((key) => ({ key, label: STAGE_LABELS[key] })),
      current: stage,
      bad: needed.has(row.id) && stage !== 'funciona' ? [stage] : [],
      mini,
      caption: mini ? `${STAGE_LABELS[stage]} · ${STATUS_WORD[status]}${needed.has(row.id) ? ' · hace falta en un menú' : ''}`
        : `${STAGE_LABELS[stage]} · ${STATUS_WORD[status]}. ${NEXT_TEXT[stage]}${needed.has(row.id) ? '. Hace falta en un menú que viene.' : '.'}`,
    });
  }

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
    // Quien solo lee no da de alta máquinas (tanda 27: antes veía el botón).
    canWrite() ? el('button', { 'data-feedback-id': 'food.maquinaria.nueva', 'data-feedback-label': 'Nueva máquina', class: 'fab', type: 'button', id: 'newEquipment', onclick: () => openEditor(null) }, icon('plus'), 'Nueva máquina') : null,
  );

  function item(row: Row, deleted: boolean): HTMLElement {
    const chip = row.status === 'operativo' ? [] : [el('span', { class: row.status === 'limitado' ? 'chip' : 'chip alert' }, EQUIPMENT_STATUS_LABELS[row.status])];
    const node = listRow({
      id: row.id,
      title: row.name,
      meta: [row.quantity === 1 ? '1 unidad' : `${row.quantity} unidades`, row.category ?? '', placeOf(row)].filter(Boolean),
      chips: chip,
      pending: row._pending === true,
      deleted,
      // Toda la fila abre la ficha (hallazgo F-MAQ-4); «Editar» sigue para quien lo busca.
      ...(deleted ? {} : { label: `Abrir ${row.name}`, onClick: () => openEditor(row) }),
      actions: [deleted
        ? el('button', { 'data-feedback-id': 'food.maquinaria.papelera.restaurar', 'data-feedback-label': 'Restaurar máquina', class: 'linkbtn', type: 'button', 'aria-label': `Restaurar ${row.name}`, onclick: () => void commitSafely([{ op: 'restore', table: T.equipment, id: row.id, expectedRevision: row.revision }], `«${row.name}» restaurada.`) }, icon('restore', 18), 'Restaurar')
        : el('button', { 'data-feedback-id': 'food.maquinaria.lista.editar', 'data-feedback-label': 'Editar máquina', class: 'linkbtn', type: 'button', 'aria-label': `Editar ${row.name}`, onclick: () => openEditor(row) }, 'Editar')],
    });
    // La máquina que falla lleva su recorrido pequeño, a todo el ancho; el chip del estado sigue en el título.
    if (!deleted && row.status !== 'operativo') node.append(el('div', { 'data-feedback-id': 'food.maquinaria.lista.recorrido', 'data-feedback-label': 'Recorrido', class: 'fd-journey' }, journey(row, true)));
    return deleted
      ? fb(node, { feedbackId: 'food.maquinaria.papelera.fila', feedbackLabel: 'Máquina en la papelera' })
      : fb(node, { feedbackId: 'food.maquinaria.lista.fila', feedbackLabel: 'Máquina' });
  }

  function paint(): void {
    // Lo que necesita atención, arriba (hallazgo F-MAQ-1, decisión de Core del 27-10): averiado o fuera de servicio, luego
    // limitado y luego operativo; dentro de cada grupo, por orden alfabético.
    const urgency = (r: Row) => (r.status === 'averiado' || r.status === 'fuera_de_servicio' ? 0 : r.status === 'limitado' ? 1 : 2);
    const sorted = [...rows].sort((a, b) => urgency(a) - urgency(b) || a.name.localeCompare(b.name, 'es'));
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
    const today = todayKey();
    const [noticeRows, services, items, uses] = await Promise.all([
      client.list(T.equipmentNotices) as unknown as Promise<Array<Mirror<EquipmentNotice>>>,
      client.list(T.menuServices) as Promise<Array<Mirror<MenuService>>>,
      client.list(T.menuItems) as Promise<Array<Mirror<MenuItem>>>,
      client.list(T.recipeEquipment) as Promise<Array<Mirror<RecipeEquipment>>>,
    ]);
    notices = noticeRows;
    const coming = new Set(services.filter((sv) => !sv.deleted_at && sv.service_date >= today).map((sv) => sv.id));
    const recipesComing = new Set(items.filter((i) => !i.deleted_at && coming.has(i.service_id)).map((i) => i.recipe_id));
    needed = new Set(uses.filter((u) => !u.deleted_at && recipesComing.has(u.recipe_id)).map((u) => u.equipment_id));
    try {
      const r = resourcesClient(client);
      const [items, spaceRows, moves] = await Promise.all([r.list(R.items), r.list(R.spaces), r.list(R.movements)]);
      articles = items as unknown as typeof articles;
      spaces = (spaceRows as SyncedRow[]).filter((s) => !s.deleted_at).map(spaceFromRow);
      movements = moves as unknown as MovementLike[];
    } catch {
      // sin Recursos, Maquinaria funciona como siempre
    }
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
    // Espacio de Recursos (R5): dónde está la máquina. Solo si ya tiene artículo y hay espacios.
    const article = row ? articleOf(row) : undefined;
    let spaceChanged = false;
    // Un solo «Dónde está»: con artículo, el selector de espacio (una sola etiqueta) y el texto de antes en solo lectura
    // hasta que se elija un espacio; sin artículo, el texto libre de siempre. No se borra ningún texto.
    const spacePicker = article && spaces.length && canWrite()
      ? createSpacePicker({ label: 'Dónde está', rows: spaces, value: article.default_space_id ?? null, recentKey: 'food.maquinaria', feedbackId: SPACE_MARK,
          onChange: () => { spaceChanged = true; refreshDirty(); paintStock(); } })
      : null;
    // El stock, antes de guardar: lo mismo que escribirá `machineStockMovement`, dicho antes.
    const stockLine = el('p', { 'data-feedback-id': 'food.maquinaria.formulario.stock', 'data-feedback-label': 'Stock en Recursos', class: 'hint fd-machinestock', id: 'machineStock', 'aria-live': 'polite' });
    function paintStock(): void {
      if (!article || !spacePicker) { stockLine.hidden = true; return; }
      const stock = stockOf(article.id);
      const wanted = Number(quantity.value);
      const spaceId = spacePicker.get()[0] ?? null;
      const where = shortPlace(spaceId);
      const delta = Math.round((wanted - stock) * 1000) / 1000;
      const changedQty = row ? wanted !== row.quantity : false;
      stockLine.hidden = false;
      stockLine.classList.toggle('warnline', delta !== 0);
      if (!Number.isInteger(wanted) || wanted < 0) { stockLine.textContent = ''; stockLine.hidden = true; return; }
      if (delta === 0) { stockLine.textContent = `En Recursos hay ${stock}: cuadra con la ficha.`; return; }
      if (!spaceId) { stockLine.textContent = `No cuadra: la ficha dice ${wanted} · en Recursos hay ${stock}. Elige dónde está para ajustarlo al guardar.`; return; }
      const move = delta > 0 ? `entra ${delta} en ${where}` : `sale ${-delta} de ${where}`;
      stockLine.textContent = changedQty || spaceChanged
        ? `Al guardar, en Recursos pasa de ${stock} a ${wanted} (${move}).`
        : `No cuadra: la ficha dice ${wanted} · en Recursos hay ${stock}. Al guardar, pasa a ${wanted} (${move}).`;
    }

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
      const dirty = Object.keys(changed()).length > 0 || spaceChanged;
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
        const edits = row ? changed() : fields();
        const operations: RowOperation[] = !row
          ? [{ op: 'insert', table: T.equipment, id: crypto.randomUUID(), fields: edits }]
          : Object.keys(edits).length ? [{ op: 'update', table: T.equipment, id: row.id, expectedRevision: row.revision, fields: edits }] : [];
        save.disabled = true;
        const ok = !operations.length || await commitSafely(operations, row ? 'Cambios guardados en este dispositivo.' : 'Máquina creada en este dispositivo.', (send) => usage.run('food.maquinaria.guardar', send));
        if (ok && article) await syncResources(article, spacePicker?.get()[0] ?? article.default_space_id ?? null, Number(quantity.value));
        save.disabled = false;
        if (ok) { guard.dirtyEditor = false; await sheet?.close(true); }
      } },
      row && row.status !== 'operativo' && !row.deleted_at ? el('div', { 'data-feedback-id': 'food.maquinaria.formulario.recorrido', 'data-feedback-label': 'Recorrido', class: 'fd-journey-full' },
        el('div', { id: 'equipmentJourney' }, journey(row, false)),
        // En «Falla», avisar a Tasks a la vista (el mismo aviso que el de abajo; uno por máquina y día).
        journeyOf(row).stage === 'falla' && canWrite()
          ? el('button', { 'data-feedback-id': 'food.maquinaria.formulario.recorrido.avisar', 'data-feedback-label': 'Avisar a Tasks', class: 'ghost fd-journey-act', type: 'button', id: 'reportFaultTop',
              onclick: (event: Event) => void reportFault(row, event.currentTarget as HTMLButtonElement, notes.value) }, 'Avisar a Tasks')
          : null) : null,
      el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
      el('label', { class: 'field' }, el('span', null, 'Tipo'), category),
      el('label', { class: 'field' }, el('span', null, 'Cantidad'), quantity),
      el('label', { class: 'field' }, el('span', null, 'Capacidad'), capacity),
      spacePicker
        ? el('div', { 'data-feedback-id': 'food.maquinaria.formulario.donde', 'data-feedback-label': 'Dónde está', class: 'field fd-where' }, spacePicker.element,
            !article?.default_space_id && row?.location ? el('p', { class: 'hint', id: 'oldLocation' }, `Antes: “${row.location}” (se guarda tal cual; elige el espacio).`) : null,
            el('span', { class: 'hint' }, 'Con espacio, «Cantidad» es su stock en Recursos: cambiarla lo ajusta.'), stockLine)
        : el('label', { class: 'field' }, el('span', null, 'Ubicación'), location),
      el('label', { class: 'field' }, el('span', null, 'Estado'), status),
      el('label', { class: 'field' }, el('span', null, 'Notas'), notes),
      error,
      row ? el('div', { class: 'zone' },
        el('button', { 'data-feedback-id': 'food.maquinaria.formulario.papelera', 'data-feedback-label': 'Enviar máquina a papelera', class: 'danger', type: 'button', id: 'deleteEquipment', onclick: () => void deleteRow(row) }, icon('trash', 18), 'Enviar a papelera'),
        el('span', { class: 'hint', style: 'color:var(--muted);font-size:12.5px' }, 'Si alguna receta la necesita, márcala fuera de servicio en lugar de borrarla.'),
      ) : null,
      row && row.status !== 'operativo' && !row.deleted_at && canWrite() ? el('div', { 'data-feedback-id': 'food.maquinaria.formulario.aviso_tasks', 'data-feedback-label': 'Avisar a Tasks', class: 'zone', id: 'faultZone' },
        el('button', { 'data-feedback-id': 'food.maquinaria.formulario.avisar_averia', 'data-feedback-label': 'Avisar a Tasks', class: 'ghost', type: 'button', id: 'reportFault', onclick: (event: Event) => void reportFault(row, event.currentTarget as HTMLButtonElement, notes.value) }, 'Avisar a Tasks para repararla'),
        el('span', { class: 'hint', style: 'color:var(--muted);font-size:12.5px' }, 'Crea una petición en Tasks con el nombre, el estado y las notas. Necesita conexión.'),
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
      onClose: () => { guard.dirtyEditor = false; sheet = null; net.release(); },
    });
    refreshDirty();
    paintStock();
    quantity.addEventListener('input', paintStock);
    // Avisar a Tasks necesita red (MUELA-086): sin ella, desactivado con el motivo.
    form.querySelectorAll<HTMLElement>('#reportFault, #reportFaultTop').forEach((b) => net.bind(b, 'Avisar a Tasks necesita conexión.'));
  }

  /**
   * Recursos (R5): el sitio de la máquina es el habitual de su artículo, y su cantidad es el stock: si no cuadra, un
   * movimiento a mano en ese sitio lo deja igual. Sin sitio no se toca el stock.
   */
  async function syncResources(article: (typeof articles)[number], spaceId: string | null, quantity: number): Promise<void> {
    const r = resourcesClient(client);
    try {
      const ops: RowOperation[] = [];
      if ((article.default_space_id ?? null) !== spaceId) ops.push({ op: 'update', table: R.items, id: article.id, expectedRevision: article.revision, fields: { default_space_id: spaceId } } as RowOperation);
      const movement = spaceId && Number.isInteger(quantity) ? machineStockMovement({ itemId: article.id, spaceId, quantity, movements }) : null;
      if (movement) ops.push({ op: 'insert', table: R.movements, id: crypto.randomUUID(), fields: movement } as RowOperation);
      if (ops.length) await r.commit(ops);
    } catch (error) {
      toast(`No se ha actualizado en Recursos: ${describeError(error)}`);
    }
    await load();
  }

  /** Petición a Tasks (API.md §6.1): una por máquina y día; Tasks la enruta con las reglas del usuario o la deja en «Por clasificar». */
  async function reportFault(row: Row, button: HTMLButtonElement, note: string): Promise<void> {
    if (!navigator.onLine) { toast('Sin conexión: avisa a Tasks cuando vuelva la red.'); return; }
    button.disabled = true;
    try {
      const out = await usage.run('food.maquinaria.avisar_averia', () => client.api<{ created: boolean; routed: string | null }>(`/equipment/${row.id}/fault`, {
        method: 'POST',
        // El sitio que se manda es el espacio de Recursos (su ruta corta); sin espacio, el texto escrito.
        json: { name: row.name, status: row.status, location: shortPlace(articleOf(row)?.default_space_id) || row.location || '', note: note.trim() },
      }));
      toast(!out.created ? 'Ya se había avisado hoy a Tasks de esta máquina.'
        : out.routed === 'pending' ? 'Aviso enviado a Tasks: queda en «Por clasificar».' : 'Aviso enviado a Tasks.');
      // El aviso queda anotado en el servidor: con él, el recorrido pasa a «Avisado».
      await client.sync().catch(() => undefined);
      await load();
      const host = document.getElementById('equipmentJourney');
      if (host) replace(host, journey(rows.find((r) => r.id === row.id) ?? row, false));
    } catch (error) {
      toast(describeError(error));
    } finally {
      button.disabled = false;
    }
  }

  async function deleteRow(row: Row): Promise<void> {
    if (!(await confirmDialog({ title: `¿Enviar «${row.name}» a la papelera?`, text: 'Se puede restaurar desde la papelera.', confirmLabel: 'Enviar a papelera', danger: true }))) return;
    guard.dirtyEditor = false;
    if (await commitSafely([{ op: 'delete', table: T.equipment, id: row.id, expectedRevision: row.revision }], `«${row.name}» enviada a la papelera.`)) await sheet?.close(true);
  }

  void load();
  const offTable = client.onTable(T.equipment, () => void load());
  const offNotices = client.onTable(T.equipmentNotices, () => void load());
  const offStatus = client.onStatus(() => void load());
  const offResources = (() => { try { const r = resourcesClient(client); const offs = [R.items, R.spaces, R.movements].map((t) => r.onTable(t, () => void load())); return () => offs.forEach((off) => off()); } catch { return () => undefined; } })();
  return () => {
    offTable();
    offNotices();
    offStatus();
    void closeSheet(true);
    offResources();
  };
};
