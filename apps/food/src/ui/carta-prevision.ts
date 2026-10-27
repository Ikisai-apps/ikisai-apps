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
  CARTA_SCOPE_LABELS, STATION_LABELS, cartaAttendance, distributeUnits, cartaLinesInOrder, formatAmount, perPersonFromUnits, prepSplitOf, prepSplitProblem, unitsFromPerPerson, validateOperations,
  prepMissingLabel, purchaseFromPrep, UNITS, type CartaLine, type CartaPrepTotal, type Ingredient, type Menu, type Recipe, type RecipeIngredient, type ResourceItem, type Unit,
} from '@ikisai/domain-food';
import { el, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { T, describeError, type Mirror } from '../app/client.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { usage } from '../app/usage.ts';
import { watchEvents } from '../app/events.ts';

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
  let eventGuests: number | null = null; // personas del evento de la carta (Booking), si lo tiene

  const splitHost = el('section', { 'data-feedback-id': 'food.carta.prevision.reparto', 'data-feedback-label': 'Reparto', class: 'card formblock', id: 'prepSplit' });
  const unitsHost = el('section', { 'data-feedback-id': 'food.carta.prevision.unidades', 'data-feedback-label': 'Unidades esperadas', class: 'card formblock', id: 'expectedUnits' });
  const planHost = el('section', { 'data-feedback-id': 'food.carta.prevision.bandejas', 'data-feedback-label': 'Plan de bandejas', class: 'card', id: 'trayPlan' });
  const yieldHost = el('section', { 'data-feedback-id': 'food.carta.prevision.rendimiento', 'data-feedback-label': 'Rendimiento de los ingredientes', class: 'card formblock', id: 'yieldHost' });
  replace(host, splitHost, unitsHost, yieldHost, planHost);
  let ingredients: Array<Mirror<Ingredient>> = [];
  let parts: Array<Mirror<RecipeIngredient>> = [];

  const nameOf = (line: CartaLine) => line.name || (line.recipe_id ? recipes.get(line.recipe_id)?.public_name || recipes.get(line.recipe_id)?.name : undefined)
    || (line.item_id ? items.get(line.item_id)?.name : undefined) || 'Sin nombre';

  function paintSplit(): void {
    if (!menu) return;
    const split = prepSplitOf(menu.prep_split);
    const MARKS = { mesa: 'food.carta.prevision.reparto_mesa', nevera: 'food.carta.prevision.reparto_nevera', fresco: 'food.carta.prevision.reparto_fresco' } as const;
    const field = (key: 'mesa' | 'nevera' | 'fresco', label: string) => el('input', {
      // Los tres porcentajes son un solo dato: el reparto de la carta.
      'data-field-id': 'food.carta.prevision.reparto', 'data-field-entity': 'food.menus', 'data-field-prop': 'prep_split',
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

  /** Asistentes de la carta: los suyos o, si no, las personas del evento (puente entre «por persona» y «total»). */
  const attendance = () => cartaAttendance(menu, eventGuests);

  function paintUnits(): void {
    if (!menu) return;
    const current = menu;
    const live = cartaLinesInOrder(lines, current.id).filter((l) => l.active);
    const total = live.reduce((n, l) => n + (l.expected_units ?? 0), 0);
    const people = attendance();
    // Asistentes: al cambiarlos, las líneas con «por persona» recalculan su total (en el mismo lote).
    const guests = el('input', { 'data-field-id': 'food.carta.prevision.asistentes', 'data-field-entity': 'food.menus', 'data-field-prop': 'expected_attendance', 'data-feedback-id': 'food.carta.prevision.asistentes', 'data-feedback-label': 'Asistentes esperados', id: 'cartaAttendance', type: 'number',
      inputmode: 'numeric', min: '0', step: '1', disabled: !canWrite, class: 'carta-units', 'aria-label': 'Asistentes esperados',
      value: current.expected_attendance === null || current.expected_attendance === undefined ? '' : String(current.expected_attendance),
      placeholder: eventGuests ? String(eventGuests) : '',
      onchange: async () => {
        const value = guests.value.trim() === '' ? null : Number(guests.value);
        if (value !== null && (!Number.isSafeInteger(value) || value < 0)) { toast('Escribe un número entero de personas.'); return; }
        if (value === (current.expected_attendance ?? null)) return;
        const next = value ?? eventGuests ?? null;
        const ops: RowOperation[] = [{ op: 'update', table: T.menus, id: current.id, expectedRevision: current.revision, fields: { expected_attendance: value } }];
        if (next !== null) {
          for (const line of live) {
            if (line.per_person === null || line.per_person === undefined) continue;
            const units = unitsFromPerPerson(Number(line.per_person), next);
            if (units !== line.expected_units) ops.push({ op: 'update', table: T.cartaLines, id: line.id, expectedRevision: line.revision, fields: { expected_units: units } });
          }
        }
        await usage.run('food.carta.prevision.asistentes', () => commit(client, ops));
      } }) as HTMLInputElement;
    const row = (line: Mirror<CartaLine>) => {
      const save = (fields: Record<string, unknown>) => usage.run('food.carta.prevision.unidades', () => commit(client, [{ op: 'update', table: T.cartaLines, id: line.id, expectedRevision: line.revision, fields }]));
      const perPerson = el('input', { 'data-field-id': 'food.carta.prevision.por_persona', 'data-field-entity': 'food.carta_lines', 'data-field-prop': 'per_person', 'data-feedback-id': 'food.carta.prevision.por_persona', 'data-feedback-label': 'Consumo por persona', type: 'number', inputmode: 'decimal',
        min: '0', step: '0.01', disabled: !canWrite, id: `perperson-${line.id}`, 'aria-label': `Por persona de ${nameOf(line)}`, class: 'carta-units',
        value: line.per_person === null || line.per_person === undefined ? '' : String(Number(line.per_person)),
        onchange: async () => {
          const value = perPerson.value.trim() === '' ? null : Number(perPerson.value.replace(',', '.'));
          if (value !== null && (!Number.isFinite(value) || value < 0)) { toast('Escribe cuántas por persona, como 0,5.'); return; }
          const people = attendance();
          // Con asistentes, el total sale de ahí (hacia arriba: máximos a cubrir); sin ellos, solo se guarda el «por persona».
          await save(value !== null && people !== null ? { per_person: value, expected_units: unitsFromPerPerson(value, people) } : { per_person: value });
        } }) as HTMLInputElement;
      const units = el('input', { 'data-field-id': 'food.carta.prevision.unidades_linea', 'data-field-entity': 'food.carta_lines', 'data-field-prop': 'expected_units', 'data-feedback-id': 'food.carta.prevision.unidades_linea', 'data-feedback-label': 'Unidades a cubrir de la línea', type: 'number', inputmode: 'numeric',
        min: '0', step: '1', value: line.expected_units === null || line.expected_units === undefined ? '' : String(line.expected_units), disabled: !canWrite,
        id: `expected-${line.id}`, 'aria-label': `Unidades esperadas de ${nameOf(line)}`, class: 'carta-units',
        onchange: async () => {
          const value = units.value.trim() === '' ? null : Number(units.value);
          if (value !== null && (!Number.isSafeInteger(value) || value < 0)) { toast('Escribe un número entero de unidades.'); return; }
          if (value === (line.expected_units ?? null)) return;
          const people = attendance();
          await save(value !== null && people ? { expected_units: value, per_person: perPersonFromUnits(value, people) } : { expected_units: value });
        } }) as HTMLInputElement;
      return el('li', { class: 'carta-unitrow' }, el('span', { class: 'carta-code' }, line.code), el('span', { class: 'carta-unitname' }, nameOf(line)),
        el('label', { class: 'field' }, el('span', null, 'Por persona'), perPerson), el('label', { class: 'field' }, el('span', null, 'Total'), units));
    };
    replace(unitsHost,
      el('h3', null, 'Unidades a cubrir'),
      total === 0 ? el('div', { class: 'banner warn notice', role: 'note', id: 'previsionEmpty' },
        el('div', null, el('strong', null, 'Sin previsión: Flow no podrá preparar existencias.'), ' Pon las unidades de cada línea o usa «Rellenar previsión».')) : null,
      canWrite ? el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.carta.prevision.rellenar', 'data-feedback-label': 'Rellenar previsión', class: 'ghost', type: 'button',
        id: 'fillPrevision', onclick: () => openFill(live, people) }, 'Rellenar previsión')) : null,
      el('label', { class: 'field' }, el('span', null, 'Asistentes esperados'), guests,
        el('span', { class: 'hint', id: 'attendanceHint' }, current.expected_attendance === null || current.expected_attendance === undefined
          ? (eventGuests ? `Sin tocar, las del evento: ${eventGuests}.` : 'Sin asistentes no se puede pasar de «por persona» a «total».')
          : 'Al cambiarlos, cada línea con «por persona» recalcula su total.')),
      el('p', { class: 'muted' }, `En total, ${total.toLocaleString('es-ES')} unidades${people ? ` para ${people.toLocaleString('es-ES')} personas` : ''}. Son máximos a cubrir, no medias: con ellos salen la lista de la compra y el plan de bandejas.`),
      ...(['clasico', 'gourmet', 'barra'] as const).map((scope) => {
        const own = live.filter((l) => l.scope === scope);
        return own.length ? el('div', null, el('div', { class: 'sectionlabel' }, CARTA_SCOPE_LABELS[scope]), el('ul', { class: 'plainlist carta-units-list' }, ...own.map(row))) : null;
      }));
  }

  /**
   * Rendimiento (1112): de los ingredientes de esta carta que las recetas cuentan en piezas («2 unidad» de tomate), cuántas
   * piezas de preparación da una de compra (1 tomate = 8 rodajas). Vale para todos los eventos: se guarda en el ingrediente.
   */
  function paintYield(): void {
    if (!menu) return;
    const recipeIds = new Set(cartaLinesInOrder(lines, menu.id).map((l) => l.recipe_id).filter((id): id is string => !!id));
    const counted = new Set(parts.filter((p) => !p.deleted_at && recipeIds.has(p.recipe_id) && p.unit === 'unidad').map((p) => p.ingredient_id));
    const list = ingredients.filter((g) => counted.has(g.id) && !g.deleted_at).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    if (!list.length) { replace(yieldHost); yieldHost.hidden = true; return; }
    yieldHost.hidden = false;
    // Lo que se compra por piezas (el pan) no necesita rendimiento: 1 pan = 1 pan (1116).
    const byPiece = (g: Mirror<Ingredient>) => ['ud', 'uds', 'unidad'].includes(String((g.item_id ? items.get(g.item_id)?.base_unit : '') ?? '').trim().toLowerCase());
    const row = (g: Mirror<Ingredient>) => {
      const purchase = el('select', { 'data-field-id': 'food.carta.prevision.rendimiento_compra', 'data-field-entity': 'food.ingredients', 'data-field-prop': 'purchase_unit', 'data-feedback-id': 'food.carta.prevision.rendimiento_compra', 'data-feedback-label': 'Unidad de compra', id: `yield-purchase-${g.id}`,
        'aria-label': `Cómo se compra ${g.name}`, disabled: !canWrite },
        ...(['unidad', 'paquete', 'manojo', 'kg', 'g', 'l', 'ml'] as const).filter((u) => (UNITS as readonly string[]).includes(u)).map((u) => el('option', { value: u, selected: (g.purchase_unit ?? 'unidad') === u }, u))) as HTMLSelectElement;
      const amount = el('input', { 'data-field-id': 'food.carta.prevision.rendimiento_cantidad', 'data-field-entity': 'food.ingredients', 'data-field-prop': 'yield', 'data-feedback-id': 'food.carta.prevision.rendimiento_cantidad', 'data-feedback-label': 'Piezas por unidad de compra', type: 'number', inputmode: 'decimal',
        min: '0', step: '0.5', id: `yield-n-${g.id}`, class: 'carta-units', 'aria-label': `Cuántas salen de ${g.name}`, disabled: !canWrite,
        value: g.yield === null || g.yield === undefined ? '' : String(Number(g.yield)) }) as HTMLInputElement;
      const prep = el('input', { 'data-field-id': 'food.carta.prevision.rendimiento_pieza', 'data-field-entity': 'food.ingredients', 'data-field-prop': 'prep_unit', 'data-feedback-id': 'food.carta.prevision.rendimiento_pieza', 'data-feedback-label': 'Unidad de preparación', type: 'text', maxlength: '30',
        id: `yield-prep-${g.id}`, class: 'carta-units', 'aria-label': `Unidad de preparación de ${g.name}`, placeholder: 'rodaja', disabled: !canWrite, value: g.prep_unit ?? '' }) as HTMLInputElement;
      const save = el('button', { 'data-feedback-id': 'food.carta.prevision.rendimiento_guardar', 'data-feedback-label': 'Guardar el rendimiento', class: 'ghost', type: 'button', id: `yield-save-${g.id}`,
        onclick: async () => {
          const n = amount.value.trim() === '' ? null : Number(amount.value.replace(',', '.'));
          const unit = prep.value.trim() || null;
          if ((n === null) !== (unit === null) || (n !== null && !(n > 0))) { toast('Escribe cuántas salen y de qué (8 rodajas), o deja los dos vacíos.'); return; }
          const fields = { purchase_unit: purchase.value as Unit, prep_unit: unit, yield: n };
          if (await usage.run('food.carta.prevision.rendimiento', () => commit(client, [{ op: 'update', table: T.ingredients, id: g.id, expectedRevision: g.revision, fields }]))) toast(`${g.name}: rendimiento guardado.`);
        } }, 'Guardar');
      return el('li', { class: 'carta-yieldrow', id: `yield-row-${g.id}` }, el('strong', null, g.name),
        (g.yield === null || g.yield === undefined) && !byPiece(g) ? el('span', { class: 'chip warn', id: `yield-missing-${g.id}` }, 'Falta') : null,
        el('span', { class: 'carta-yieldeq' }, '1', purchase, '=', amount, prep), canWrite ? save : null);
    };
    replace(yieldHost,
      el('h3', null, 'Rendimiento de los ingredientes'),
      el('p', { class: 'muted' }, 'Para los que las recetas cuentan en piezas: cuántas salen de una unidad de compra (1 tomate = 8 rodajas). Vale para todas las cartas y eventos, y con él la compra dice «3 tomates» y no «24 rodajas».'),
      el('ul', { class: 'plainlist carta-units-list' }, ...list.map(row)));
  }

  /**
   * «Rellenar previsión»: un total para un grupo de líneas (los montaditos, la barra o todo), repartido a partes iguales o
   * según la previsión que ya hay. Después se puede tocar línea a línea. Con asistentes, también el «por persona».
   */
  function openFill(live: Array<Mirror<CartaLine>>, people: number | null): void {
    const GROUPS = [
      { key: 'montaditos', label: 'Montaditos (Clásicos y Gourmet)', scopes: ['clasico', 'gourmet'] },
      { key: 'barra', label: 'Barra (bebidas y extras)', scopes: ['barra'] },
      { key: 'todo', label: 'Toda la carta', scopes: ['clasico', 'gourmet', 'barra'] },
    ] as const;
    const group = el('select', { 'data-field-none': '', 'data-feedback-id': 'food.carta.prevision.rellenar_grupo', 'data-feedback-label': 'Qué líneas', id: 'fillGroup', 'aria-label': 'Qué líneas' },
      ...GROUPS.map((g) => el('option', { value: g.key }, g.label)));
    const total = el('input', { 'data-field-none': '', 'data-feedback-id': 'food.carta.prevision.rellenar_total', 'data-feedback-label': 'Total esperado', id: 'fillTotal', type: 'number',
      inputmode: 'numeric', min: '0', step: '1', placeholder: '400' }) as HTMLInputElement;
    const mode = el('select', { 'data-field-none': '', 'data-feedback-id': 'food.carta.prevision.rellenar_modo', 'data-feedback-label': 'Cómo repartir', id: 'fillMode', 'aria-label': 'Cómo repartir' },
      el('option', { value: 'igual' }, 'A partes iguales'),
      el('option', { value: 'actual' }, 'Según la previsión que ya hay'));
    const preview = el('p', { class: 'muted', id: 'fillPreview' });
    const picked = () => { const g = GROUPS.find((x) => x.key === group.value)!; return live.filter((l) => (g.scopes as readonly string[]).includes(l.scope)); };
    const plan = () => {
      const rows = picked();
      const n = Number(total.value);
      if (!rows.length || !Number.isSafeInteger(n) || n < 0) return null;
      return { rows, units: distributeUnits(n, rows.length, mode.value === 'actual' ? rows.map((l) => l.expected_units ?? 0) : null) };
    };
    const paintPreview = () => {
      const p = plan();
      preview.textContent = p ? p.rows.map((l, i) => `${l.code} ${nameOf(l)}: ${p.units[i]}`).join(' · ') : 'Escribe el total y elige las líneas.';
    };
    [group, total, mode].forEach((x) => x.addEventListener('input', paintPreview));
    paintPreview();
    let sheet: Sheet | null = null;
    const save = el('button', { 'data-feedback-id': 'food.carta.prevision.rellenar_guardar', 'data-feedback-label': 'Rellenar', class: 'primary', type: 'button', id: 'fillSave',
      onclick: async () => {
        const p = plan();
        if (!p) { toast('Escribe un total entero y elige las líneas.'); return; }
        const ops: RowOperation[] = p.rows.map((l, i) => ({ op: 'update', table: T.cartaLines, id: l.id, expectedRevision: l.revision,
          fields: { expected_units: p.units[i], ...(people ? { per_person: perPersonFromUnits(p.units[i]!, people) } : {}) } }));
        if (await usage.run('food.carta.prevision.rellenar', () => commit(client, ops))) {
          toast(`Previsión rellenada: ${p.units.reduce((a, b) => a + b, 0)} unidades en ${p.rows.length} líneas.`);
          await sheet?.close(true);
        }
      } }, 'Rellenar');
    sheet = openSheet({
      title: 'Rellenar previsión',
      body: el('div', { class: 'formblock' },
        el('p', { class: 'muted' }, 'Reparte un total entre las líneas disponibles. Después puedes cambiar cada una.'),
        el('label', { class: 'field' }, el('span', null, 'Qué líneas'), group),
        el('label', { class: 'field' }, el('span', null, 'Total esperado'), total),
        el('label', { class: 'field' }, el('span', null, 'Cómo repartir'), mode),
        preview),
      foot: [el('button', { 'data-feedback-id': 'food.carta.prevision.rellenar_cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), save],
      initialFocus: total,
    });
  }

  function paintPlan(): void {
    if (!menu) return;
    const print = el('button', { 'data-feedback-id': 'food.carta.prevision.imprimir', 'data-feedback-label': 'Imprimir el plan de bandejas', class: 'ghost', type: 'button', id: 'printTrays',
      onclick: () => {
        usage.track('food.carta.prevision.imprimir');
        document.body.classList.add('carta-printing');
        const done = () => { document.body.classList.remove('carta-printing'); window.removeEventListener('afterprint', done); };
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
    // Sin rendimiento va aparte: se arregla aquí mismo, en «Rendimiento de los ingredientes» (y Flow cuenta mal los recipientes).
    const noYield = totals.filter((t) => t.missing === 'rendimiento' || (t.convertible && t.yield_missing));
    const missing = totals.filter((t) => !t.convertible && t.missing !== 'rendimiento');
    replace(planHost, head,
      el('p', { class: 'muted' }, 'Con las unidades esperadas y el reparto. Cantidades en la unidad del inventario.'),
      ingredients.length ? el('table', { class: 'carta-plan', id: 'trayTable' },
        el('thead', null, el('tr', null, ...['Ingrediente', 'Estación', 'Total', 'Mesa', 'Nevera', 'Fresco'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', null, ...ingredients.map((t) => el('tr', { class: t.convertible ? '' : 'carta-missing' },
          el('th', { scope: 'row' }, t.name),
          el('td', null, t.station ? `${t.station} · ${STATION_LABELS[t.station] ?? ''}` : '—'),
          el('td', null, t.convertible ? formatAmount(t.need_total, t.unit) : prepMissingLabel(t),
            t.convertible && t.yield_missing ? el('small', { class: 'muted carta-buy' }, ' · sin rendimiento: piezas enteras') : null,
            purchaseFromPrep(t.prep_need_total, t.yield) !== null && t.prep_unit ? el('small', { class: 'muted carta-buy' }, ` · ${Number(t.prep_need_total).toLocaleString('es-ES')} ${t.prep_unit} = comprar ${purchaseFromPrep(t.prep_need_total, t.yield)} ${t.purchase_unit ?? 'unidad'}`) : null),
          el('td', null, amount(t, t.mesa)), el('td', null, amount(t, t.nevera)), el('td', null, amount(t, t.fresco)))))) : el('p', { class: 'muted' }, 'Sin unidades esperadas todavía.'),
      extras.length ? el('div', null, el('div', { class: 'sectionlabel' }, 'Bebidas y extras'),
        el('ul', { class: 'plainlist' }, ...extras.map((t) => el('li', null, el('strong', null, t.name), ': ', t.convertible ? formatAmount(t.need_total, t.unit) : prepMissingLabel(t))))) : null,
      noYield.length ? el('div', { class: 'banner warn notice', role: 'note', id: 'trayNoYield' },
        el('div', null, el('strong', null, `Falta el rendimiento: ${noYield.map((t) => t.name).join(', ')}.`),
          ' Las recetas los cuentan en piezas. Di cuántas salen de una de compra (1 tomate = 8 rodajas); sin eso, Flow no sabe cuántos recipientes salen y la compra cuenta piezas enteras.'),
        yieldHost.hidden ? null : el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.carta.prevision.ir_rendimiento', 'data-feedback-label': 'Ir al rendimiento', class: 'ghost', type: 'button',
          onclick: () => yieldHost.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 'Ir al rendimiento'))) : null,
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
    [ingredients, parts] = await Promise.all([client.list(T.ingredients) as Promise<Array<Mirror<Ingredient>>>, client.list(T.recipeIngredients) as Promise<Array<Mirror<RecipeIngredient>>>]);
    menu = row && !row.deleted_at ? row : null;
    lines = allLines;
    recipes = new Map(allRecipes.map((r) => [r.id, r]));
    items = new Map(allItems.map((i) => [i.id, i]));
    paintSplit();
    paintUnits();
    paintYield();
    paintPlan();
  }

  void load().then(loadTotals);
  const offEvents = watchEvents(client, (next) => {
    const guests = menu?.event_id ? next.events.find((e) => e.event_id === menu!.event_id)?.guest_count ?? null : null;
    if (guests !== eventGuests) { eventGuests = guests; paintUnits(); }
  });
  // Tras guardar (o sincronizar) unidades o reparto, el plan se vuelve a pedir al servidor.
  const offs = [T.menus, T.cartaLines, T.recipeIngredients, T.ingredients].map((table) => client.onTable(table, () => void load().then(loadTotals)));
  return () => { offEvents(); offs.forEach((off) => off()); document.body.classList.remove('carta-printing'); };
}
