import type { PendingConflict, SyncedRow } from '@ikisai/sync-client';
import { confirmDialog, el, formatDate, renderConflicts, renderRejectedList, replace, toast } from '@ikisai/ui-kit';
import { T, describeError, formatQuantity } from '../app/client.ts';
import { shortDay } from '../app/events.ts';
import { SERVICE_LABELS } from './events.ts';
import { usage } from '../app/usage.ts';
import { fb, fbIgnore, type FbMark } from './feedback.ts';
import type { ViewMount } from './shell.ts';

/** Botones de decisión que pinta el kit, por su `data-choice` (catálogo fijo, ids literales). */
const CHOICE_MARKS: Record<string, FbMark> = {
  mine: { feedbackId: 'food.conflictos.conflicto.mantener_mia', feedbackLabel: 'Mantener la mía' },
  theirs: { feedbackId: 'food.conflictos.conflicto.tomar_servidor', feedbackLabel: 'Tomar la del servidor' },
  merge: { feedbackId: 'food.conflictos.conflicto.combinar', feedbackLabel: 'Combinar campo a campo' },
  retry: { feedbackId: 'food.conflictos.rechazados.reintentar', feedbackLabel: 'Reintentar' },
  discard: { feedbackId: 'food.conflictos.rechazados.descartar', feedbackLabel: 'Descartar' },
};

/** Marca la tarjeta del kit, sus botones de decisión y deja fuera del reporte la tabla de valores (puede llevar notas o responsables). */
function markCard(card: HTMLElement, mark: FbMark): HTMLElement {
  if (!card.matches('article')) return card; // estado vacío
  fb(card, mark);
  for (const button of card.querySelectorAll<HTMLElement>('[data-choice]')) {
    const choice = CHOICE_MARKS[button.dataset.choice ?? ''];
    if (choice) fb(button, choice);
  }
  for (const node of card.querySelectorAll('table, ul, .meta')) fbIgnore(node);
  return card;
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Nombre', public_name: 'Nombre público', public_description: 'Descripción pública', category: 'Categoría', base_servings: 'Raciones base',
  method: 'Elaboración', conservation: 'Conservación', freezable: 'Congelable', regeneration: 'Regeneración', service_notes: 'Notas de servicio',
  prep_minutes: 'Antelación (min)', status: 'Estado', diet_tags: 'Dietas', allergens: 'Alérgenos', allergens_checked: 'Alérgenos revisados',
  photo_file_id: 'Foto', photo_thumb_file_id: 'Miniatura', preferred_unit: 'Unidad preferida', preferred_supplier: 'Proveedor habitual', active: 'Activo',
  quantity: 'Cantidad', unit: 'Unidad', notes: 'Notas', capacity: 'Capacidad', location: 'Ubicación', quantity_required: 'Unidades necesarias',
  servings: 'Raciones', position: 'Orden', service_date: 'Día', service_type: 'Servicio', service_time: 'Hora', closing_notes: 'Cierre de cocina',
  required_quantity: 'Necesario', stock_quantity: 'En casa', purchase_quantity: 'Comprar', supplier: 'Proveedor', manual_override: 'Compra fijada a mano',
  text: 'Paso', scheduled_date: 'Día', scheduled_time: 'Hora', responsible: 'Responsable', done: 'Hecho', manual: 'A mano',
  deleted_at: 'Borrado',
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'deleted_at') return formatDate(String(value));
  if (field === 'photo_file_id' || field === 'photo_thumb_file_id') return 'Foto';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return formatQuantity(value);
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

/** Conflictos (§6.3) y lotes rechazados por el servidor, con los componentes del kit. */
export const mountConflicts: ViewMount = ({ main, client, navigate }) => {
  const conflictHost = el('div', { 'data-feedback-id': 'food.conflictos.lista', 'data-feedback-label': 'Conflictos pendientes', id: 'conflictList' });
  const rejectedHost = el('div', { 'data-feedback-id': 'food.conflictos.rechazados', 'data-feedback-label': 'Rechazados por el servidor', id: 'rejectedList' });
  // Nombres para titular cada tarjeta con algo que la cocina reconozca, no con el identificador de la fila.
  const names = new Map<string, string>();
  const nameOf = (id: unknown) => names.get(String(id)) ?? '';
  function rowName(table: string, row: SyncedRow | null | undefined): string {
    if (!row) return 'Elemento';
    switch (table) {
      case T.recipes: return `Receta: ${row.name}`;
      case T.ingredients: return `Ingrediente: ${row.name}`;
      case T.equipment: return `Máquina: ${row.name}`;
      case T.recipeIngredients: return `Ingrediente de receta: ${nameOf(row.ingredient_id)} en ${nameOf(row.recipe_id)}`;
      case T.recipeEquipment: return `Maquinaria de receta: ${nameOf(row.equipment_id)} en ${nameOf(row.recipe_id)}`;
      case T.menus: return 'Menú';
      case T.menuServices: return `Servicio: ${SERVICE_LABELS[row.service_type as keyof typeof SERVICE_LABELS] ?? ''} del ${shortDay(String(row.service_date))}`;
      case T.menuItems: return `Plato del menú: ${nameOf(row.recipe_id)}`;
      case T.menuComments: return 'Comentario del organizador';
      case T.shoppingLists: return 'Lista de compra';
      case T.shoppingItems: return `Compra: ${nameOf(row.ingredient_id)}`;
      case T.preparation: return `Paso de preparación: ${row.text}`;
      default: return String(row.name ?? 'Elemento');
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
      await usage.run('food.conflictos.resolver', () => client.resolveConflict(conflict.requestId, decision));
      toast('Conflicto resuelto. Se enviará tu decisión al servidor.');
      await load();
      if ((await client.conflicts()).length === 0 && (await client.rejected()).length === 0) navigate('#/recetario');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function load(): Promise<void> {
    const [conflicts, rejected] = await Promise.all([client.conflicts(), client.rejected()]);
    for (const table of [T.recipes, T.ingredients, T.equipment]) {
      for (const row of await client.list(table, { includeDeleted: true })) names.set(row.id, String(row.name ?? ''));
    }
    replace(conflictHost, ...renderConflicts(conflicts, {
      fieldLabels: FIELD_LABELS, show, onResolve: resolve,
      rowName: (conflict) => rowName(conflict.operation.table, conflict.current ?? conflict.base),
    }).map((card) => markCard(card, { feedbackId: 'food.conflictos.conflicto', feedbackLabel: 'Conflicto' })));
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
    }).map((card) => markCard(card, { feedbackId: 'food.conflictos.rechazados.lote', feedbackLabel: 'Lote rechazado' })));
  }

  void load();
  const off = client.onStatus(() => void load());
  return () => off();
};
