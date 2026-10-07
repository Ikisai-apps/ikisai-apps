import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import {
  ingredientKey, lineCost, priceFor, validateOperations,
  type Allergen, type DietTag, type Equipment, type Ingredient, type Recipe, type RecipeEquipment, type RecipeIngredient, type Unit,
} from '@ikisai/domain-food';
import { closeSheet, confirmDialog, createLabelPicker, el, formatDate, icon, listRow, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { guard } from '../app/guard.ts';
import {
  ALLERGENS, ALLERGEN_LABELS, CATEGORY_LABELS, DIET_LABELS, DIET_TAGS, EQUIPMENT_STATUS_LABELS, RECIPE_CATEGORIES, RECIPE_STATUSES, RECIPE_STATUS_LABELS,
  T, UNITS, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror,
} from '../app/client.ts';
import { loadPurchases, type PurchasesSnapshot } from '../app/purchases.ts';
import { isBlobMarker, preparePhoto, showPhoto, stagePhoto, type PhotoRef, type PreparedPhoto } from '../app/photos.ts';
import { usage } from '../app/usage.ts';
import { fb } from './feedback.ts';
import type { ViewMount } from './shell.ts';

/** Par de atributos de «Sugerencias y QA» que los helpers de esta vista reciben ya escrito en literal. */
type Mark = { 'data-feedback-id': string; 'data-feedback-label': string };

/** En el espejo local la foto puede ser todavía un marcador de blob en cola. */
type RecipeRow = Mirror<Omit<Recipe, 'photo_file_id' | 'photo_thumb_file_id'> & { photo_file_id: PhotoRef; photo_thumb_file_id: PhotoRef }>;
type IngredientRow = Mirror<Ingredient>;
type LineRow = Mirror<RecipeIngredient>;
type EquipmentRow = Mirror<Equipment>;
type NeedRow = Mirror<RecipeEquipment>;

const text = (value: string) => value.trim() || null;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** La validación de dominio corre aquí igual que en la Edge; los marcadores de foto se resuelven después, al subir. */
function localIssue(operations: RowOperation[]): string | null {
  const plain = operations.map((op) => ('fields' in op && op.fields
    ? { ...op, fields: Object.fromEntries(Object.entries(op.fields).filter(([, value]) => !isBlobMarker(value))) }
    : op));
  return validateOperations(plain)?.message ?? null;
}

function tagLine(recipe: RecipeRow): string {
  return [CATEGORY_LABELS[recipe.category], ...recipe.diet_tags.map((t) => DIET_LABELS[t])].join(' · ');
}

/** Recetario visual: tarjetas con foto, ficha en lectura y edición por bloques (docs/food/API.md §9). */
export const mountRecipes: ViewMount = ({ main, client }) => {
  let recipes: RecipeRow[] = [];
  let ingredients: IngredientRow[] = [];
  let lines: LineRow[] = [];
  let equipment: EquipmentRow[] = [];
  let needs: NeedRow[] = [];
  let sheet: Sheet | null = null;
  let purchases: PurchasesSnapshot = { purchases: [], prices: new Map(), fetchedAt: null };
  const filter = { query: '', category: '', diet: '', allergen: '', status: '' };
  const canWrite = () => client.bootstrap()?.membership.role !== 'reader';

  const select = (id: string, label: string, options: Array<[string, string]>, key: keyof typeof filter, mark: Mark) => {
    const node = el('select', { ...mark, id, class: 'compact', 'aria-label': label, onchange: () => { filter[key] = node.value; paint(); } },
      el('option', { value: '' }, label), ...options.map(([value, name]) => el('option', { value }, name)));
    return node;
  };
  const search = el('input', { 'data-feedback-id': 'food.recetario.filtros.buscar', 'data-feedback-label': 'Buscar receta', type: 'search', id: 'recipeSearch', placeholder: 'Buscar receta', 'aria-label': 'Buscar recetas', autocomplete: 'off',
    oninput: () => { filter.query = search.value.trim().toLowerCase(); paint(); } });
  const grid = el('ul', { 'data-feedback-id': 'food.recetario.tarjetas', 'data-feedback-label': 'Recetas', class: 'recipegrid', id: 'recipeGrid', 'aria-label': 'Recetas' });
  const host = el('div');
  const empty = el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay recetas'), 'Crea la primera con «Nueva receta». La foto se puede hacer con el móvil, también sin conexión.');
  const emptyFiltered = el('div', { class: 'empty plain' }, 'Ninguna receta coincide con la búsqueda o los filtros.');
  const trashList = el('ul', { class: 'list', 'aria-label': 'Recetas en la papelera' });
  const trashLabel = el('summary', { 'data-feedback-id': 'food.recetario.papelera.abrir', 'data-feedback-label': 'Abrir papelera', class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera', el('span', { class: 'count' }, '0'));
  const trash = el('details', { 'data-feedback-id': 'food.recetario.papelera', 'data-feedback-label': 'Papelera', id: 'trash' }, trashLabel, trashList);
  const fab = el('button', { 'data-feedback-id': 'food.recetario.nueva', 'data-feedback-label': 'Nueva receta', class: 'fab', type: 'button', id: 'newRecipe', onclick: () => openEditor(null) }, icon('plus'), 'Nueva receta');

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Recetario'), el('p', null, 'Las recetas de la casa, con su foto, sus ingredientes y sus alérgenos.'))),
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)),
    el('div', { 'data-feedback-id': 'food.recetario.filtros', 'data-feedback-label': 'Filtros', class: 'filters' },
      select('filterCategory', 'Categoría', RECIPE_CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]]), 'category', { 'data-feedback-id': 'food.recetario.filtros.categoria', 'data-feedback-label': 'Filtrar por categoría' }),
      select('filterDiet', 'Dieta', DIET_TAGS.map((d) => [d, DIET_LABELS[d]]), 'diet', { 'data-feedback-id': 'food.recetario.filtros.dieta', 'data-feedback-label': 'Filtrar por dieta' }),
      select('filterAllergen', 'Alérgeno', ALLERGENS.map((a) => [a, ALLERGEN_LABELS[a]]), 'allergen', { 'data-feedback-id': 'food.recetario.filtros.alergeno', 'data-feedback-label': 'Filtrar por alérgeno' }),
      select('filterStatus', 'Estado', RECIPE_STATUSES.map((s) => [s, RECIPE_STATUS_LABELS[s]]), 'status', { 'data-feedback-id': 'food.recetario.filtros.estado', 'data-feedback-label': 'Filtrar por estado' }),
    ),
    host,
    trash,
    fab,
  );

  function matches(recipe: RecipeRow): boolean {
    if (filter.query && !`${recipe.name} ${recipe.public_name ?? ''}`.toLowerCase().includes(filter.query)) return false;
    if (filter.category && recipe.category !== filter.category) return false;
    if (filter.diet && !recipe.diet_tags.includes(filter.diet as DietTag)) return false;
    if (filter.allergen && !recipe.allergens.includes(filter.allergen as Allergen)) return false;
    if (filter.status ? recipe.status !== filter.status : recipe.status === 'archivada') return false; // las archivadas solo salen si se piden
    return true;
  }

  function card(recipe: RecipeRow): HTMLElement {
    const img = el('img', { alt: '', loading: 'lazy', hidden: true });
    showPhoto(client, img, recipe.photo_thumb_file_id ?? recipe.photo_file_id);
    const chips = [
      recipe.status !== 'validada' ? el('span', { class: recipe.status === 'archivada' ? 'chip trash' : 'chip' }, RECIPE_STATUS_LABELS[recipe.status]) : null,
      recipe._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null,
    ];
    return el('li', null,
      el('button', { 'data-feedback-id': 'food.recetario.tarjetas.tarjeta', 'data-feedback-label': 'Tarjeta de receta', class: 'recipecard', type: 'button', 'data-id': recipe.id, 'data-pending': String(recipe._pending === true), 'aria-label': `Abrir ${recipe.name}`, onclick: () => openCard(recipe) },
        el('span', { class: 'recipephoto' }, icon('chef', 30), img),
        el('span', { class: 'recipebody' }, el('strong', { title: recipe.name }, recipe.name), el('span', { class: 'recipemeta' }, tagLine(recipe)), el('span', { class: 'chips' }, ...chips)),
      ));
  }

  function paint(): void {
    const sorted = [...recipes].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const live = sorted.filter((r) => !r.deleted_at);
    const deleted = sorted.filter((r) => r.deleted_at);
    const visible = live.filter(matches);
    replace(grid, ...visible.map(card));
    replace(host, live.length === 0 ? empty : visible.length === 0 ? emptyFiltered : grid);
    replace(trashList, ...deleted.map((r) => fb(listRow({
      id: r.id, title: r.name, meta: [tagLine(r)], pending: r._pending === true, deleted: true,
      actions: [el('button', { 'data-feedback-id': 'food.recetario.papelera.restaurar', 'data-feedback-label': 'Restaurar receta', class: 'linkbtn', type: 'button', 'aria-label': `Restaurar ${r.name}`, onclick: () => void restoreRecipe(r) }, icon('restore', 18), 'Restaurar')],
    }), { feedbackId: 'food.recetario.papelera.fila', feedbackLabel: 'Receta en la papelera' })));
    trashLabel.querySelector('.count')!.textContent = String(deleted.length);
    trash.hidden = deleted.length === 0 || !canWrite();
    fab.hidden = !canWrite();
  }

  async function load(): Promise<void> {
    [recipes, ingredients, lines, equipment, needs] = await Promise.all([
      client.list(T.recipes, { includeDeleted: true }) as Promise<RecipeRow[]>,
      client.list(T.ingredients) as Promise<IngredientRow[]>,
      client.list(T.recipeIngredients, { includeDeleted: true }) as Promise<LineRow[]>,
      client.list(T.equipment) as Promise<EquipmentRow[]>,
      client.list(T.recipeEquipment, { includeDeleted: true }) as Promise<NeedRow[]>,
    ]);
    paint();
  }

  const linesOf = (recipeId: string) => lines.filter((l) => l.recipe_id === recipeId && !l.deleted_at).sort((a, b) => Number(a.position) - Number(b.position));
  const needsOf = (recipeId: string) => needs.filter((n) => n.recipe_id === recipeId && !n.deleted_at);

  /** `track` envuelve el envío para medir el uso (p. ej. `usage.run` al guardar); el error sigue llegando al `catch`. */
  async function commitSafely(operations: RowOperation[], okMessage: string, track: (send: () => Promise<unknown>) => Promise<unknown> = (send) => send()): Promise<boolean> {
    const issue = localIssue(operations);
    if (issue) { toast(issue); return false; }
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

  const removeOp = (table: (typeof T)[keyof typeof T], row: SyncedRow): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });

  /** Borrar una receta se lleva sus líneas en el mismo lote; restaurarla las trae de vuelta. */
  async function deleteRecipe(recipe: RecipeRow): Promise<void> {
    if (!(await confirmDialog({ title: `¿Enviar «${recipe.name}» a la papelera?`, text: 'Se puede restaurar desde la papelera. Si está en algún menú, archívala en su lugar.', confirmLabel: 'Enviar a papelera', danger: true }))) return;
    guard.dirtyEditor = false;
    const operations = [...linesOf(recipe.id).map((l) => removeOp(T.recipeIngredients, l)), ...needsOf(recipe.id).map((n) => removeOp(T.recipeEquipment, n)), removeOp(T.recipes, recipe)];
    if (await commitSafely(operations, `«${recipe.name}» enviada a la papelera.`)) await sheet?.close(true);
  }

  async function restoreRecipe(recipe: RecipeRow): Promise<void> {
    const restore = (table: (typeof T)[keyof typeof T], row: SyncedRow): RowOperation => ({ op: 'restore', table, id: row.id, expectedRevision: row.revision });
    // Las líneas borradas con la receta comparten su instante de borrado (mismo lote); las que se quitaron antes, no.
    const at = Date.parse(recipe.deleted_at ?? '');
    const together = <R extends SyncedRow & { recipe_id: string }>(rows: R[]) =>
      rows.filter((r) => r.recipe_id === recipe.id && !!r.deleted_at && Math.abs(Date.parse(r.deleted_at) - at) <= 2000);
    await commitSafely(
      [restore(T.recipes, recipe), ...together(lines).map((l) => restore(T.recipeIngredients, l)), ...together(needs).map((n) => restore(T.recipeEquipment, n))],
      `«${recipe.name}» restaurada.`);
  }

  const euros = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

  /** Coste de la receta a sus raciones base con las compras de Invoices; avisa si a algún ingrediente le falta precio. */
  function recipeCostLine(recipe: RecipeRow, lines: LineRow[]): HTMLElement | null {
    if (!purchases.fetchedAt || lines.length === 0) return null;
    const costs = lines.map((l) => lineCost(l.ingredient_id, Number(l.quantity), l.unit, purchases.prices));
    const total = costs.reduce<number>((sum, c) => sum + (c ?? 0), 0);
    const missing = costs.filter((c) => c === null).length;
    const stale = lines.filter((l) => priceFor(l.ingredient_id, l.unit, purchases.prices)?.stale).length;
    return el('p', { class: 'recipecost' }, el('strong', null, 'Coste estimado: '),
      `${euros(total)} para ${formatQuantity(recipe.base_servings)} raciones (${euros(total / Number(recipe.base_servings))} por ración)`,
      missing ? el('span', { class: 'muted' }, ` · ${missing === 1 ? '1 ingrediente' : `${missing} ingredientes`} sin precio`) : null,
      stale ? el('span', { class: 'warnline' }, ` · * precio de la última compra, de hace más de 3 meses (${stale === 1 ? '1 ingrediente' : `${stale} ingredientes`})`) : null);
  }

  // --- Ficha en lectura -----------------------------------------------------------------
  function openCard(recipe: RecipeRow): void {
    const img = el('img', { alt: `Foto de ${recipe.name}`, hidden: true });
    showPhoto(client, img, recipe.photo_file_id);
    const names = new Map(ingredients.map((i) => [i.id, i.name]));
    const machines = new Map(equipment.map((e) => [e.id, e]));
    const block = (mark: Mark, title: string, ...content: Array<HTMLElement | null>) => (content.some(Boolean) ? el('section', { ...mark, class: 'ficha-block' }, el('h4', null, title), ...content) : null);
    const para = (label: string, value: string | null) => (value ? el('p', null, el('strong', null, `${label}: `), value) : null);
    const recipeLines = linesOf(recipe.id);
    const recipeNeeds = needsOf(recipe.id);

    const body = el('div', { 'data-feedback-id': 'food.recetario.ficha', 'data-feedback-label': 'Ficha de receta', class: 'ficha' },
      recipe.photo_file_id ? el('div', { 'data-feedback-id': 'food.recetario.ficha.foto', 'data-feedback-label': 'Foto de la receta', class: 'ficha-photo' }, img) : null,
      // El nombre público solo se repite si es distinto del interno.
      (recipe.public_name && recipe.public_name.trim() !== recipe.name.trim()) || recipe.public_description
        ? el('div', { 'data-feedback-id': 'food.recetario.ficha.presentacion', 'data-feedback-label': 'Presentación pública', class: 'ficha-public' }, recipe.public_name && recipe.public_name.trim() !== recipe.name.trim() ? el('strong', null, recipe.public_name) : null, recipe.public_description ? el('p', null, recipe.public_description) : null)
        : null,
      el('p', { class: 'recipemeta' }, `${tagLine(recipe)} · ${formatQuantity(recipe.base_servings)} raciones base`),
      el('div', { class: 'chips' },
        el('span', { class: recipe.status === 'validada' ? 'chip ok' : 'chip' }, RECIPE_STATUS_LABELS[recipe.status]),
        recipe._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null),
      block({ 'data-feedback-id': 'food.recetario.ficha.ingredientes', 'data-feedback-label': 'Ingredientes' }, 'Ingredientes', recipeLines.length
        ? el('table', { class: 'ingredients' }, el('tbody', null, ...recipeLines.map((l) => {
            const cost = purchases.fetchedAt ? lineCost(l.ingredient_id, Number(l.quantity), l.unit, purchases.prices) : null;
            return el('tr', null,
              el('td', null, names.get(l.ingredient_id) ?? '—'), el('td', { class: 'num' }, formatQuantity(l.quantity)), el('td', null, UNIT_LABELS[l.unit]),
              purchases.fetchedAt ? el('td', { class: cost === null ? 'num muted' : priceFor(l.ingredient_id, l.unit, purchases.prices)?.stale ? 'num warnline' : 'num', title: priceFor(l.ingredient_id, l.unit, purchases.prices)?.stale ? `Precio de la última compra (${priceFor(l.ingredient_id, l.unit, purchases.prices)?.lastDate ?? 'sin fecha'}), de hace más de 3 meses` : null }, cost === null ? 'sin precio' : `${euros(cost)}${priceFor(l.ingredient_id, l.unit, purchases.prices)?.stale ? ' *' : ''}`) : null);
          })))
        : el('p', { class: 'muted' }, 'Sin ingredientes todavía.'),
        recipeCostLine(recipe, recipeLines)),
      block({ 'data-feedback-id': 'food.recetario.ficha.elaboracion', 'data-feedback-label': 'Elaboración' }, 'Elaboración', recipe.method ? el('p', { class: 'pre' }, recipe.method) : null, para('Antelación', recipe.prep_minutes != null ? `${recipe.prep_minutes} minutos antes del servicio` : null)),
      block({ 'data-feedback-id': 'food.recetario.ficha.seguridad', 'data-feedback-label': 'Seguridad' }, 'Seguridad',
        el('p', null, el('strong', null, 'Alérgenos: '), recipe.allergens.length ? recipe.allergens.map((a) => ALLERGEN_LABELS[a]).join(', ') : 'ninguno declarado'),
        recipe.allergens_checked ? el('p', { class: 'muted' }, 'Alérgenos revisados.') : el('p', null, el('span', { class: 'chip alert' }, 'Alérgenos sin revisar'))),
      block({ 'data-feedback-id': 'food.recetario.ficha.maquinaria', 'data-feedback-label': 'Maquinaria' }, 'Maquinaria', recipeNeeds.length ? el('ul', { class: 'plainlist' }, ...recipeNeeds.map((n) => {
        const machine = machines.get(n.equipment_id);
        const short = machine && n.quantity_required > machine.quantity ? ` · hacen falta ${n.quantity_required} y hay ${machine.quantity}` : '';
        const down = machine && (machine.status === 'averiado' || machine.status === 'fuera_de_servicio') ? ` · ${EQUIPMENT_STATUS_LABELS[machine.status].toLowerCase()}` : '';
        return el('li', { class: short || down ? 'warnline' : '' }, `${n.quantity_required} × ${machine?.name ?? 'máquina retirada'}${short}${down}`);
      })) : null),
      block({ 'data-feedback-id': 'food.recetario.ficha.conservacion', 'data-feedback-label': 'Conservación y servicio' }, 'Conservación y servicio', para('Conservación', recipe.conservation), recipe.freezable ? el('p', null, 'Se puede congelar.') : null, para('Regeneración', recipe.regeneration), para('Servicio', recipe.service_notes)),
    );

    sheet = openSheet({
      title: recipe.name,
      meta: `Revisión ${recipe.revision} · actualizada ${formatDate(recipe.updated_at)}`,
      body,
      foot: canWrite()
        ? [el('button', { 'data-feedback-id': 'food.recetario.ficha.cerrar', 'data-feedback-label': 'Cerrar ficha', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cerrar'), el('button', { 'data-feedback-id': 'food.recetario.ficha.editar', 'data-feedback-label': 'Editar receta', class: 'primary', type: 'button', id: 'editRecipe', onclick: () => openEditor(recipe) }, 'Editar')]
        : [el('button', { 'data-feedback-id': 'food.recetario.ficha.cerrar', 'data-feedback-label': 'Cerrar ficha', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cerrar')],
      onClose: () => { sheet = null; },
    });
  }

  // --- Edición por bloques --------------------------------------------------------------
  function openEditor(recipe: RecipeRow | null): void {
    const recipeId = recipe?.id ?? crypto.randomUUID();
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
    const input = (id: string, value: string | null, attrs: Record<string, unknown> = {}) => el('input', { id, type: 'text', value: value ?? '', ...attrs });
    const area = (id: string, value: string | null, rows: number, mark: Mark) => { const node = el('textarea', { ...mark, id, rows: String(rows) }); node.value = value ?? ''; return node; };
    const field = (label: string, control: HTMLElement, hint?: string) => el('label', { class: 'field' }, el('span', null, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
    const check = (id: string, label: string, checked: boolean, mark: Mark) => { const box = el('input', { ...mark, id, type: 'checkbox', checked }); return { box, node: el('label', { class: 'checkline' }, box, el('span', null, label)) }; };

    // Foto
    let newPhoto: PreparedPhoto | null = null;
    let removePhoto = false;
    const preview = el('img', { alt: 'Foto de la receta', hidden: true });
    if (recipe?.photo_file_id) showPhoto(client, preview, recipe.photo_file_id);
    const fileInput = el('input', { 'data-feedback-id': 'food.recetario.foto.archivo', 'data-feedback-label': 'Archivo de foto', id: 'r-photo', type: 'file', accept: 'image/*', class: 'visually-hidden',
      onchange: async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
          newPhoto = await preparePhoto(file);
          removePhoto = false;
          preview.src = URL.createObjectURL(newPhoto.display);
          preview.hidden = false;
          photoNote.textContent = `Foto lista: ${Math.round(newPhoto.display.size / 1024)} KB. El original no se guarda.`;
          guard.dirtyEditor = true;
        } catch (e) {
          toast(describeError(e));
        }
      } });
    const photoNote = el('span', { class: 'hint', id: 'photoNote' }, 'Se recomprime en este dispositivo antes de subir; el original no se guarda.');
    const photoBlock = el('div', { 'data-feedback-id': 'food.recetario.foto', 'data-feedback-label': 'Foto', class: 'photoedit' },
      el('div', { class: 'ficha-photo' }, icon('camera', 30), preview),
      el('div', { class: 'btnrow' },
        el('label', { 'data-feedback-id': 'food.recetario.foto.elegir', 'data-feedback-label': 'Elegir o hacer foto', class: 'ghost filebtn', for: 'r-photo' }, icon('camera', 18), 'Elegir o hacer foto'), fileInput,
        el('button', { 'data-feedback-id': 'food.recetario.foto.quitar', 'data-feedback-label': 'Quitar foto', class: 'linkbtn', type: 'button', id: 'removePhoto', onclick: () => { newPhoto = null; removePhoto = true; preview.hidden = true; photoNote.textContent = 'La receta quedará sin foto.'; guard.dirtyEditor = true; } }, 'Quitar foto')),
      photoNote);

    // Presentación y cocina
    const name = input('r-name', recipe?.name ?? '', { 'data-feedback-id': 'food.recetario.formulario.nombre', 'data-feedback-label': 'Nombre', required: true, maxlength: '160' });
    const publicName = input('r-public-name', recipe?.public_name ?? null, { 'data-feedback-id': 'food.recetario.formulario.nombre_publico', 'data-feedback-label': 'Nombre público', maxlength: '160' });
    const publicDescription = area('r-public-description', recipe?.public_description ?? null, 2, { 'data-feedback-id': 'food.recetario.formulario.descripcion_publica', 'data-feedback-label': 'Descripción pública' });
    const category = el('select', { 'data-feedback-id': 'food.recetario.formulario.categoria', 'data-feedback-label': 'Categoría', id: 'r-category' }, ...RECIPE_CATEGORIES.map((c) => el('option', { value: c, selected: (recipe?.category ?? 'principal') === c }, CATEGORY_LABELS[c])));
    const servings = input('r-servings', recipe ? formatQuantity(recipe.base_servings) : '', { 'data-feedback-id': 'food.recetario.formulario.raciones', 'data-feedback-label': 'Raciones base', inputmode: 'decimal', required: true });
    const method = area('r-method', recipe?.method ?? null, 5, { 'data-feedback-id': 'food.recetario.formulario.elaboracion', 'data-feedback-label': 'Elaboración' });
    const prep = input('r-prep', recipe?.prep_minutes != null ? String(recipe.prep_minutes) : '', { 'data-feedback-id': 'food.recetario.formulario.antelacion', 'data-feedback-label': 'Antelación', inputmode: 'numeric' });
    const conservation = area('r-conservation', recipe?.conservation ?? null, 2, { 'data-feedback-id': 'food.recetario.formulario.conservacion', 'data-feedback-label': 'Conservación' });
    const freezable = check('r-freezable', 'Se puede congelar', recipe?.freezable ?? false, { 'data-feedback-id': 'food.recetario.formulario.congelable', 'data-feedback-label': 'Se puede congelar' });
    const regeneration = area('r-regeneration', recipe?.regeneration ?? null, 2, { 'data-feedback-id': 'food.recetario.formulario.regeneracion', 'data-feedback-label': 'Regeneración' });
    const serviceNotes = area('r-service', recipe?.service_notes ?? null, 2, { 'data-feedback-id': 'food.recetario.formulario.notas_servicio', 'data-feedback-label': 'Notas de servicio' });

    // Seguridad
    // Dietas y alérgenos con el selector de etiquetas del kit: dos familias, chips conmutables y resumen arriba.
    const tags = createLabelPicker({
      label: 'Dietas y alérgenos',
      families: [{ id: 'diet', name: 'Dietas', color: '#5f7a4a' }, { id: 'allergen', name: 'Alérgenos que contiene', color: '#b4532a' }],
      labels: [
        ...DIET_TAGS.map((d) => ({ id: `diet:${d}`, name: DIET_LABELS[d], familyId: 'diet' })),
        ...ALLERGENS.map((a) => ({ id: `allergen:${a}`, name: ALLERGEN_LABELS[a], familyId: 'allergen' })),
      ],
      selected: [...(recipe?.diet_tags ?? []).map((d) => `diet:${d}`), ...(recipe?.allergens ?? []).map((a) => `allergen:${a}`)],
      search: false,
      collapsed: false,
      onChange: () => { guard.dirtyEditor = true; },
    });
    fb(tags.element, { feedbackId: 'food.recetario.formulario.dietas_alergenos', feedbackLabel: 'Dietas y alérgenos' });
    const checked = check('r-allergens-checked', 'He revisado los alérgenos de esta receta', recipe?.allergens_checked ?? false, { 'data-feedback-id': 'food.recetario.formulario.alergenos_revisados', 'data-feedback-label': 'Alérgenos revisados' });
    const status = el('select', { 'data-feedback-id': 'food.recetario.formulario.estado', 'data-feedback-label': 'Estado', id: 'r-status' }, ...RECIPE_STATUSES.map((s) => el('option', { value: s, selected: (recipe?.status ?? 'en_prueba') === s }, RECIPE_STATUS_LABELS[s])));

    // Ingredientes
    const datalist = el('datalist', { id: 'ingredientNames' }, ...ingredients.map((i) => el('option', { value: i.name })));
    interface LineForm { line: LineRow | null; name: HTMLInputElement; quantity: HTMLInputElement; unit: HTMLSelectElement; node: HTMLElement }
    const lineForms: LineForm[] = [];
    const lineHost = el('div', { 'data-feedback-id': 'food.recetario.ingredientes.lista', 'data-feedback-label': 'Lista de ingredientes', class: 'linerows', id: 'ingredientRows' });
    const names = new Map(ingredients.map((i) => [i.id, i]));
    function addLine(line: LineRow | null): void {
      const known = line ? names.get(line.ingredient_id) : null;
      const form: LineForm = {
        line,
        name: el('input', { 'data-feedback-id': 'food.recetario.ingredientes.nombre', 'data-feedback-label': 'Ingrediente', type: 'text', list: 'ingredientNames', placeholder: 'Ingrediente', 'aria-label': 'Ingrediente', maxlength: '120', value: known?.name ?? '',
          onchange: () => { const hit = byKey(form.name.value); if (hit && !form.line && !form.quantity.value) form.unit.value = hit.preferred_unit; } }),
        quantity: el('input', { 'data-feedback-id': 'food.recetario.ingredientes.cantidad', 'data-feedback-label': 'Cantidad', type: 'text', inputmode: 'decimal', placeholder: 'Cantidad', 'aria-label': 'Cantidad', value: line ? formatQuantity(line.quantity) : '' }),
        unit: el('select', { 'data-feedback-id': 'food.recetario.ingredientes.unidad', 'data-feedback-label': 'Unidad', 'aria-label': 'Unidad' }, ...UNITS.map((u) => el('option', { value: u, selected: (line?.unit ?? 'g') === u }, UNIT_LABELS[u]))),
        node: el('div', { 'data-feedback-id': 'food.recetario.ingredientes.linea', 'data-feedback-label': 'Línea de ingrediente', class: 'linerow' }),
      };
      form.node.append(form.name, form.quantity, form.unit,
        el('button', { 'data-feedback-id': 'food.recetario.ingredientes.quitar', 'data-feedback-label': 'Quitar ingrediente', class: 'iconbtn', type: 'button', 'aria-label': 'Quitar ingrediente', onclick: () => { lineForms.splice(lineForms.indexOf(form), 1); form.node.remove(); guard.dirtyEditor = true; } }, icon('close', 18)));
      lineForms.push(form);
      lineHost.append(form.node);
    }
    const byKey = (value: string) => ingredients.find((i) => ingredientKey(i.name) === ingredientKey(value)) ?? null;
    const existingLines = recipe ? linesOf(recipe.id) : [];
    existingLines.forEach(addLine);

    // Maquinaria
    const existingNeeds = recipe ? needsOf(recipe.id) : [];
    const machineForms = [...equipment].sort((a, b) => a.name.localeCompare(b.name, 'es')).map((machine) => {
      const need = existingNeeds.find((n) => n.equipment_id === machine.id) ?? null;
      const box = el('input', { 'data-feedback-id': 'food.recetario.formulario.maquinaria.equipo', 'data-feedback-label': 'Necesita esta máquina', type: 'checkbox', checked: !!need, id: `r-machine-${machine.id}` });
      const quantity = el('input', { 'data-feedback-id': 'food.recetario.formulario.maquinaria.unidades', 'data-feedback-label': 'Unidades necesarias', type: 'number', min: '1', step: '1', inputmode: 'numeric', value: String(need?.quantity_required ?? 1), 'aria-label': `Unidades de ${machine.name}`, class: 'qty compact' });
      return { machine, need, box, quantity, node: el('div', { class: 'machinerow' }, el('label', { class: 'checkline', for: box.id }, box, el('span', null, machine.name)), quantity) };
    });

    function build(photo: Record<string, unknown>): { operations: RowOperation[]; problem?: { message: string; focus?: HTMLElement } } {
      const base = parseQuantity(servings.value);
      if (!name.value.trim()) return { operations: [], problem: { message: 'El nombre es obligatorio.', focus: name } };
      if (base === null || base <= 0) return { operations: [], problem: { message: 'Indica las raciones base (por ejemplo, 20).', focus: servings } };
      if (prep.value.trim() && !/^\d+$/.test(prep.value.trim())) return { operations: [], problem: { message: 'La antelación va en minutos enteros.', focus: prep } };
      if (status.value === 'validada' && !checked.box.checked) return { operations: [], problem: { message: 'Revisa los alérgenos antes de validar la receta.', focus: checked.box } };

      const operations: RowOperation[] = [];
      const picked = new Set(tags.get());
      const fields: Record<string, unknown> = {
        name: name.value.trim(), public_name: text(publicName.value), public_description: text(publicDescription.value), category: category.value,
        base_servings: base, method: text(method.value), prep_minutes: prep.value.trim() ? Number(prep.value.trim()) : null,
        conservation: text(conservation.value), freezable: freezable.box.checked, regeneration: text(regeneration.value), service_notes: text(serviceNotes.value),
        diet_tags: DIET_TAGS.filter((d) => picked.has(`diet:${d}`)), allergens: ALLERGENS.filter((a) => picked.has(`allergen:${a}`)),
        allergens_checked: checked.box.checked, status: status.value, ...photo,
      };

      // Ingredientes nuevos van en el mismo lote que la línea que los usa: si el servidor rechaza uno, no queda nada a medias.
      const created = new Map<string, string>();
      const resolved: Array<{ form: LineForm; ingredientId: string; quantity: number; unit: Unit }> = [];
      for (const form of lineForms) {
        const label = form.name.value.trim();
        if (!label && !form.quantity.value.trim()) continue;
        const quantity = parseQuantity(form.quantity.value);
        if (!label) return { operations: [], problem: { message: 'Falta el nombre de un ingrediente.', focus: form.name } };
        if (quantity === null || quantity <= 0) return { operations: [], problem: { message: `Indica la cantidad de ${label}.`, focus: form.quantity } };
        const unit = form.unit.value as Unit;
        let ingredientId = byKey(label)?.id ?? created.get(ingredientKey(label));
        if (!ingredientId) {
          ingredientId = crypto.randomUUID();
          created.set(ingredientKey(label), ingredientId);
          operations.push({ op: 'insert', table: T.ingredients, id: ingredientId, fields: { name: label.replace(/\s+/g, ' '), preferred_unit: unit } });
        }
        resolved.push({ form, ingredientId, quantity, unit });
      }

      if (!recipe) operations.push({ op: 'insert', table: T.recipes, id: recipeId, fields });
      else {
        const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => !same(recipe[key], value)));
        if (Object.keys(changed).length) operations.push({ op: 'update', table: T.recipes, id: recipe.id, expectedRevision: recipe.revision, fields: changed });
      }

      resolved.forEach(({ form, ingredientId, quantity, unit }, index) => {
        const position = index + 1;
        if (!form.line) {
          operations.push({ op: 'insert', table: T.recipeIngredients, id: crypto.randomUUID(), fields: { recipe_id: recipeId, ingredient_id: ingredientId, quantity, unit, position } });
        } else {
          const next = { ingredient_id: ingredientId, quantity, unit, position };
          const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => (key === 'quantity' || key === 'position' ? Number(form.line![key]) !== value : form.line![key] !== value)));
          if (Object.keys(changed).length) operations.push({ op: 'update', table: T.recipeIngredients, id: form.line.id, expectedRevision: form.line.revision, fields: changed });
        }
      });
      const kept = new Set(resolved.map((r) => r.form.line?.id).filter(Boolean));
      for (const line of existingLines) if (!kept.has(line.id)) operations.push(removeOp(T.recipeIngredients, line));

      for (const { machine, need, box, quantity } of machineForms) {
        const units = Math.max(1, Math.round(Number(quantity.value) || 1));
        if (box.checked && !need) operations.push({ op: 'insert', table: T.recipeEquipment, id: crypto.randomUUID(), fields: { recipe_id: recipeId, equipment_id: machine.id, quantity_required: units } });
        else if (!box.checked && need) operations.push(removeOp(T.recipeEquipment, need));
        else if (box.checked && need && need.quantity_required !== units) operations.push({ op: 'update', table: T.recipeEquipment, id: need.id, expectedRevision: need.revision, fields: { quantity_required: units } });
      }
      return { operations };
    }

    const save = el('button', { 'data-feedback-id': 'food.recetario.formulario.guardar', 'data-feedback-label': 'Guardar receta', class: 'primary', type: 'submit', id: 'saveRecipe', form: 'recipeForm' }, 'Guardar');
    const section = (mark: Mark, title: string, ...content: Array<HTMLElement | null>) => el('fieldset', { ...mark, class: 'formblock' }, el('legend', null, title), ...content);
    const form = el('form', { 'data-feedback-id': 'food.recetario.formulario', 'data-feedback-label': 'Formulario de receta', novalidate: true, id: 'recipeForm', oninput: () => { guard.dirtyEditor = true; }, onchange: () => { guard.dirtyEditor = true; },
      onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        const draft = build({});
        if (draft.problem) { error.textContent = draft.problem.message; draft.problem.focus?.focus(); return; }
        save.disabled = true;
        try {
          // La foto se deja en la cola de blobs solo cuando el resto del formulario es válido.
          const staged = newPhoto;
          const photo = staged
            ? await usage.run('food.recetario.foto', () => stagePhoto(client, staged))
            : removePhoto && recipe?.photo_file_id ? { photo_file_id: null, photo_thumb_file_id: null } : {};
          const { operations } = build(photo);
          if (operations.length === 0) { guard.dirtyEditor = false; await sheet?.close(true); return; }
          if (await commitSafely(operations, recipe ? 'Cambios guardados en este dispositivo.' : 'Receta creada en este dispositivo.', (send) => usage.run('food.recetario.guardar', send))) {
            guard.dirtyEditor = false;
            await sheet?.close(true);
          }
        } catch (e) {
          error.textContent = describeError(e);
        } finally {
          save.disabled = false;
        }
      } },
      section({ 'data-feedback-id': 'food.recetario.formulario.seccion_foto', 'data-feedback-label': 'Bloque Foto' }, 'Foto', photoBlock),
      section({ 'data-feedback-id': 'food.recetario.formulario.seccion_presentacion', 'data-feedback-label': 'Bloque Presentación' }, 'Presentación',
        field('Nombre', name), field('Categoría', category), field('Raciones base', servings, 'Las cantidades de los ingredientes se refieren a estas raciones.'),
        field('Nombre público', publicName, 'Como aparecerá en el menú del organizador. Si se deja vacío, se usa el nombre.'),
        field('Descripción pública', publicDescription)),
      section({ 'data-feedback-id': 'food.recetario.ingredientes', 'data-feedback-label': 'Bloque Ingredientes' }, 'Ingredientes', datalist, lineHost,
        el('button', { 'data-feedback-id': 'food.recetario.ingredientes.anadir', 'data-feedback-label': 'Añadir ingrediente', class: 'ghost', type: 'button', id: 'addIngredient', onclick: () => { addLine(null); lineForms.at(-1)?.name.focus(); } }, icon('plus', 18), 'Añadir ingrediente'),
        el('span', { class: 'hint' }, 'Si el ingrediente no existe, se crea al guardar.')),
      section({ 'data-feedback-id': 'food.recetario.formulario.seccion_cocina', 'data-feedback-label': 'Bloque Cocina' }, 'Cocina', field('Elaboración', method), field('Antelación (minutos antes del servicio)', prep), field('Conservación', conservation), freezable.node,
        field('Regeneración', regeneration), field('Notas de servicio', serviceNotes)),
      section({ 'data-feedback-id': 'food.recetario.formulario.seccion_seguridad', 'data-feedback-label': 'Bloque Seguridad' }, 'Seguridad',
        tags.element,
        checked.node, field('Estado', status, 'Para validarla hay que haber revisado los alérgenos.')),
      section({ 'data-feedback-id': 'food.recetario.formulario.seccion_maquinaria', 'data-feedback-label': 'Bloque Maquinaria' }, 'Maquinaria', machineForms.length ? el('div', { class: 'machinerows' }, ...machineForms.map((m) => m.node)) : el('p', { class: 'muted' }, 'Todavía no hay maquinaria dada de alta.')),
      error,
      recipe ? el('div', { class: 'zone' }, el('button', { 'data-feedback-id': 'food.recetario.formulario.papelera', 'data-feedback-label': 'Enviar receta a papelera', class: 'danger', type: 'button', id: 'deleteRecipe', onclick: () => void deleteRecipe(recipe) }, icon('trash', 18), 'Enviar a papelera')) : null,
    );

    sheet = openSheet({
      title: recipe ? 'Editar receta' : 'Nueva receta',
      meta: recipe ? `Revisión ${recipe.revision}${recipe._pending ? ' · pendiente de sincronizar' : ''}` : undefined,
      body: form,
      foot: [el('button', { 'data-feedback-id': 'food.recetario.formulario.cancelar', 'data-feedback-label': 'Cancelar edición', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), save],
      initialFocus: name,
      beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
      onClose: () => { guard.dirtyEditor = false; sheet = null; tags.destroy(); },
    });
    if (!recipe) addLine(null);
  }

  void load();
  void loadPurchases(client).then((next) => { purchases = next; });
  const offs = [T.recipes, T.ingredients, T.recipeIngredients, T.equipment, T.recipeEquipment].map((table) => client.onTable(table, () => void load()));
  const offStatus = client.onStatus(() => { if (!sheet) void load(); });
  return () => {
    offs.forEach((off) => off());
    offStatus();
    void closeSheet(true);
  };
};
