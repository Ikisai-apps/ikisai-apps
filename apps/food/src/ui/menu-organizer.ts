import { crossContext, undeclaredAllergens, type FoodEvent, type Recipe } from '@ikisai/domain-food';
import { tonedChecks, verdictText, type ToneCheck } from './checks.ts';
import { createPrintView, el, pointAt, replace, revealAnchor, type PrintItem, type PrintPageSpec, type PrintSection, type PrintView } from '@ikisai/ui-kit';
import { ALLERGEN_LABELS, DIET_LABELS } from '../app/client.ts';
import { dateRange, longDay, shortTime, watchEvents, type EventsSnapshot } from '../app/events.ts';
import { MENU_TABLES, loadMenuData, type MenuData } from '../app/menu-data.ts';
import { photoUrl } from '../app/photos.ts';
import { SERVICE_LABELS } from './events.ts';
import type { TabContext } from './menu-shopping.ts';
import { usage } from '../app/usage.ts';
import { fb, fbIgnore } from './feedback.ts';

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Menú para el organizador (canon §28–29): el mismo dato con otra presentación, sobre la página imprimible del kit.
 * Solo lo público: retiro, fechas, servicios por día, foto, nombre y descripción públicos, dietas y alérgenos.
 * Nunca cantidades, raciones, ingredientes, proceso, maquinaria, proveedores ni notas internas.
 */
