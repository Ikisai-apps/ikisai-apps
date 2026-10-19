/**
 * «Confirmar consumo» (R5c): cada plato pendiente con lo que gasta a sus raciones, para corregir cantidades o marcar que no
 * se hizo. Al confirmar se descuenta en Recursos (primero lo que caduca antes) y se anota.
 * Una sola hoja para la ficha del menú y para Cocina (tanda 27): los respaldos de 24 h (servidor) y 26 h (app de un
 * editor) no cambian, y el control de no descontar dos veces va dentro.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { consumptionLines, type MenuGraph, type MenuItem, type MenuService, type serviceConsumption } from '@ikisai/domain-food';
import { el, openSheet, toast, type Sheet } from '@ikisai/ui-kit';
import { UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror } from '../app/client.ts';
import { confirmConsumption, type DishDecision, type InventoryData } from '../app/consumption.ts';
import { longDay } from '../app/events.ts';
import { usage } from '../app/usage.ts';
import { SERVICE_LABELS } from './events.ts';

export interface ConsumptionSheetInput {
  client: SyncClient;
  service: Mirror<MenuService>;
  graph: MenuGraph;
  inventory: InventoryData;
  items: Array<Mirror<MenuItem>>;
  recipes: Array<{ id: string; name: string }>;
  /** El estado al momento (se vuelve a mirar antes de confirmar). */
  state: () => ReturnType<typeof serviceConsumption> | null;
  onDone: () => Promise<void> | void;
  onClose?: () => void;
}

export function openConsumptionSheet(input: ConsumptionSheetInput): Sheet | null {
  const { client, service, graph, inventory, items, recipes } = input;
  const state = input.state();
  if (!state || state.state !== 'por_confirmar') return null;
  const label = `${SERVICE_LABELS[service.service_type]} del ${longDay(service.service_date)}`;
  let sheet: Sheet | null = null;
  const forms = state.pending.map((menuItemId) => {
    const dish = items.find((i) => i.id === menuItemId)!;
    const recipe = recipes.find((r) => r.id === dish.recipe_id);
    const lines = consumptionLines(graph, menuItemId, inventory.items, inventory.conversions);
    const done = el('input', { type: 'checkbox', checked: true, 'aria-label': `${recipe?.name ?? 'Plato'}: se hizo` }) as HTMLInputElement;
    const inputs = lines.map((line) => el('input', { type: 'text', inputmode: 'decimal', class: 'qty compact', value: formatQuantity(line.quantity), 'aria-label': `${line.name} gastado en ${recipe?.name ?? 'el plato'}`, disabled: line.reason !== null }) as HTMLInputElement);
    const node = el('div', { 'data-feedback-id': 'food.menu.consumo.plato', 'data-feedback-label': 'Plato del consumo', class: 'consumedish' },
      el('label', { class: 'checkline' }, done, el('strong', null, recipe?.name ?? 'Plato'), el('span', { class: 'muted' }, ` · ${formatQuantity(dish.servings)} raciones`)),
      lines.length ? el('table', { class: 'ingredients' }, el('tbody', null, ...lines.map((line, index) => el('tr', null,
        el('td', null, line.name, line.reason ? el('span', { class: 'consumewhy' }, line.reason === 'sin_articulo' ? 'no se descuenta: sin artículo' : `no se descuenta: no se pasa a ${line.baseUnit}`) : null),
        el('td', { class: 'num' }, inputs[index]!), el('td', null, UNIT_LABELS[line.unit])))))
        : el('p', { class: 'muted' }, 'La receta no tiene ingredientes: no se descuenta nada.'));
    done.addEventListener('change', () => { inputs.forEach((input, index) => { input.disabled = !done.checked || lines[index]!.reason !== null; }); });
    return { menuItemId, recipe, done, inputs, lines, node };
  });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const confirm = el('button', { 'data-feedback-id': 'food.menu.consumo.confirmar', 'data-feedback-label': 'Confirmar consumo', class: 'primary', type: 'button', id: 'confirmConsumption',
    onclick: async () => {
      const decisions: DishDecision[] = [];
      for (const form of forms) {
        const quantities: number[] = [];
        for (const [index, field] of form.inputs.entries()) {
          const value = parseQuantity(field.value);
          if (form.done.checked && form.lines[index]!.reason === null && (value === null || value < 0)) { error.textContent = `Revisa la cantidad de ${form.lines[index]!.name}.`; field.focus(); return; }
          quantities.push(value ?? 0);
        }
        decisions.push({ menuItemId: form.menuItemId, done: form.done.checked, quantities });
      }
      // Pasadas las 24 h lo descuenta el servidor: confirmarlo aquí podría descontarlo dos veces.
      if (input.state()?.state !== 'por_confirmar') { error.textContent = 'Ya han pasado 24 h: se está descontando solo con lo previsto.'; return; }
      confirm.disabled = true;
      try {
        await usage.run('food.menu.consumo.confirmar', () => confirmConsumption(client, graph, inventory, decisions, {
          noteOf: (id) => `${forms.find((f) => f.menuItemId === id)?.recipe?.name ?? 'Plato'} · ${label.toLowerCase()}`,
        }));
        toast('Consumo anotado: el inventario de cocina se ha actualizado.');
        await sheet?.close(true);
        await input.onDone();
      } catch (failure) {
        error.textContent = describeError(failure);
        confirm.disabled = false;
      }
    } }, 'Confirmar');
  sheet = openSheet({
    title: 'Confirmar consumo',
    meta: label,
    body: el('div', { 'data-feedback-id': 'food.menu.consumo', 'data-feedback-label': 'Confirmar consumo', id: 'consumptionSheet' },
      el('p', { class: 'muted' }, 'Lo que piden los platos a sus raciones. Corrige lo que se gastó de verdad o desmarca lo que no se hizo.'),
      ...forms.map((f) => f.node), error),
    foot: [el('button', { 'data-feedback-id': 'food.menu.consumo.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), confirm],
    onClose: () => input.onClose?.(),
  });
  return sheet;
}
