import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import {
  STATION_LABELS, retreatInContext,
  PREP_UNITS, allergenPresence, ingredientNeeds, needText, nextRecipeService, pendingConsumption, readableQuantity, serviceShares, stockText, weekdayLong,
  type Consumption, type IngredientNeed, type Menu, type MenuGraph, type MenuItem, type MenuService, crossContext, undeclaredAllergens, undeclaredText, type CrossContext, foodUnitFromBase, formatMethodSteps, ingredientKey, sharedIngredientItems, isQuickPending, lineCost, methodStepsFromText, prepFromParts, prepLabel, prepToParts, priceFor, validateOperations, type PrepUnit,
  type Allergen, type DietTag, type Equipment, type Ingredient, type Recipe, type RecipeEquipment, type RecipeIngredient, type ResourceItem, type Unit,
} from '@ikisai/domain-food';
import { closeSheet, confirmDialog, createFocus, createLabelPicker, el, formatDate, icon, listRow, openSheet, renderCover, replace, spaceFromRow, spacePath, toast, type Sheet } from '@ikisai/ui-kit';
import { cartaImageKey, loadCartaImages, recipeMedal } from './recipe-medal.ts';
import { guard } from '../app/guard.ts';
import {
  ALLERGENS, ALLERGEN_LABELS, CATEGORY_LABELS, DIET_LABELS, DIET_TAGS, EQUIPMENT_STATUS_LABELS, RECIPE_CATEGORIES, RECIPE_STATUSES, RECIPE_STATUS_LABELS,
  T, UNITS, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror,
} from '../app/client.ts';
import { loadPurchases, type PurchasesSnapshot } from '../app/purchases.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { loadInventory, type InventoryData } from '../app/consumption.ts';
import { todayKey } from '../app/events.ts';
import { isBlobMarker, photoUrl, preparePhoto, showPhoto, stagePhoto, type PhotoRef, type PreparedPhoto } from '../app/photos.ts';
import { usage } from '../app/usage.ts';
import { fb } from './feedback.ts';
import { createStepsEditor, methodStepsView } from './method-steps.ts';
import { SERVICE_LABELS } from './events.ts';
import type { ViewMount } from './shell.ts';

/** Par de atributos de «Sugerencias y QA» que los helpers de esta vista reciben ya escrito en literal. */
/** Marca de feedback y, en los campos que guardan datos, su declaración en el inventario (`data-field-*`, 0111). */
type Mark = { 'data-feedback-id': string; 'data-feedback-label': string; 'data-field-id'?: string; 'data-field-entity'?: string; 'data-field-prop'?: string };

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

/** Valor del filtro Estado para los platos rápidos por completar (no es un estado de la receta). */
const QUICK_FILTER = 'rapida';