export function mountOrganizer({ client, menuId, host, canWrite, navigate }: TabContext): () => void {
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let view: PrintView | null = null;
  let version = 0;
  const checksHost = el('div', { class: 'fd-checkshost' });
  const intro = el('p', { class: 'muted tabhead' });
  // «Revisar» (hallazgo F-ORG-4): lo mismo que la hoja, en una columna y sin fotos, para repasarlo en el móvil.
  let mode: 'hoja' | 'revisar' = 'hoja';
  const reviewHost = el('div', { 'data-feedback-id': 'food.menu.organizador.revisar', 'data-feedback-label': 'Revisar en una columna', class: 'fd-orgreview', id: 'organizerReview', hidden: true });
  const modeButton = (key: typeof mode, label: string, feedbackId: string) => el('button', { 'data-feedback-id': feedbackId, 'data-feedback-label': label, type: 'button', 'data-mode': key,
    'aria-pressed': String(mode === key), class: mode === key ? 'on' : '', onclick: () => { mode = key; showMode(); } }, label);
  const modes = el('div', { class: 'segmented fd-orgmodes', role: 'group', 'aria-label': 'Cómo verla' },
    modeButton('hoja', 'Hoja', 'food.menu.organizador.modo.hoja'), modeButton('revisar', 'Revisar', 'food.menu.organizador.modo.revisar'));
  function showMode(): void {
    for (const b of modes.querySelectorAll<HTMLButtonElement>('button')) { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    if (view) view.element.hidden = mode !== 'hoja';
    reviewHost.hidden = mode !== 'revisar';
  }

  /** La vista compacta: día, servicio y cada plato con sus etiquetas en texto; sin fotos ni columnas. */
  function review(page: PrintPageSpec): HTMLElement[] {
    const dish = (item: PrintItem) => el('li', null, el('strong', null, item.title),
      item.chips?.length ? el('span', { class: 'chips' }, ...item.chips.map((chip) => el('span', { class: chip.kind === 'alert' ? 'chip alert' : chip.kind === 'ok' ? 'chip ok' : 'chip' }, chip.text))) : null);
    return (page.sections ?? []).map((section) => el('section', { class: 'fd-orgreview-day' },
      el('h3', null, section.title),
      ...(section.groups ?? []).map((group) => el('div', { class: 'fd-orgreview-service' },
        el('h4', null, [group.title, group.subtitle].filter(Boolean).join(' · ')),
        group.items.length ? el('ul', { class: 'fd-orgreview-dishes' }, ...group.items.map(dish)) : el('p', { class: 'muted' }, group.empty ?? 'Por definir')))));
  }

  /**
   * Veredicto y comprobaciones (tanda 27; MUELA-043 con 068 §5): alérgenos revisados y menú validado (rojo); fotos,
   * nombre y descripción para el organizador y compartido (ámbar). Informa y lleva al arreglo; no impide imprimir.
   */
  function checks(data: MenuData): HTMLElement {
    const recipes = new Map(data.recipes.map((r) => [r.id, r]));
    const used = Array.from(new Set(data.items.map((i) => i.recipe_id))).map((id) => recipes.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    const unreviewed = used.filter((r) => !r.allergens_checked);
    // Los ingredientes o el texto del plato nombran un alérgeno que no declara (decisión de Core Sevilla, 20-10-2026;
    // MUELA-086): en rojo, como lo sin revisar. El texto dice lo que se miró, sin prometer más.
    const context = crossContext({ recipe_ingredients: data.lines, ingredients: data.ingredients });
    const undeclared = used.filter((r) => undeclaredAllergens(r as unknown as Recipe, context).length > 0);
    const noPhoto = used.filter((r) => !r.photo_file_id);
    const noPublic = used.filter((r) => !r.public_name && !r.public_description);
    const status = data.menu?.status;
    const writable = canWrite() && !!navigate;
    const go = (label: string, hash: string, feedbackId: string) => (writable ? { label, onClick: () => navigate!(hash), feedbackId } : null);
    // Compartir (hallazgo F-ORG-3): lleva a la pestaña Menú con «Portal del organizador» abierto y el botón señalado.
    const goShare = async () => {
      navigate!(`#/menus/${menuId}`);
      for (const until = Date.now() + 4000; Date.now() < until && !document.getElementById('shareMenu');) await new Promise((r) => setTimeout(r, 50));
      const node = await revealAnchor('food.menu.organizador_portal.compartir');
      if (node) pointAt(node);
    };
    const names = (list: Array<{ name: string }>) => list.slice(0, 3).map((r) => r.name).join(', ') + (list.length > 3 ? '…' : '');
    const items: ToneCheck[] = [
      { tone: 'alert', ok: !unreviewed.length, text: 'Alérgenos revisados',
        detail: unreviewed.length ? `los alérgenos de ${names(unreviewed)} están sin revisar` : null,
        action: unreviewed.length ? go('Revisar en el Recetario', `#/recetario?receta=${unreviewed[0]!.id}`, 'food.menu.organizador.comprobar.alergenos') : null },
      { tone: 'alert', ok: !undeclared.length,
        text: undeclared.length ? 'Alérgenos posibles sin declarar' : 'Ningún ingrediente ni el nombre del plato nombran un alérgeno sin declarar',
        detail: undeclared.length ? `${undeclared.length === 1 ? '1 plato' : `${undeclared.length} platos`} con un alérgeno posible sin declarar: ${names(undeclared)}` : null,
        action: undeclared.length ? go('Revisar en el Recetario', `#/recetario?receta=${undeclared[0]!.id}`, 'food.menu.organizador.comprobar.sin_declarar') : null },
      { tone: 'alert', ok: status === 'validado' || status === 'cerrado', text: 'Menú validado',
        detail: status === 'validado' || status === 'cerrado' ? null : 'el menú no está validado: la hoja sale como borrador',
        action: status === 'validado' || status === 'cerrado' ? null : go('Ir a validar', `#/menus/${menuId}`, 'food.menu.organizador.comprobar.validar') },
      { tone: 'warn', ok: !noPhoto.length, text: 'Fotos de los platos', detail: noPhoto.length ? `sin foto: ${names(noPhoto)}` : null,
        action: noPhoto.length ? go('Añadir en el Recetario', `#/recetario?receta=${noPhoto[0]!.id}`, 'food.menu.organizador.comprobar.fotos') : null },
      { tone: 'warn', ok: !noPublic.length, text: 'Nombre y descripción para el organizador (opcional)', detail: noPublic.length ? `sin presentación: ${names(noPublic)}` : null,
        action: noPublic.length ? go('Escribirla en el Recetario', `#/recetario?receta=${noPublic[0]!.id}`, 'food.menu.organizador.comprobar.presentacion') : null },
      { tone: 'warn', ok: data.menu?.organizer_shared === true, text: 'Compartido con el organizador', detail: data.menu?.organizer_shared ? null : 'aún no lo ve en su portal',
        action: data.menu?.organizer_shared || !writable ? null : { label: 'Compartir en la pestaña Menú', onClick: () => void goShare(), feedbackId: 'food.menu.organizador.comprobar.compartir' } },
    ];
    return tonedChecks(items, { verdict: verdictText(items, 'Lista para enviar'), label: 'Antes de enviar', feedbackId: 'food.menu.organizador.comprobaciones', feedbackLabel: 'Comprobaciones antes de enviar' });
  }

  async function spec(data: MenuData, event: FoodEvent | null): Promise<PrintPageSpec> {
    const recipes = new Map(data.recipes.map((r) => [r.id, r]));
    const context = crossContext({ recipe_ingredients: data.lines, ingredients: data.ingredients });
    const pending = new Set(data.recipes.filter((r) => undeclaredAllergens(r as unknown as Recipe, context).length > 0).map((r) => r.id));
    // Mismo orden que en el constructor: por día, y dentro del día el que se fijó a mano.
    const services = [...data.services].sort((a, b) => a.service_date.localeCompare(b.service_date) || Number(a.position) - Number(b.position) || (a.service_time ?? '99').localeCompare(b.service_time ?? '99'));
    const days = Array.from(new Set(services.map((s) => s.service_date)));
    const sections: PrintSection[] = [];
    for (const day of days) {
      const groups = [];
      for (const service of services.filter((s) => s.service_date === day)) {
        const dishes = data.items.filter((i) => i.service_id === service.id).sort((a, b) => Number(a.position) - Number(b.position) || a.created_at.localeCompare(b.created_at));
        const items: PrintItem[] = [];
        for (const dish of dishes) {
          const recipe = recipes.get(dish.recipe_id);
          if (!recipe) continue;
          items.push({
            title: recipe.public_name || recipe.name,
            text: recipe.public_description ?? undefined,
            image: await photoUrl(client, recipe.photo_file_id),
            imageAlt: recipe.public_name || recipe.name,
            chips: [
              ...recipe.diet_tags.map((tag) => ({ text: DIET_LABELS[tag], kind: 'ok' as const })),
              ...recipe.allergens.map((allergen) => ({ text: ALLERGEN_LABELS[allergen], kind: 'alert' as const })),
              // Tanda 27 (regla de VG): un plato sin revisar lo dice en la hoja, también si no declara nada.
              ...(recipe.allergens_checked ? [] : [{ text: 'Alérgenos sin revisar', kind: 'alert' as const }]),
              // MUELA-086 (S2): el plato con un alérgeno posible sin declarar lleva su marca, aunque se compartiera igualmente.
              ...(pending.has(recipe.id) ? [{ text: 'Alérgeno posible sin declarar', kind: 'alert' as const }] : []),
            ],
          });
        }
        groups.push({ title: SERVICE_LABELS[service.service_type], subtitle: shortTime(service.service_time) || undefined, items, empty: 'Por definir' });
      }
      sections.push({ title: capitalize(longDay(day)), groups });
    }
    const validated = data.menu?.status === 'validado' || data.menu?.status === 'cerrado';
    const unreviewed = data.items.some((i) => recipes.get(i.recipe_id) && !recipes.get(i.recipe_id)!.allergens_checked);
    const doubtful = data.items.some((i) => pending.has(i.recipe_id));
    return {
      brand: { appName: 'Food', markIcon: 'chef', line: 'Menú del retiro' },
      title: event?.title ?? 'Menú',
      subtitle: event ? dateRange(event) : undefined,
      draft: !validated,
      sections,
      // MUELA-086 (S2): siempre «los alérgenos que declara»: es la declaración de cocina, no una promesa de que no haya más.
      notes: el('p', null, 'Las etiquetas en verde indican la dieta del plato; las de color teja, los alérgenos que declara. ',
        unreviewed ? 'Los platos marcados «Alérgenos sin revisar» todavía no los ha revisado cocina: pueden llevar alguno más. Preguntadnos antes de confirmarlos. ' : '',
        doubtful ? 'Los platos marcados «Alérgeno posible sin declarar» los está revisando cocina. Preguntadnos antes de confirmarlos. ' : '',
        'Si alguna persona del grupo tiene una alergia o intolerancia que no nos hayáis comunicado, avisadnos antes de la llegada.'),
      columns: 2,
    };
  }

  async function load(): Promise<void> {
    const current = ++version;
    const data = await loadMenuData(client, menuId);
    if (!data.menu) { replace(host); view = null; return; }
    const event = snapshot.events.find((e) => e.event_id === data.menu!.event_id) ?? null;
    const page = await spec(data, event);
    if (current !== version) return; // llegó otro cambio mientras se cargaban las fotos
    replace(checksHost, checks(data));
    // Como la hoja: los títulos y platos no viajan en el reporte.
    replace(reviewHost, fbIgnore(el('div', null, ...review(page))));
    intro.textContent = page.draft ? 'El menú no está validado: la hoja sale marcada como borrador.' : 'Esta es la hoja para enviar al organizador. No incluye cantidades ni notas internas.';
    if (view) { view.update(page); fbIgnore(view.page); }
    else {
      view = createPrintView(page, { printLabel: 'Imprimir / Guardar PDF' });
      // La hoja lleva el nombre del grupo (título del evento, de Booking): su texto no viaja en el reporte.
      fb(view.element, { feedbackId: 'food.menu.organizador.hoja', feedbackLabel: 'Hoja del organizador' });
      fbIgnore(view.page);
      const printButton = view.element.querySelector('#printPage');
      if (printButton) {
        fb(printButton, { feedbackId: 'food.menu.organizador.imprimir', feedbackLabel: 'Imprimir / Guardar PDF' });
        printButton.addEventListener('click', () => usage.track('food.organizador.imprimir'));
      }
      replace(host, checksHost, intro, modes, view.element, reviewHost);
    }
    showMode();
  }

  void load();
  const offEvents = watchEvents(client, (next) => { snapshot = next; void load(); });
  const offs = MENU_TABLES.map((table) => client.onTable(table, () => void load()));
  return () => {
    version += 1;
    offEvents();
    offs.forEach((off) => off());
  };
}
