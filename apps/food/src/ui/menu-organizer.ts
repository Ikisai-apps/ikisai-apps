import type { FoodEvent } from '@ikisai/domain-food';
import { createPrintView, el, replace, type PrintItem, type PrintPageSpec, type PrintSection, type PrintView } from '@ikisai/ui-kit';
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
export function mountOrganizer({ client, menuId, host }: TabContext): () => void {
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let view: PrintView | null = null;
  let version = 0;

  async function spec(data: MenuData, event: FoodEvent | null): Promise<PrintPageSpec> {
    const recipes = new Map(data.recipes.map((r) => [r.id, r]));
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
            ],
          });
        }
        groups.push({ title: SERVICE_LABELS[service.service_type], subtitle: shortTime(service.service_time) || undefined, items, empty: 'Por definir' });
      }
      sections.push({ title: capitalize(longDay(day)), groups });
    }
    const validated = data.menu?.status === 'validado' || data.menu?.status === 'cerrado';
    return {
      brand: { appName: 'Food', markIcon: 'chef', line: 'Menú del retiro' },
      title: event?.title ?? 'Menú',
      subtitle: event ? dateRange(event) : undefined,
      draft: !validated,
      sections,
      notes: el('p', null, 'Las etiquetas en verde indican la dieta del plato; las de color teja, los alérgenos que contiene. ',
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
      replace(host,
        el('p', { class: 'muted tabhead' }, page.draft ? 'El menú no está validado: la hoja sale marcada como borrador.' : 'Esta es la hoja para enviar al organizador. No incluye cantidades ni notas internas.'),
        view.element);
    }
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