/** Recetario visual: tarjetas con foto, ficha en lectura y edición por bloques (docs/food/API.md §9). */
export const mountRecipes: ViewMount = ({ main, client }) => {
  let recipes: RecipeRow[] = [];
  let ingredients: IngredientRow[] = [];
  let lines: LineRow[] = [];
  let equipment: EquipmentRow[] = [];
  let resourceItems: ResourceItem[] = [];
  let inventory: InventoryData | null = null; // R5: «En casa» de cada ingrediente en la ficha
  /** Ruta corta del espacio de una máquina («Cocina › Office»), si su artículo lo tiene. */
  const machinePlace = (machine: EquipmentRow): string | null => {
    const space = inventory?.items.find((i) => i.id === machine.item_id)?.default_space_id;
    if (!space || !inventory) return null;
    return spacePath(inventory.spaces.filter((s) => !s.deleted_at).map((s) => ({ ...spaceFromRow(s as never) })), space).split(' › ').slice(-2).join(' › ') || null;
  };
  let needs: NeedRow[] = [];
  // Bloque 2 (ficha B): los menús, para comparar con el próximo servicio de la receta, y el consumo sin descontar.
  let planning: { menus: Array<Mirror<Menu>>; services: Array<Mirror<MenuService>>; items: Array<Mirror<MenuItem>>; consumptions: Array<Mirror<Consumption>> } = { menus: [], services: [], items: [], consumptions: [] };
  let sheet: Sheet | null = null;
  let purchases: PurchasesSnapshot = { purchases: [], prices: new Map(), fetchedAt: null };
  const filter: { query: string; category: string; diet: string; allergen: string; allergenMode: 'lleva' | 'sin'; status: string } = { query: '', category: '', diet: '', allergen: '', allergenMode: 'lleva', status: '' };
  /** El cruce de siempre (`allergenPresence`, tanda 27): ingredientes y texto del plato, además de lo declarado. */
  let cross: CrossContext | null = null; // se rehace al cargar
  const presence = (recipe: RecipeRow, allergen: Allergen) => allergenPresence(recipe as unknown as Recipe, allergen,
    cross ??= crossContext({ recipe_ingredients: lines.filter((l) => !l.deleted_at) as RecipeIngredient[], ingredients: ingredients as Ingredient[] }));
  const canWrite = () => client.bootstrap()?.membership.role !== 'reader';
  const undeclared = (recipe: RecipeRow) => undeclaredAllergens(recipe as unknown as Recipe,
    cross ??= crossContext({ recipe_ingredients: lines.filter((l) => !l.deleted_at) as RecipeIngredient[], ingredients: ingredients as Ingredient[] }));
  /** Plato rápido (O3a) al que aún le faltan los alérgenos revisados o algún ingrediente. */
  const quickPending = (recipe: RecipeRow) => isQuickPending(recipe, lines);

  const select = (id: string, label: string, options: Array<[string, string]>, key: 'category' | 'diet' | 'allergen' | 'status', mark: Mark) => {
    const node = el('select', { 'data-field-none': '', ...mark, id, class: 'compact', 'aria-label': label, onchange: () => { filter[key] = node.value; paint(); } },
      el('option', { value: '' }, label), ...options.map(([value, name]) => el('option', { value }, name)));
    return node;
  };
  const allergenMode = el('select', { 'data-field-none': '', 'data-feedback-id': 'food.recetario.filtros.alergeno_modo', 'data-feedback-label': 'Lleva o sin el alérgeno', id: 'filterAllergenMode', class: 'compact', 'aria-label': 'Lleva o sin el alérgeno',
    onchange: () => { filter.allergenMode = allergenMode.value as 'lleva' | 'sin'; paint(); } },
    el('option', { value: 'lleva' }, 'Lleva'), el('option', { value: 'sin' }, 'Sin'));
  // Sin red (068 §6): de cuándo son los datos y qué necesita red; lo demás funciona.
  const offline = el('div', { 'data-feedback-id': 'food.recetario.sin_red', 'data-feedback-label': 'Sin conexión', class: 'banner warn notice fd-offline', id: 'recipesOffline', role: 'status', hidden: true });
  const search = el('input', { 'data-field-none': '', 'data-feedback-id': 'food.recetario.filtros.buscar', 'data-feedback-label': 'Buscar receta', type: 'search', id: 'recipeSearch', placeholder: 'Buscar receta', 'aria-label': 'Buscar recetas', autocomplete: 'off',
    oninput: () => { filter.query = search.value.trim().toLowerCase(); paint(); } });
  const grid = el('ul', { 'data-feedback-id': 'food.recetario.tarjetas', 'data-feedback-label': 'Recetas', class: 'recipegrid', id: 'recipeGrid', 'aria-label': 'Recetas' });
  const host = el('div');
  const empty = el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay recetas'), 'Crea la primera con «Nueva receta». La foto se puede hacer con el móvil, también sin conexión.');
  const emptyFiltered = el('div', { class: 'empty plain' }, 'Ninguna receta coincide con la búsqueda o los filtros.');
  const trashList = el('ul', { class: 'list', 'aria-label': 'Recetas en la papelera' });
  const trashLabel = el('summary', { 'data-feedback-id': 'food.recetario.papelera.abrir', 'data-feedback-label': 'Abrir papelera', class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera', el('span', { class: 'count' }, '0'));
  const trash = el('details', { 'data-feedback-id': 'food.recetario.papelera', 'data-feedback-label': 'Papelera', id: 'trash' }, trashLabel, trashList);
  const fab = el('button', { 'data-feedback-id': 'food.recetario.nueva', 'data-feedback-label': 'Nueva receta', class: 'fab', type: 'button', id: 'newRecipe', onclick: () => openEditor(null) }, icon('plus'), 'Nueva receta');

  // Filtros en una fila de chips (hallazgo F-REC-2, línea de Core del 27-10): «Filtrar» abre la hoja con los cuatro
  // selectores; cada filtro puesto sale como chip con su ×, y «Quitar filtros» los quita todos.
  const filtersBox =
    el('div', { 'data-feedback-id': 'food.recetario.filtros', 'data-feedback-label': 'Filtros', class: 'filters fd-filtersheet' },
      select('filterCategory', 'Categoría', RECIPE_CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]]), 'category', { 'data-feedback-id': 'food.recetario.filtros.categoria', 'data-feedback-label': 'Filtrar por categoría' }),
      select('filterDiet', 'Dieta', DIET_TAGS.map((d) => [d, DIET_LABELS[d]]), 'diet', { 'data-feedback-id': 'food.recetario.filtros.dieta', 'data-feedback-label': 'Filtrar por dieta' }),
      // Tanda 27 (010 y regla de VG): «Filtrar por alérgeno», con «Lleva X» (lo de siempre) y «Sin X»; nunca «apto».
      select('filterAllergen', 'Filtrar por alérgeno', ALLERGENS.map((a) => [a, ALLERGEN_LABELS[a]]), 'allergen', { 'data-feedback-id': 'food.recetario.filtros.alergeno', 'data-feedback-label': 'Filtrar por alérgeno' }),
      allergenMode,
      select('filterStatus', 'Estado', [...RECIPE_STATUSES.map((s): [string, string] => [s, RECIPE_STATUS_LABELS[s]]), [QUICK_FILTER, 'Rápidas por completar']], 'status', { 'data-feedback-id': 'food.recetario.filtros.estado', 'data-feedback-label': 'Filtrar por estado' }),
    );
  const filterBar = el('div', { 'data-feedback-id': 'food.recetario.filtros.fila', 'data-feedback-label': 'Filtros puestos', class: 'chips fd-filterbar', id: 'recipeFilters' });
  let filterSheet: Sheet | null = null;
  const FILTER_NAMES: Record<'category' | 'diet' | 'allergen' | 'status', string> = { category: 'Categoría', diet: 'Dieta', allergen: 'Alérgeno', status: 'Estado' };
  const selectOf = (key: keyof typeof FILTER_NAMES) => filtersBox.querySelector<HTMLSelectElement>(`#${{ category: 'filterCategory', diet: 'filterDiet', allergen: 'filterAllergen', status: 'filterStatus' }[key]}`)!;
  const clearFilter = (key: keyof typeof FILTER_NAMES) => { filter[key] = ''; selectOf(key).value = ''; if (key === 'allergen') { filter.allergenMode = 'lleva'; allergenMode.value = 'lleva'; } paint(); };
  function paintFilterBar(shown: number): void {
    const active = (Object.keys(FILTER_NAMES) as Array<keyof typeof FILTER_NAMES>).filter((k) => filter[k]);
    const text = (k: keyof typeof FILTER_NAMES) => {
      const option = selectOf(k).selectedOptions[0]?.textContent ?? filter[k];
      return k === 'allergen' ? `${filter.allergenMode === 'sin' ? 'Sin' : 'Lleva'} ${option.toLowerCase()}` : `${FILTER_NAMES[k]}: ${option}`;
    };
    replace(filterBar,
      el('button', { 'data-feedback-id': 'food.recetario.filtros.abrir', 'data-feedback-label': 'Filtrar', class: active.length ? 'filterchip on' : 'filterchip', type: 'button', id: 'openFilters',
        'aria-haspopup': 'dialog', onclick: () => openFilters() }, icon('filter', 16), active.length ? `Filtrar · ${active.length}` : 'Filtrar'),
      ...active.map((k) => el('button', { 'data-feedback-id': 'food.recetario.filtros.quitar_uno', 'data-feedback-label': 'Quitar este filtro', class: 'filterchip on', type: 'button', 'data-filter': k,
        'aria-label': `Quitar el filtro ${text(k)}`, onclick: () => clearFilter(k) }, text(k), ' ×')),
      active.length > 1 ? el('button', { 'data-feedback-id': 'food.recetario.filtros.quitar', 'data-feedback-label': 'Quitar filtros', class: 'linkbtn', type: 'button', id: 'clearFilters',
        onclick: () => { for (const k of active) { filter[k] = ''; selectOf(k).value = ''; } filter.allergenMode = 'lleva'; allergenMode.value = 'lleva'; paint(); } }, 'Quitar filtros') : null);
    const done = filterSheet?.foot?.querySelector<HTMLButtonElement>('#filtersDone');
    if (done) done.textContent = shown === 1 ? 'Ver 1 receta' : `Ver ${shown} recetas`;
  }
  function openFilters(): void {
    filterSheet = openSheet({
      title: 'Filtrar recetas',
      body: filtersBox,
      foot: el('button', { 'data-feedback-id': 'food.recetario.filtros.ver', 'data-feedback-label': 'Ver las recetas', class: 'primary', type: 'button', id: 'filtersDone', onclick: () => void filterSheet?.close() }, 'Ver las recetas'),
      onClose: () => { filterSheet = null; },
    });
    paint();
  }

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Recetario'), el('p', null, 'Las recetas de la casa, con su foto, sus ingredientes y sus alérgenos.'))),
    offline,
    el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)),
    filterBar,
    host,
    trash,
    fab,
  );

  function matches(recipe: RecipeRow): boolean {
    if (filter.query && !`${recipe.name} ${recipe.public_name ?? ''}`.toLowerCase().includes(filter.query)) return false;
    if (filter.category && recipe.category !== filter.category) return false;
    if (filter.diet && !recipe.diet_tags.includes(filter.diet as DietTag)) return false;
    // «Lleva X»: lo declara o lo nombran sus ingredientes o su texto. «Sin X»: el resto; lo no revisado sale marcado.
    if (filter.allergen && (presence(recipe, filter.allergen as Allergen) === 'lleva') !== (filter.allergenMode === 'lleva')) return false;
    if (filter.status === QUICK_FILTER) return recipe.status !== 'archivada' && quickPending(recipe);
    if (filter.status ? recipe.status !== filter.status : recipe.status === 'archivada') return false; // las archivadas solo salen si se piden
    return true;
  }

  function card(recipe: RecipeRow): HTMLElement {
    const img = el('img', { alt: '', loading: 'lazy', hidden: true });
    showPhoto(client, img, recipe.photo_thumb_file_id ?? recipe.photo_file_id);
    const chips = [
      recipe.status !== 'validada' ? el('span', { class: recipe.status === 'archivada' ? 'chip trash' : 'chip' }, RECIPE_STATUS_LABELS[recipe.status]) : null,
      quickPending(recipe) ? el('span', { class: 'chip warn quickchip' }, 'Rápida · por completar') : null,
      // Sus ingredientes o su texto nombran un alérgeno que no declara (hallazgo F-REC-5): también en la lista, no solo en la ficha.
      undeclared(recipe).length ? el('span', { class: 'chip alert fd-undeclared-chip' }, 'Alérgeno sin declarar') : null,
      recipe._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null,
      filter.allergen && filter.allergenMode === 'sin' && presence(recipe, filter.allergen as Allergen) === 'sin_revisar' ? el('span', { class: 'chip warn fd-unreviewed' }, 'Alérgenos sin revisar') : null,
    ];
    // Sin red, la foto que no se ha abierto antes en este dispositivo lo dice.
    const missing = el('span', { class: 'fd-nophoto', hidden: true }, 'Foto sin descargar');
    const ref = recipe.photo_thumb_file_id ?? recipe.photo_file_id;
    if (ref && !navigator.onLine) void photoUrl(client, ref).then((url) => { if (!url) missing.hidden = false; });
    return el('li', null,
      el('button', { 'data-feedback-id': 'food.recetario.tarjetas.tarjeta', 'data-feedback-label': 'Tarjeta de receta', class: 'recipecard', type: 'button', 'data-id': recipe.id, 'data-pending': String(recipe._pending === true), 'aria-label': `Abrir ${recipe.name}`, onclick: () => openCard(recipe) },
        el('span', { class: 'recipephoto' }, recipeMedal(recipe), img, missing),
        el('span', { class: 'recipebody' }, el('strong', { title: recipe.name }, recipe.name), el('span', { class: 'recipemeta' }, tagLine(recipe)), el('span', { class: 'chips' }, ...chips)),
      ));
  }

  function paint(): void {
    const sorted = [...recipes].sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const live = sorted.filter((r) => !r.deleted_at);
    const deleted = sorted.filter((r) => r.deleted_at);
    const visible = live.filter(matches);
    paintFilterBar(visible.length);
    // Arriba, las recetas del retiro en curso o del próximo (hallazgo F-REC-4, línea de Core del 27-10); debajo, el resto.
    // Solo con un retiro en contexto que tenga alguna a la vista; dentro de cada grupo, por orden alfabético.
    const retreat = retreatInContext(planning.menus, planning.services, planning.items, todayKey());
    const inRetreat = retreat ? visible.filter((r) => retreat.recipeIds.has(r.id)) : [];
    const rest = visible.filter((r) => !inRetreat.includes(r));
    const groupLabel = (text: string, id: string) => el('li', { class: 'sectionlabel fd-gridlabel', id, role: 'presentation' }, text);
    replace(grid, ...(inRetreat.length
      ? [groupLabel(retreat!.inCourse ? 'En este retiro' : 'En el próximo retiro', 'recipesRetreat'), ...inRetreat.map(card),
        rest.length ? groupLabel('Las demás', 'recipesRest') : null, ...rest.map(card)]
      : visible.map(card)));
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
    // Ingredientes de Recursos que Food aún no usa (R5a): se sugieren para no duplicar artículos.
    const stock = loadInventory(client).then((next) => { inventory = next; }).catch(() => undefined);
    void (resourcesClient(client).list(R.items) as unknown as Promise<Array<Mirror<ResourceItem>>>).then((rows) => { resourceItems = rows.filter((i) => !i._pending); }).catch(() => undefined);
    const plans = Promise.all([
      client.list(T.menus) as Promise<Array<Mirror<Menu>>>, client.list(T.menuServices) as Promise<Array<Mirror<MenuService>>>,
      client.list(T.menuItems) as Promise<Array<Mirror<MenuItem>>>, client.list(T.consumptions) as Promise<Array<Mirror<Consumption>>>,
    ]).then(([menus, services, items, consumptions]) => { planning = { menus, services, items, consumptions }; if (recipes.length) paint(); }).catch(() => undefined);
    // La ficha que se abre antes de que lleguen el inventario y los menús se repinta al llegar (no se queda sin cifras).
    void Promise.all([stock, plans]).then(refreshCard);
    [recipes, ingredients, lines, equipment, needs] = await Promise.all([
      client.list(T.recipes, { includeDeleted: true }) as Promise<RecipeRow[]>,
      client.list(T.ingredients) as Promise<IngredientRow[]>,
      client.list(T.recipeIngredients, { includeDeleted: true }) as Promise<LineRow[]>,
      client.list(T.equipment) as Promise<EquipmentRow[]>,
      client.list(T.recipeEquipment, { includeDeleted: true }) as Promise<NeedRow[]>,
      // La imagen de la carta de cada receta (los montaditos): su medallón la usa si no tiene foto propia.
      loadCartaImages(client).catch(() => undefined),
    ]);
    cross = null;
    paint();
    // `#/recetario?receta=<id>` (p. ej. desde «Completar en el Recetario» de un menú) abre esa receta una vez.
    const wanted = new URLSearchParams(location.hash.split('?')[1] ?? '').get('receta');
    if (wanted && !openedFromLink && !sheet) {
      openedFromLink = true;
      const recipe = recipes.find((r) => r.id === wanted && !r.deleted_at);
      if (recipe) openCard(recipe);
    }
  }
  let openedFromLink = false;
  /** La ficha en lectura abierta, para repintarla cuando cambian el stock o los menús. */
  let shownCard: { recipe: RecipeRow; sheet: Sheet } | null = null;
  function refreshCard(): void {
    if (!shownCard || sheet !== shownCard.sheet || !shownCard.sheet.isOpen()) return;
    const fresh = recipes.find((r) => r.id === shownCard!.recipe.id) ?? shownCard.recipe;
    replace(shownCard.sheet.body, cardBody(fresh));
  }

  const linesOf = (recipeId: string) => lines.filter((l) => l.recipe_id === recipeId && !l.deleted_at).sort((a, b) => Number(a.position) - Number(b.position));
  const needsOf = (recipeId: string) => needs.filter((n) => n.recipe_id === recipeId && !n.deleted_at);

  /** `track` envuelve el envío para medir el uso (p. ej. `usage.run` al guardar); el error sigue llegando al `catch`. */
  /** La imagen de la carta, como foto de la receta: la baja food-api de Flow y se sube como cualquier foto. */
  async function saveCartaPhoto(recipe: RecipeRow, button: HTMLButtonElement): Promise<void> {
    const key = cartaImageKey(recipe.id);
    if (!key) return;
    button.disabled = true;
    try {
      const out = await client.api<{ contentType: string; data: string }>(`/carta/image?key=${encodeURIComponent(key)}`);
      const bytes = Uint8Array.from(atob(out.data), (ch) => ch.charCodeAt(0));
      const prepared = await preparePhoto(new Blob([bytes], { type: out.contentType }));
      const photo = await usage.run('food.recetario.foto', () => stagePhoto(client, prepared));
      if (await commitSafely([{ op: 'update', table: T.recipes, id: recipe.id, expectedRevision: recipe.revision, fields: photo }], 'Foto guardada en la receta.')) await sheet?.close(true);
    } catch (error) {
      toast(`No se ha podido guardar la foto: ${describeError(error)}`);
    } finally {
      button.disabled = false;
    }
  }

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
    const opened = openSheet({
      title: recipe.name,
      meta: `Revisión ${recipe.revision} · actualizada ${formatDate(recipe.updated_at)}`,
      body: cardBody(recipe),
      foot: canWrite()
        ? [el('button', { 'data-feedback-id': 'food.recetario.ficha.cerrar', 'data-feedback-label': 'Cerrar ficha', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cerrar'), el('button', { 'data-feedback-id': 'food.recetario.ficha.editar', 'data-feedback-label': 'Editar receta', class: 'primary', type: 'button', id: 'editRecipe', onclick: () => openEditor(recipe) }, 'Editar')]
        : [el('button', { 'data-feedback-id': 'food.recetario.ficha.cerrar', 'data-feedback-label': 'Cerrar ficha', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cerrar')],
      onClose: () => { sheet = null; shownCard = null; },
    });
    sheet = opened;
    shownCard = { recipe, sheet: opened };
  }

  /** El cuerpo de la ficha con los datos de ahora (se rehace cuando llegan el inventario y los menús). */
  function cardBody(recipe: RecipeRow): HTMLElement {
    const names = new Map(ingredients.map((i) => [i.id, i.name]));
    const machines = new Map(equipment.map((e) => [e.id, e]));
    const block = (mark: Mark, title: string, ...content: Array<HTMLElement | null>) => (content.some(Boolean) ? el('section', { ...mark, class: 'ficha-block' }, el('h4', null, title), ...content) : null);
    const para = (label: string, value: string | null) => (value ? el('p', null, el('strong', null, `${label}: `), value) : null);
    const recipeLines = linesOf(recipe.id);
    const recipeNeeds = needsOf(recipe.id);
    // Bloque 2 (ficha B «Portada y foco», MUELA-077 §2 con PERDIDAS §1 y §2): se compara con las raciones del próximo
    // servicio en que sale la receta (solo esta receta); si no sale en ninguno, con las de la receta, y lo dice.
    const now = new Date();
    const next = nextRecipeService(recipe.id, planning, now);
    const servings = next?.servings ?? Number(recipe.base_servings);
    const tracked = !!inventory?.kitchen.size;
    const graph: MenuGraph = { services: planning.services, items: planning.items, recipes: recipes as unknown as Recipe[], recipe_ingredients: lines.filter((l) => !l.deleted_at), ingredients };
    const ingredientRows: IngredientNeed[] = ingredientNeeds({
      lines: recipeLines, ingredients, baseServings: Number(recipe.base_servings), servings, today: todayKey(),
      stock: tracked && inventory ? inventory : null,
      shares: next ? serviceShares(next.service.id, recipe.id, graph) : undefined,
      pending: tracked && inventory ? pendingConsumption(graph, planning.consumptions, inventory.movements, now) : undefined,
    });
    const followed = ingredientRows.filter((n) => n.state !== 'sin_seguimiento');
    const short = followed.filter((n) => n.state === 'faltan' || n.state === 'no_hay');
    const low = followed.filter((n) => n.low);
    const forText = next ? `Para el ${weekdayLong(next.service.service_date)}, ${SERVICE_LABELS[next.service.service_type].toLowerCase()} · ${formatQuantity(servings)} raciones` : `${formatQuantity(servings)} raciones base`;
    // Tanda 27 (Bloque 2, B «Portada y foco»): la portada del kit con la foto, el estado y las cifras de la receta.
    // Sin revisar, la portada lo dice (nunca «apto» ni «sin X»).
    const coverOf = (image: string | null) => renderCover({
      title: recipe.name, image, compact: true,
      pill: recipe.allergens_checked ? RECIPE_STATUS_LABELS[recipe.status] : 'Alérgenos sin revisar',
      pillTone: !recipe.allergens_checked ? 'alert' : recipe.status === 'validada' ? 'ok' : recipe.status === 'archivada' ? null : 'warn',
      stats: [forText,
        tracked && followed.length ? `${followed.length - short.length}/${followed.length} en casa` : `${recipeLines.length} ${recipeLines.length === 1 ? 'ingrediente' : 'ingredientes'}`,
        tracked && followed.length ? `${short.length} ${short.length === 1 ? 'falta' : 'faltan'}` : null,
        tracked && low.length ? `${low.length} bajo mínimo` : null,
        tracked ? null : prepLabel(recipe.prep_minutes)].filter(Boolean).join(' · '),
    });
    /** Ir a la ficha del artículo en la Despensa. */
    const toPantry = (itemId: string) => { void sheet?.close(true); location.hash = `#/despensa?articulo=${itemId}`; };
    // Foco: solo lo que falta o está bajo mínimo, de uno en uno.
    const focusItems = ingredientRows.filter((n) => n.itemId && (n.state === 'faltan' || n.state === 'no_hay' || n.low)).map((n) => ({
      id: n.itemId!, title: n.name,
      kicker: n.state === 'no_hay' ? 'No hay en casa' : n.state === 'faltan' ? 'Falta' : 'Bajo mínimo',
      tone: n.state === 'faltan' || n.state === 'no_hay' ? 'alert' as const : 'warn' as const,
      note: needText(n),
      meta: [`Hace falta ${readableQuantity(n.need, n.unit)}`, stockText(n) ? `en casa ${stockText(n)}` : null].filter((x): x is string => !!x),
    }));
    const focus = tracked && focusItems.length ? createFocus({
      label: 'Lo que falta para esta receta', items: focusItems, feedbackId: 'food.recetario.ficha.foco',
      onOpen: (item) => toPantry(item.id), openLabel: 'Ver en la Despensa',
    }) : null;
    const coverHost = el('div', { 'data-feedback-id': 'food.recetario.ficha.foto', 'data-feedback-label': 'Portada de la receta', class: 'ficha-photo fd-cover', 'data-photo': recipe.photo_file_id ? 'loading' : 'none' }, coverOf(null));
    if (recipe.photo_file_id) void photoUrl(client, recipe.photo_file_id).then((url) => {
      coverHost.dataset.photo = url ? 'ready' : 'missing';
      if (url) replace(coverHost, coverOf(url));
      else if (!navigator.onLine) coverHost.append(el('span', { class: 'fd-nophoto' }, 'Foto sin descargar'));
    });
    const recipeServings = formatQuantity(recipe.base_servings);
    const body = el('div', { 'data-feedback-id': 'food.recetario.ficha', 'data-feedback-label': 'Ficha de receta', class: 'ficha' },
      quickPending(recipe) ? el('div', { 'data-feedback-id': 'food.recetario.ficha.rapida', 'data-feedback-label': 'Plato rápido por completar', class: 'banner warn notice', id: 'quickNotice', role: 'status' },
        el('div', null, el('strong', null, 'Plato rápido.'), ' Complétalo (alérgenos e ingredientes) para usarlo en un retiro.'),
        canWrite() ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.recetario.ficha.completar', 'data-feedback-label': 'Completar plato rápido', class: 'ghost', type: 'button', id: 'completeQuick', onclick: () => openEditor(recipe) }, 'Completar')) : null) : null,
      coverHost,
      // La imagen solo está en la carta (VG, 28-10): si la carta cambia o se borra, se pierde. Un toque la guarda en la receta.
      !recipe.photo_file_id && cartaImageKey(recipe.id) ? el('div', { 'data-feedback-id': 'food.recetario.ficha.foto_carta', 'data-feedback-label': 'Imagen solo en la carta', class: 'banner warn notice', id: 'cartaPhotoNotice', role: 'note' },
        el('div', null, el('strong', null, 'La imagen solo está en la carta.'), ' La receta no tiene foto: si la carta cambia, se pierde.'),
        canWrite() ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.recetario.ficha.foto_carta_guardar', 'data-feedback-label': 'Guardar como foto de la receta', class: 'ghost', type: 'button', id: 'saveCartaPhoto',
          onclick: (e: Event) => void saveCartaPhoto(recipe, e.currentTarget as HTMLButtonElement) }, 'Guardar como foto de la receta')) : null) : null,
      // El nombre público solo se repite si es distinto del interno.
      (recipe.public_name && recipe.public_name.trim() !== recipe.name.trim()) || recipe.public_description
        ? el('div', { 'data-feedback-id': 'food.recetario.ficha.presentacion', 'data-feedback-label': 'Presentación pública', class: 'ficha-public' }, recipe.public_name && recipe.public_name.trim() !== recipe.name.trim() ? el('strong', null, recipe.public_name) : null, recipe.public_description ? el('p', null, recipe.public_description) : null)
        : null,
      el('p', { class: 'recipemeta' }, `${tagLine(recipe)} · ${formatQuantity(recipe.base_servings)} raciones base`),
      el('div', { class: 'chips' },
        el('span', { class: recipe.status === 'validada' ? 'chip ok' : 'chip' }, RECIPE_STATUS_LABELS[recipe.status]),
        recipe._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null),
      block({ 'data-feedback-id': 'food.recetario.ficha.seguridad', 'data-feedback-label': 'Seguridad' }, 'Seguridad',
        // Los ingredientes o el texto del plato nombran un alérgeno que la receta no declara (decisión de Core Sevilla,
        // 20-10-2026; MUELA-086): aviso claro y a corregir.
        ...undeclaredAllergens(recipe as unknown as Recipe, crossContext({ recipe_ingredients: lines.filter((l) => !l.deleted_at) as RecipeIngredient[], ingredients: ingredients as Ingredient[] }))
          .map((u) => el('div', { 'data-feedback-id': 'food.recetario.ficha.sin_declarar', 'data-feedback-label': 'Alérgeno posible sin declarar', class: 'banner warn notice fd-undeclared', role: 'status' },
            el('div', null, undeclaredText(u)),
            canWrite() ? el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.recetario.ficha.sin_declarar.revisar', 'data-feedback-label': 'Revisar los alérgenos', class: 'ghost', type: 'button', onclick: () => openEditor(recipe) }, 'Revisar los alérgenos')) : null)),
        el('p', null, el('strong', null, 'Alérgenos: '), recipe.allergens.length ? recipe.allergens.map((a) => ALLERGEN_LABELS[a]).join(', ') : 'ninguno declarado'),
        recipe.allergens_checked ? el('p', { class: 'muted' }, 'Alérgenos revisados.') : el('p', null, el('span', { class: 'chip alert' }, 'Alérgenos sin revisar'))),
      focus ? el('section', { class: 'ficha-block fd-focus' }, el('h4', null, 'Lo que falta'), focus.element) : null,
      block({ 'data-feedback-id': 'food.recetario.ficha.ingredientes', 'data-feedback-label': 'Ingredientes' }, 'Ingredientes', recipeLines.length
        ? el('table', { class: 'ingredients' },
          el('caption', { class: 'fd-caption' }, next
            ? `Hace falta para ${formatQuantity(servings)} raciones (${weekdayLong(next.service.service_date)}) · debajo, lo que dice la receta${tracked ? ' · y lo que hay en casa' : ''}`
            : `Hace falta, a las ${recipeServings} raciones de la receta: no sale en ningún menú que venga${tracked ? ' · y lo que hay en casa' : ''}`),
          el('tbody', null, ...ingredientRows.map((n, index) => {
            const line = recipeLines[index]!;
            const stock = stockText(n);
            const scaled = next && servings !== Number(recipe.base_servings);
            // La fila entera lleva a su ficha en la Despensa (≥ 52 px); el enlace queda para el teclado y el lector.
            return el('tr', { class: n.itemId ? 'fd-needrow' : '', 'data-state': tracked ? n.state : null, onclick: n.itemId ? (e: Event) => { if (!(e.target as HTMLElement).closest('a')) toPantry(n.itemId!); } : null },
              el('td', null, names.get(line.ingredient_id) ?? '—',
                n.itemId && n.state !== 'sin_seguimiento'
                  ? el('a', { 'data-feedback-id': 'food.recetario.ficha.en_casa', 'data-feedback-label': 'Ver en la despensa', class: 'consumewhy athome', href: `#/despensa?articulo=${n.itemId}`,
                      onclick: (e: Event) => { e.preventDefault(); toPantry(n.itemId!); } }, n.state === 'no_hay' || !stock ? 'Ver en la despensa' : `En casa: ${stock}`)
                  : null,
                tracked ? el('span', { class: `fd-needstate fd-need-${n.state}` }, needText(n)) : null),
              el('td', { class: 'num fd-needqty' },
                el('strong', null, readableQuantity(scaled ? n.need : Number(line.quantity), line.unit)),
                scaled ? el('span', { class: 'fd-recipeqty' }, `Receta, ${recipeServings} raciones: ${formatQuantity(line.quantity)} ${UNIT_LABELS[line.unit]}`) : null));
          })))
        : el('p', { class: 'muted' }, 'Sin ingredientes todavía.'),
        recipeCostLine(recipe, recipeLines),
        // Tanda 27 (Bloque 2, B; regla de VG): el coste de cada ingrediente se conserva, plegado bajo el total.
        purchases.fetchedAt && recipeLines.length ? el('details', { 'data-feedback-id': 'food.recetario.ficha.coste_lineas', 'data-feedback-label': 'Ver coste por ingrediente', class: 'fd-costfold' },
          el('summary', null, 'Ver coste por ingrediente'),
          el('table', { class: 'fd-costlines' }, el('tbody', null, ...recipeLines.map((l) => {
            const cost = lineCost(l.ingredient_id, Number(l.quantity), l.unit, purchases.prices);
            const price = priceFor(l.ingredient_id, l.unit, purchases.prices);
            return el('tr', null, el('td', null, names.get(l.ingredient_id) ?? '—'),
              el('td', { class: cost === null ? 'num muted' : price?.stale ? 'num warnline' : 'num', title: price?.stale ? `Precio de la última compra (${price.lastDate ?? 'sin fecha'}), de hace más de 3 meses` : null },
                cost === null ? 'sin precio' : `${euros(cost)}${price?.stale ? ' *' : ''}`));
          })))) : null),
      block({ 'data-feedback-id': 'food.recetario.ficha.elaboracion', 'data-feedback-label': 'Elaboración' }, 'Elaboración', methodStepsView(recipe), para('Antelación', prepLabel(recipe.prep_minutes))),
      block({ 'data-feedback-id': 'food.recetario.ficha.maquinaria', 'data-feedback-label': 'Maquinaria' }, 'Maquinaria', recipeNeeds.length ? el('ul', { class: 'plainlist' }, ...recipeNeeds.map((n) => {
        const machine = machines.get(n.equipment_id);
        const short = machine && n.quantity_required > machine.quantity ? ` · hacen falta ${n.quantity_required} y hay ${machine.quantity}` : '';
        const down = machine && (machine.status === 'averiado' || machine.status === 'fuera_de_servicio') ? ` · ${EQUIPMENT_STATUS_LABELS[machine.status].toLowerCase()}` : '';
        return el('li', { class: short || down ? 'warnline' : '' }, `${n.quantity_required} × ${machine?.name ?? 'máquina retirada'}${short}${down}`);
      })) : null),
      block({ 'data-feedback-id': 'food.recetario.ficha.conservacion', 'data-feedback-label': 'Conservación y servicio' }, 'Conservación y servicio', para('Conservación', recipe.conservation), recipe.freezable ? el('p', null, 'Se puede congelar.') : null, para('Regeneración', recipe.regeneration), para('Servicio', recipe.service_notes)),
    );

    return body;
  }

  // --- Edición por bloques --------------------------------------------------------------
  function openEditor(recipe: RecipeRow | null): void {
    const recipeId = recipe?.id ?? crypto.randomUUID();
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
    // Ayudantes: el campo lo declara quien llama (@field-caller).
    const input = (id: string, value: string | null, attrs: Record<string, unknown> = {}) => el('input', { id, type: 'text', value: value ?? '', ...attrs });
    // @field-caller
    const area = (id: string, value: string | null, rows: number, mark: Mark) => { const node = el('textarea', { ...mark, id, rows: String(rows) }); node.value = value ?? ''; return node; };
    const field = (label: string, control: HTMLElement, hint?: string) => el('label', { class: 'field' }, el('span', null, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
    // @field-caller
    const check = (id: string, label: string, checked: boolean, mark: Mark) => { const box = el('input', { ...mark, id, type: 'checkbox', checked }); return { box, node: el('label', { class: 'checkline' }, box, el('span', null, label)) }; };

    // Foto
    let newPhoto: PreparedPhoto | null = null;
    let removePhoto = false;
    const preview = el('img', { alt: 'Foto de la receta', hidden: true });
    if (recipe?.photo_file_id) showPhoto(client, preview, recipe.photo_file_id);
    const fileInput = el('input', { 'data-field-id': 'food.recetario.foto.archivo', 'data-field-entity': 'food.recipes', 'data-field-prop': 'photo_file_id', 'data-feedback-id': 'food.recetario.foto.archivo', 'data-feedback-label': 'Archivo de foto', id: 'r-photo', type: 'file', accept: 'image/*', class: 'visually-hidden',
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
    const name = input('r-name', recipe?.name ?? '', { 'data-field-id': 'food.recetario.formulario.nombre', 'data-field-entity': 'food.recipes', 'data-field-prop': 'name', 'data-feedback-id': 'food.recetario.formulario.nombre', 'data-feedback-label': 'Nombre', required: true, maxlength: '160' });
    const publicName = input('r-public-name', recipe?.public_name ?? null, { 'data-field-id': 'food.recetario.formulario.nombre_publico', 'data-field-entity': 'food.recipes', 'data-field-prop': 'public_name', 'data-feedback-id': 'food.recetario.formulario.nombre_publico', 'data-feedback-label': 'Nombre público', maxlength: '160' });
    const publicDescription = area('r-public-description', recipe?.public_description ?? null, 2, { 'data-field-id': 'food.recetario.formulario.descripcion_publica', 'data-field-entity': 'food.recipes', 'data-field-prop': 'public_description', 'data-feedback-id': 'food.recetario.formulario.descripcion_publica', 'data-feedback-label': 'Descripción pública' });
    const category = el('select', { 'data-field-id': 'food.recetario.formulario.categoria', 'data-field-entity': 'food.recipes', 'data-field-prop': 'category', 'data-feedback-id': 'food.recetario.formulario.categoria', 'data-feedback-label': 'Categoría', id: 'r-category' }, ...RECIPE_CATEGORIES.map((c) => el('option', { value: c, selected: (recipe?.category ?? 'principal') === c }, CATEGORY_LABELS[c])));
    const servings = input('r-servings', recipe ? formatQuantity(recipe.base_servings) : '', { 'data-field-id': 'food.recetario.formulario.raciones', 'data-field-entity': 'food.recipes', 'data-field-prop': 'base_servings', 'data-feedback-id': 'food.recetario.formulario.raciones', 'data-feedback-label': 'Raciones base', inputmode: 'decimal', required: true });
    // Elaboración por pasos; una receta con solo `method` (texto libre) se convierte a pasos sin perder nada.
    const method = createStepsEditor(
      recipe ? (Array.isArray(recipe.method_steps) && recipe.method_steps.length ? recipe.method_steps : methodStepsFromText(recipe.method)) : [],
      () => { guard.dirtyEditor = true; });

    // Antelación: sin indicar, en el momento (0) o número + unidad antes del servicio.
    const prepParts = prepToParts(recipe?.prep_minutes);
    const prepMode = el('select', { 'data-field-id': 'food.recetario.formulario.antelacion_modo', 'data-field-entity': 'food.recipes', 'data-field-prop': 'prep_minutes', 'data-feedback-id': 'food.recetario.formulario.antelacion_modo', 'data-feedback-label': 'Tipo de antelación', id: 'r-prep-mode', 'aria-label': 'Antelación',
      onchange: () => { paintPrep(); if (prepMode.value === 'antes') prep.focus(); } },
    ...([['sin', 'Sin indicar'], ['momento', 'En el momento'], ['antes', 'Antes del servicio']] as const).map(([value, label]) => el('option', { value, selected: prepParts.mode === value }, label)));
    const prep = input('r-prep', prepParts.amount != null ? formatQuantity(prepParts.amount) : '', { 'data-field-id': 'food.recetario.formulario.antelacion', 'data-field-entity': 'food.recipes', 'data-field-prop': 'prep_minutes', 'data-feedback-id': 'food.recetario.formulario.antelacion', 'data-feedback-label': 'Antelación', inputmode: 'decimal', 'aria-label': 'Tiempo de antelación', placeholder: 'Ej.: 2', class: 'compact' });
    const PREP_UNIT_LABELS: Record<PrepUnit, string> = { minutos: 'minutos', horas: 'horas', dias: 'días' };
    const prepUnit = el('select', { 'data-field-id': 'food.recetario.formulario.antelacion_unidad', 'data-field-entity': 'food.recipes', 'data-field-prop': 'prep_minutes', 'data-feedback-id': 'food.recetario.formulario.antelacion_unidad', 'data-feedback-label': 'Unidad de antelación', id: 'r-prep-unit', 'aria-label': 'Unidad de antelación', class: 'compact' },
      ...PREP_UNITS.map((u) => el('option', { value: u, selected: prepParts.unit === u }, PREP_UNIT_LABELS[u])));
    const prepAmount = el('span', { class: 'prepamount' }, prep, prepUnit, el('span', { class: 'muted' }, 'antes'));
    const paintPrep = () => { prepAmount.hidden = prepMode.value !== 'antes'; };
    paintPrep();
    const prepField = el('div', { class: 'field' }, el('span', null, 'Antelación'), el('div', { class: 'prepline' }, prepMode, prepAmount),
      el('span', { class: 'hint' }, 'Cuánto antes del servicio se prepara (hasta 7 días).'));
    const conservation = area('r-conservation', recipe?.conservation ?? null, 2, { 'data-field-id': 'food.recetario.formulario.conservacion', 'data-field-entity': 'food.recipes', 'data-field-prop': 'conservation', 'data-feedback-id': 'food.recetario.formulario.conservacion', 'data-feedback-label': 'Conservación' });
    const freezable = check('r-freezable', 'Se puede congelar', recipe?.freezable ?? false, { 'data-field-id': 'food.recetario.formulario.congelable', 'data-field-entity': 'food.recipes', 'data-field-prop': 'freezable', 'data-feedback-id': 'food.recetario.formulario.congelable', 'data-feedback-label': 'Se puede congelar' });
    const regeneration = area('r-regeneration', recipe?.regeneration ?? null, 2, { 'data-field-id': 'food.recetario.formulario.regeneracion', 'data-field-entity': 'food.recipes', 'data-field-prop': 'regeneration', 'data-feedback-id': 'food.recetario.formulario.regeneracion', 'data-feedback-label': 'Regeneración' });
    const serviceNotes = area('r-service', recipe?.service_notes ?? null, 2, { 'data-field-id': 'food.recetario.formulario.notas_servicio', 'data-field-entity': 'food.recipes', 'data-field-prop': 'service_notes', 'data-feedback-id': 'food.recetario.formulario.notas_servicio', 'data-feedback-label': 'Notas de servicio' });

    // Seguridad
    // Dietas y alérgenos con el selector de etiquetas del kit: dos familias, chips conmutables y resumen arriba.
    const tags = createLabelPicker({
      label: 'Dietas y alérgenos',
      // Guarda dos columnas (diet_tags y allergens); se declara la de seguridad.
      field: { id: 'food.recetario.formulario.alergenos', entity: 'food.recipes', prop: 'allergens' },
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
    // Lo que delatan sus ingredientes guardados y su texto y no está marcado (hallazgo F-REC-5): se propone, no se marca solo.
    const proposed = recipe ? [...new Set(undeclared(recipe).map((u) => u.allergen))] : [];
    const proposal = proposed.length ? el('div', { 'data-feedback-id': 'food.recetario.formulario.alergenos_propuestos', 'data-feedback-label': 'Alérgenos que delatan los ingredientes', class: 'banner warn notice', role: 'note', id: 'proposedAllergens' },
      el('div', null, `Sus ingredientes o su texto nombran: ${proposed.map((a) => ALLERGEN_LABELS[a]).join(', ')}.`),
      el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.recetario.formulario.alergenos_propuestos.marcar', 'data-feedback-label': 'Marcarlos', class: 'ghost', type: 'button',
        onclick: () => { tags.set([...new Set([...tags.get(), ...proposed.map((a) => `allergen:${a}`)])]); guard.dirtyEditor = true; proposal?.remove(); } }, 'Marcarlos'))) : null;
    const checked = check('r-allergens-checked', 'He revisado los alérgenos de esta receta', recipe?.allergens_checked ?? false, { 'data-field-id': 'food.recetario.formulario.alergenos_revisados', 'data-field-entity': 'food.recipes', 'data-field-prop': 'allergens_checked', 'data-feedback-id': 'food.recetario.formulario.alergenos_revisados', 'data-feedback-label': 'Alérgenos revisados' });
    const status = el('select', { 'data-field-id': 'food.recetario.formulario.estado', 'data-field-entity': 'food.recipes', 'data-field-prop': 'status', 'data-feedback-id': 'food.recetario.formulario.estado', 'data-feedback-label': 'Estado', id: 'r-status' }, ...RECIPE_STATUSES.map((s) => el('option', { value: s, selected: (recipe?.status ?? 'en_prueba') === s }, RECIPE_STATUS_LABELS[s])));

    // Ingredientes: los de Food y, después, los de Recursos que Food aún no usa (R5a).
    const shared = sharedIngredientItems(resourceItems, ingredients);
    const datalist = el('datalist', { id: 'ingredientNames' }, ...ingredients.map((i) => el('option', { value: i.name })), ...shared.map((i) => el('option', { value: i.name })));
    const sharedByKey = (value: string) => shared.find((i) => ingredientKey(i.name) === ingredientKey(value)) ?? null;
    interface LineForm { line: LineRow | null; name: HTMLInputElement; quantity: HTMLInputElement; unit: HTMLSelectElement; station: HTMLSelectElement; node: HTMLElement }
    const lineForms: LineForm[] = [];
    const lineHost = el('div', { 'data-feedback-id': 'food.recetario.ingredientes.lista', 'data-feedback-label': 'Lista de ingredientes', class: 'linerows', id: 'ingredientRows' });
    const names = new Map(ingredients.map((i) => [i.id, i]));
    function addLine(line: LineRow | null): void {
      const known = line ? names.get(line.ingredient_id) : null;
      const form: LineForm = {
        line,
        name: el('input', { 'data-field-id': 'food.recetario.ingredientes.nombre', 'data-field-entity': 'food.recipe_ingredients', 'data-field-prop': 'ingredient_id', 'data-feedback-id': 'food.recetario.ingredientes.nombre', 'data-feedback-label': 'Ingrediente', type: 'text', list: 'ingredientNames', placeholder: 'Ingrediente', 'aria-label': 'Ingrediente', maxlength: '120', value: known?.name ?? '',
          onchange: () => {
            if (form.line || form.quantity.value) return;
            const hit = byKey(form.name.value);
            const unit = hit ? hit.preferred_unit : foodUnitFromBase(sharedByKey(form.name.value)?.base_unit ?? '');
            if (unit) form.unit.value = unit;
          } }),
        quantity: el('input', { 'data-field-id': 'food.recetario.ingredientes.cantidad', 'data-field-entity': 'food.recipe_ingredients', 'data-field-prop': 'quantity', 'data-feedback-id': 'food.recetario.ingredientes.cantidad', 'data-feedback-label': 'Cantidad', type: 'text', inputmode: 'decimal', placeholder: 'Cantidad', 'aria-label': 'Cantidad', value: line ? formatQuantity(line.quantity) : '' }),
        unit: el('select', { 'data-field-id': 'food.recetario.ingredientes.unidad', 'data-field-entity': 'food.recipe_ingredients', 'data-field-prop': 'unit', 'data-feedback-id': 'food.recetario.ingredientes.unidad', 'data-feedback-label': 'Unidad', 'aria-label': 'Unidad' }, ...UNITS.map((u) => el('option', { value: u, selected: (line?.unit ?? 'g') === u }, UNIT_LABELS[u]))),
        // Estación del montaje (1110): 1 Untar · 2 Colocar · 3 Dosificar · 4 Acabados; la usan la previsión de la carta y Flow.
        station: el('select', { 'data-field-id': 'food.recetario.ingredientes.estacion', 'data-field-entity': 'food.recipe_ingredients', 'data-field-prop': 'station', 'data-feedback-id': 'food.recetario.ingredientes.estacion', 'data-feedback-label': 'Estación', 'aria-label': 'Estación' },
          el('option', { value: '' }, 'Sin estación'),
          ...[1, 2, 3, 4].map((s) => el('option', { value: String(s), selected: Number(line?.station ?? 0) === s }, `${s} · ${STATION_LABELS[s]}`))),
        node: el('div', { 'data-feedback-id': 'food.recetario.ingredientes.linea', 'data-feedback-label': 'Línea de ingrediente', class: 'linerow' }),
      };
      form.node.append(form.name, form.quantity, form.unit, form.station,
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
      const box = el('input', { 'data-field-id': 'food.recetario.formulario.maquinaria.equipo', 'data-field-entity': 'food.recipe_equipment', 'data-field-prop': 'equipment_id', 'data-feedback-id': 'food.recetario.formulario.maquinaria.equipo', 'data-feedback-label': 'Necesita esta máquina', type: 'checkbox', checked: !!need, id: `r-machine-${machine.id}` });
      const quantity = el('input', { 'data-field-id': 'food.recetario.formulario.maquinaria.unidades', 'data-field-entity': 'food.recipe_equipment', 'data-field-prop': 'quantity_required', 'data-feedback-id': 'food.recetario.formulario.maquinaria.unidades', 'data-feedback-label': 'Unidades necesarias', type: 'number', min: '1', step: '1', inputmode: 'numeric', value: String(need?.quantity_required ?? 1), 'aria-label': `Unidades de ${machine.name}`, class: 'qty compact' });
      // R5: dónde está (su espacio en Recursos), fuera de la etiqueta.
      const place = machinePlace(machine);
      return { machine, need, box, quantity, node: el('div', { class: 'machinerow' }, el('label', { class: 'checkline', for: box.id }, box, el('span', null, machine.name)), place ? el('span', { class: 'muted machineplace' }, place) : null, quantity) };
    });

    function build(photo: Record<string, unknown>): { operations: RowOperation[]; problem?: { message: string; focus?: HTMLElement } } {
      const base = parseQuantity(servings.value);
      if (!name.value.trim()) return { operations: [], problem: { message: 'El nombre es obligatorio.', focus: name } };
      if (base === null || base <= 0) return { operations: [], problem: { message: 'Indica las raciones base (por ejemplo, 20).', focus: servings } };
      const prepMinutes = prepMode.value === 'momento' ? 0 : prepMode.value === 'antes' ? prepFromParts(prep.value, prepUnit.value as PrepUnit) : null;
      if (prepMode.value === 'antes' && prepMinutes === null) return { operations: [], problem: { message: 'La antelación va entre 1 minuto y 7 días.', focus: prep } };
      const steps = method.value();
      if (status.value === 'validada' && !checked.box.checked) return { operations: [], problem: { message: 'Revisa los alérgenos antes de validar la receta.', focus: checked.box } };

      const operations: RowOperation[] = [];
      const picked = new Set(tags.get());
      const fields: Record<string, unknown> = {
        name: name.value.trim(), public_name: text(publicName.value), public_description: text(publicDescription.value), category: category.value,
        base_servings: base, prep_minutes: prepMinutes,
        // Una receta antigua (solo `method`) que se abre y guarda sin tocar la elaboración no se reescribe.
        ...(recipe && !method.changed() ? {} : { method_steps: steps.length ? steps : null, method: formatMethodSteps(steps) }),
        conservation: text(conservation.value), freezable: freezable.box.checked, regeneration: text(regeneration.value), service_notes: text(serviceNotes.value),
        diet_tags: DIET_TAGS.filter((d) => picked.has(`diet:${d}`)), allergens: ALLERGENS.filter((a) => picked.has(`allergen:${a}`)),
        allergens_checked: checked.box.checked, status: status.value, ...photo,
      };

      // Ingredientes nuevos van en el mismo lote que la línea que los usa: si el servidor rechaza uno, no queda nada a medias.
      const created = new Map<string, string>();
      const resolved: Array<{ form: LineForm; ingredientId: string; quantity: number; unit: Unit; station: number | null }> = [];
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
          // Si ya es un artículo de Recursos, el ingrediente nace enlazado con él (con su nombre y su unidad).
          const item = sharedByKey(label);
          operations.push({ op: 'insert', table: T.ingredients, id: ingredientId, fields: item
            ? { name: item.name, preferred_unit: foodUnitFromBase(item.base_unit) ?? unit, item_id: item.id }
            : { name: label.replace(/\s+/g, ' '), preferred_unit: unit } });
        }
        resolved.push({ form, ingredientId, quantity, unit, station: form.station.value ? Number(form.station.value) : null });
      }

      if (!recipe) operations.push({ op: 'insert', table: T.recipes, id: recipeId, fields });
      else {
        const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) => !same(recipe[key], value)));
        if (Object.keys(changed).length) operations.push({ op: 'update', table: T.recipes, id: recipe.id, expectedRevision: recipe.revision, fields: changed });
      }

      resolved.forEach(({ form, ingredientId, quantity, unit, station }, index) => {
        const position = index + 1;
        if (!form.line) {
          operations.push({ op: 'insert', table: T.recipeIngredients, id: crypto.randomUUID(), fields: { recipe_id: recipeId, ingredient_id: ingredientId, quantity, unit, position, ...(station ? { station } : {}) } });
        } else {
          const next = { ingredient_id: ingredientId, quantity, unit, position, station };
          const changed = Object.fromEntries(Object.entries(next).filter(([key, value]) => (key === 'quantity' || key === 'position' ? Number(form.line![key]) !== value
            : key === 'station' ? (form.line!.station === null || form.line!.station === undefined ? null : Number(form.line!.station)) !== value : form.line![key] !== value)));
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
      section({ 'data-feedback-id': 'food.recetario.formulario.seccion_cocina', 'data-feedback-label': 'Bloque Cocina' }, 'Cocina', method.element, prepField, field('Conservación', conservation), freezable.node,
        field('Regeneración', regeneration), field('Notas de servicio', serviceNotes)),
      section({ 'data-feedback-id': 'food.recetario.formulario.seccion_seguridad', 'data-feedback-label': 'Bloque Seguridad' }, 'Seguridad',
        tags.element,
        proposal,
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

  // «Sin conexión · datos de las 09:05…» (068 §6, `.o-offline` de Guests): con hora, qué falla y qué sigue funcionando.
  function paintOffline(): void {
    const status = client.status();
    const down = status.network === 'offline' || !navigator.onLine;
    offline.hidden = !down;
    if (!down) return;
    const at = status.lastPullAt ? new Date(status.lastPullAt) : null;
    const when = !at ? 'sin datos de cuándo'
      : at.toLocaleDateString('sv-SE') === todayKey() ? `datos de las ${at.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`
      : `datos del ${formatDate(status.lastPullAt)}`;
    replace(offline, el('div', null,
      el('strong', null, `Sin conexión · ${when}.`), ' Lo que cambies se guardará al volver la conexión.',
      el('p', { class: 'fd-offline-what' }, 'Las fotos que no se han abierto antes en este dispositivo y «Platos sugeridos» necesitan red. Lo demás funciona.')));
  }

  void load();
  paintOffline();
  void loadPurchases(client).then((next) => { purchases = next; });
  const offs = [T.recipes, T.ingredients, T.recipeIngredients, T.equipment, T.recipeEquipment].map((table) => client.onTable(table, () => void load()));
  // El espejo de Recursos llega después que el de Food, y los menús cambian aparte: la ficha abierta se repinta.
  let stockTimer: ReturnType<typeof setTimeout> | null = null;
  const onStock = () => {
    if (stockTimer) clearTimeout(stockTimer);
    stockTimer = setTimeout(() => {
      void Promise.all([
        loadInventory(client).then((next) => { inventory = next; }).catch(() => undefined),
        Promise.all([client.list(T.menus), client.list(T.menuServices), client.list(T.menuItems), client.list(T.consumptions)])
          .then(([menus, services, items, consumptions]) => { planning = { menus, services, items, consumptions } as typeof planning; }).catch(() => undefined),
      ]).then(refreshCard);
    }, 300);
  };
  const offStock = [
    ...[T.menus, T.menuServices, T.menuItems, T.consumptions].map((table) => client.onTable(table, onStock)),
    ...(() => { try { const r = resourcesClient(client); return [R.spaces, R.items, R.movements, R.lots].map((t) => r.onTable(t, onStock)); } catch { return []; } })(),
  ];
  const offStatus = client.onStatus(() => { paintOffline(); if (!sheet) void load(); });
  window.addEventListener('online', paintOffline);
  window.addEventListener('offline', paintOffline);
  return () => {
    offs.forEach((off) => off());
    offStock.forEach((off) => off());
    if (stockTimer) clearTimeout(stockTimer);
    offStatus();
    window.removeEventListener('online', paintOffline);
    window.removeEventListener('offline', paintOffline);
    void closeSheet(true);
  };
};
