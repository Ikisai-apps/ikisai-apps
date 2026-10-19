/**
 * Food · qué menú y qué días enseña Cocina (tanda 27; MUELA-006 y 068 §1), para Cocina y para «Ahora en cocina» de Inicio.
 * - Un día, los menús «en cocina»: los retiros cuyo evento lo incluye o que tienen servicios ese día, y el menú de casa
 *   si tiene servicios ese día o si no hay ningún retiro. Con dos retiros a la vez, se elige.
 * - Los días de un menú: los del evento y los de sus servicios y pasos; en casa, de ayer a dentro de una semana y los días
 *   con servicios o pasos alrededor.
 */
import { HOUSE_MENU_ID, isHouseMenu, type FoodEvent, type Menu, type MenuService } from '@ikisai/domain-food';
import type { Mirror } from './client.ts';
import { eventDays } from './events.ts';

export interface KitchenMenu {
  id: string;
  house: boolean;
  title: string;
  event: FoodEvent | null;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function kitchenMenus(menus: Array<Mirror<Menu>>, services: Array<Mirror<MenuService>>, events: FoodEvent[], day: string): KitchenMenu[] {
  const live = services.filter((s) => !s.deleted_at);
  const retreats = menus.filter((m) => !m.deleted_at && !isHouseMenu(m) && m.id !== HOUSE_MENU_ID).flatMap((menu) => {
    const event = events.find((e) => e.event_id === menu.event_id) ?? null;
    const covers = event ? event.start_date <= day && day <= event.end_date : false;
    const serves = live.some((s) => s.menu_id === menu.id && s.service_date === day);
    return covers || serves ? [{ id: menu.id, house: false, title: event?.title ?? 'Retiro', event }] : [];
  });
  const house = menus.find((m) => !m.deleted_at && (m.id === HOUSE_MENU_ID || isHouseMenu(m)));
  const houseServes = live.some((s) => s.menu_id === (house?.id ?? HOUSE_MENU_ID) && s.service_date === day);
  return [...retreats, ...(house && (houseServes || !retreats.length) ? [{ id: house.id, house: true, title: 'Menú de casa', event: null }] : [])];
}

export function kitchenDays(menu: KitchenMenu, services: Array<Mirror<MenuService>>, stepDays: Array<string | null>, today: string): string[] {
  const set = new Set<string>();
  const own = services.filter((s) => !s.deleted_at && s.menu_id === menu.id).map((s) => s.service_date);
  if (menu.event) for (const d of eventDays(menu.event)) set.add(d);
  if (menu.house) {
    const from = addDays(today, -1);
    const to = addDays(today, 7);
    for (let d = from; d <= to; d = addDays(d, 1)) if (d === today || own.includes(d) || stepDays.includes(d)) set.add(d);
  } else {
    for (const d of own) set.add(d);
    for (const d of stepDays) if (d) set.add(d);
  }
  return [...set].sort();
}
