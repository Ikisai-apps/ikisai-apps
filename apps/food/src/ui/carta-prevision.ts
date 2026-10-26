/**
 * Food · previsión de la carta (encargo de VG del 26-10-2026; docs/food/API.md §2.11): la pestaña «Previsión» de una carta.
 *
 * - **Reparto** de lo que se prepara: en bandeja en mesa, en bandeja en nevera y en fresco (en %, suma 100; 30/20/50 si
 *   no se ha tocado).
 * - **Unidades esperadas** de cada línea (100 serranos, 60 aguas…).
 * - **Plan de bandejas** (`food.carta_prep_totals_projection`, con red): por ingrediente, el total y lo que va a mesa, a
 *   nevera y en fresco, con su estación; imprimible. Lo que no tiene conversión no se inventa: sale «falta la conversión»,
 *   que se añade en la ficha del artículo (Despensa). Bebidas y extras, aparte, con su total.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  CARTA_SCOPE_LABELS, STATION_LABELS, cartaLinesInOrder, formatAmount, prepSplitOf, prepSplitProblem, validateOperations,
  type CartaLine, type CartaPrepTotal, type Menu, type Recipe, type ResourceItem,
} from '@ikisai/domain-food';
import { el, replace, toast } from '@ikisai/ui-kit';
import { T, describeError, type Mirror } from '../app/client.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { usage } from '../app/usage.ts';

interface PrevisionContext { client: SyncClient; menuId: string; host: HTMLElement; canWrite: boolean; navigate(hash: string): void }

async function commit(client: SyncClient, operations: RowOperation[]): Promise<boolean> {
  const issue = validateOperations(operations);
  if (issue) { toast(issue.message); return false; }
  try { await client.commit(operations); return true; } catch (error) { toast(describeError(error)); return false; }
}

export function mountPrevision({ client, menuId, host, canWrite, navigate }: PrevisionContext): () => void {
  const resources = resourcesClient(client);
  let menu: Mirror<Menu> | null = null;
  let lines: Array<Mirror<CartaLine>> = [];
  let recipes = new Map<string, Recipe>();
  let items = new Map<string, ResourceItem>();
  let totals: CartaPrepTotal[] | null = null;
  let totalsError = false;

  const splitHost = el('section', { 'data-feedback-id': 'food.carta.prevision.reparto', 'data-feedback-label': 'Reparto', class: 'card formblock', id: 'prepSplit' });
  const unitsHost = el('section', { 'data-feedback-id': 'food.carta.prevision.unidades', 'data-feedback-label': 'Unidades esperadas', class: 'card formblock', id: 'expectedUnits' });
  const planHost = el('section', { 'data-feedback-id': 'food.carta.prevision.bandejas', 'data-feedback-label': 'Plan de bandejas', class: 'card', id: 'trayPlan' });
  replace(host, splitHost, unitsHost, planHost);

  const nameOf = (line: CartaLine) => line.name || (line.recipe_id ? recipes.get(line.recipe_id)?.public_name || recipes.get(line.recipe_id)?.name : undefined)
    || (line.item_id ? items.get(line.item_id)?.name : undefined) || 'Sin nombre';

  function paintSplit(): void {
    if (!menu) return;
    const split = prepSplitOf(menu.prep_split);
    const MARKS = { mesa: 'food.carta.prevision.reparto_mesa', nevera: 'food.carta.prevision.reparto_nevera', fresco: 'food.carta.prevision.reparto_fresco' } as const;
    const field = (key: 'mesa' | 'nevera' | 'fresco', label: string) => el('input', {
      'data-feedback-id': MARKS[key], 'data-feedback-label': label, id: `split-${key}`, type: 'number', inputmode: 'numeric',
      min: '0', max: '100', step: '1', value: String(split[key]), disabled: !canWrite, 'aria-label': `${label} (%)` }) as HTMLInputElement;
    const mesa = field('mesa', 'En bandeja, en mesa');
    const nevera = field('nevera', 'En bandeja, en nevera');
    const fresco = field('fresco', 'En fresco');
    const sum = el('span', { class: 'muted', id: 'splitSum' });
    const update = () => {
      const total = Number(mesa.value) + Number(nevera.value) + Number(fresco.value);
      sum.textContent = `Suma: ${total} %`;
      sum.className = total === 100 ? 'muted' : 'warnline';
    };
    [mesa, nevera, fresco].forEach((i) => i.addEventListener('input', update));
    update();
    const save = el('button', { 'data-feedback-id': 'food.carta.prevision.reparto_guardar', 'data-feedback-label': 'Guardar el reparto', class: 'ghost', type: 'button', id: 'splitSave',
      onclick: async () => {
        const next = { mesa: Number(mesa.value), nevera: Number(nevera.value), fresco: Number(fresco.value) };
        const problem = prepSplitProblem(next);
        if (problem) { toast(problem); return; }
        if (await usage.run('food.carta.prevision.reparto', () => commit(client, [{ op: 'update', table: T.menus, id: menu!.id, expectedRevision: menu!.revision, fields: { prep_split: next } }]))) {
          toast('Reparto guardado.');
        }
      } }, 'Guardar el reparto');
    replace(splitHost,
      el('h3', null, 'Reparto de lo que se prepara'),
      el('p', { class: 'muted' }, 'Qué parte de cada ingrediente va cortada en bandeja en la mesa, cortada en bandeja en la nevera y sin cortar (en fresco).'),
      el('div', { class: 'carta-split' },
        el('label', { class: 'field' }, el('span', null, 'Mesa (%)'), mesa),
        el('label', { class: 'field' }, el('span', null, 'Nevera (%)'), nevera),
        el('label', { class: 'field' }, el('span', null, 'Fresco (%)'), fresco)),
      el('p', { class: 'btnrow' }, sum, canWrite ? save : null));
  }

  function paintUnits(): void {
    if (!menu) return;
    const live = cartaLinesInOrder(lines, menu.id).filter((l) => l.active);
    const total = live.reduce((n, l) => n + (l.expected_units ?? 0), 0);
    const row = (line: Mirror<CartaLine>) => {
      const input = el('input', { 'data-feedback-id': 'food.carta.prevision.unidades_linea', 'data-feedback-label': 'Unidades esperadas de la línea', type: 'number', inputmode: 'numeric',
        min: '0', step: '1', value: line.expected_units === null || line.expected_units === undefined ? '' : String(line.expected_units), disabled: !canWrite,
        id: `expected-${line.id}`, 'aria-label': `Unidades esperadas de ${nameOf(line)}`, class: 'carta-units',
        onchange: async () => {
          const value = input.value.trim() === '' ? null : Number(input.value);
          if (value !== null && (!Number.isSafeInteger(value) || value < 0)) { toast('Escribe un número entero de unidades.'); return; }
          if (value === (line.expected_units ?? null)) return;
          await usage.run('food.carta.prevision.unidades', () => commit(client, [{ op: 'update', table: T.cartaLines, id: line.id, expectedRevision: line.revision, fields: { expected_units: value } }]));
        } }) as HTMLInputElement;
      return el('li', { class: 'carta-unitrow' }, el('span', { class: 'carta-code' }, line.code), el('label', { for: input.id, class: 'carta-unitname' }, nameOf(line)), input);
    };
    replace(unitsHost,
      el('h3', null, 'Unidades esperadas'),
      el('p', { class: 'muted' }, `En total, ${total.toLocaleString('es-ES')} unidades. Con ellas sale la lista de la compra y el plan de bandejas.`),
      ...(['clasico', 'gourmet', 'barra'] as const).map((scope) => {
        const own = live.filter((l) => l.scope === scope);
        return own.length ? el('div', null, el('div', { class: 'sectionlabel' }, CARTA_SCOPE_LABELS[scope]), el('ul', { class: 'plainlist carta-units-list' }, ...own.map(row))) : null;
      }));
  }

  function paintPlan(): void {
    if (!menu) return;
    const print = el('button', { 'data-feedback-id': 'food.carta.prevision.imprimir', 'data-feedback-label': 'Imprimir el plan de bandejas', class: 'ghost', type: 'button', id: 'printTrays',
      onclick: () => {
        usage.track('food.carta.prevision.imprimir');
        document.body.classList.add('print-trays');
        const done = () => { document.body.classList.remove('print-trays'); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        window.print();
      } }, 'Imprimir');
    const head = el('div', { class: 'carta-planhead' }, el('h3', null, `Plan de bandejas · ${menu.name ?? 'Carta'}`), print);
    if (totals === null) {
      replace(planHost, head, el('p', { class: 'muted' }, totalsError ? 'El plan necesita conexión: se calcula en el servidor con las recetas y el inventario.' : 'Calculando…'));
      return;
    }
    const ingredients = totals.filter((t) => t.station !== null || t.mesa !== null).sort((a, b) => (a.station ?? 9) - (b.station ?? 9) || a.name.localeCompare(b.name, 'es'));
    const extras = totals.filter((t) => !ingredients.includes(t)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const amount = (t: CartaPrepTotal, v: number | string | null) => (t.convertible ? formatAmount(v, t.unit) : '—');
    const missing = totals.filter((t) => !t.convertible);
    replace(planHost, head,
      el('p', { class: 'muted' }, 'Con las unidades esperadas y el reparto. Cantidades en la unidad del inventario.'),
      ingredients.length ? el('table', { class: 'carta-plan', id: 'trayTable' },
        el('thead', null, el('tr', null, ...['Ingrediente', 'Estación', 'Total', 'Mesa', 'Nevera', 'Fresco'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', null, ...ingredients.map((t) => el('tr', { class: t.convertible ? '' : 'carta-missing' },
          el('th', { scope: 'row' }, t.name),
          el('td', null, t.station ? `${t.station} · ${STATION_LABELS[t.station] ?? ''}` : '—'),
          el('td', null, t.convertible ? formatAmount(t.need_total, t.unit) : 'falta la conversión'),
          el('td', null, amount(t, t.mesa)), el('td', null, amount(t, t.nevera)), el('td', null, amount(t, t.fresco)))))) : el('p', { class: 'muted' }, 'Sin unidades esperadas todavía.'),
      extras.length ? el('div', null, el('div', { class: 'sectionlabel' }, 'Bebidas y extras'),
        el('ul', { class: 'plainlist' }, ...extras.map((t) => el('li', null, el('strong', null, t.name), ': ', t.convertible ? formatAmount(t.need_total, t.unit) : 'falta la conversión')))) : null,
      missing.length ? el('div', { class: 'banner warn notice', role: 'note', id: 'trayMissing' },
        el('div', null, el('strong', null, missing.length === 1 ? '1 ingrediente sin conversión.' : `${missing.length} ingredientes sin conversión.`),
          ' No se inventa: añade en su ficha cuánto pesa (o mide) una unidad o una rodaja. Hasta entonces no suma en el plan ni en la lista de la compra.'),
        el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.carta.prevision.abrir_despensa', 'data-feedback-label': 'Abrir la Despensa', class: 'ghost', type: 'button',
          onclick: () => navigate('#/despensa') }, 'Abrir la Despensa'))) : null);
  }

  async function loadTotals(): Promise<void> {
    try {
      const out = await client.api<{ rows: CartaPrepTotal[] }>(`/read/food.carta_prep_totals_projection?where[menu_id]=${encodeURIComponent(menuId)}&limit=1000`);
      totals = out.rows;
      totalsError = false;
    } catch {
      totals = null;
      totalsError = true;
    }
    paintPlan();
  }

  async function load(): Promise<void> {
    const [row, allLines, allRecipes, allItems] = await Promise.all([
      client.get(T.menus, menuId) as Promise<Mirror<Menu> | null>,
      client.list(T.cartaLines) as Promise<Array<Mirror<CartaLine>>>,
      client.list(T.recipes, { includeDeleted: true }) as Promise<Array<Mirror<Recipe>>>,
      resources.list(R.items).catch(() => []) as unknown as Promise<Array<Mirror<ResourceItem>>>,
    ]);
    menu = row && !row.deleted_at ? row : null;
    lines = allLines;
    recipes = new Map(allRecipes.map((r) => [r.id, r]));
    items = new Map(allItems.map((i) => [i.id, i]));
    paintSplit();
    paintUnits();
    paintPlan();
  }

  void load().then(loadTotals);
  // Tras guardar (o sincronizar) unidades o reparto, el plan se vuelve a pedir al servidor.
  const offs = [T.menus, T.cartaLines, T.recipeIngredients].map((table) => client.onTable(table, () => void load().then(loadTotals)));
  return () => { offs.forEach((off) => off()); document.body.classList.remove('print-trays'); };
}
