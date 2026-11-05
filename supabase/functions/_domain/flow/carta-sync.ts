/**
 * Reflejo de la carta de Food en el catálogo de Flow (encargo de VG del 26-10): qué crear, actualizar o retirar a partir de
 * `food.carta_projection`. Puro; lo usan el frontend («Actualizar carta desde Food») y las pruebas.
 */
import { TABLES } from './mod.ts';

/** Lo que el reflejo necesita de un proyecto y de un producto de Flow. */
export interface SyncProject { id: string; revision: number; food_menu_id: string | null; booking_event_id: string | null }
export interface SyncProduct {
  id: string; revision: number; deleted_at: string | null; project_id: string; scope: string; code: string; active: boolean;
  source_line_id: string | null; name: string; description: string | null; price_cents: number; image_key: string | null;
  allergens: string[]; allergens_checked: boolean; position: number;
}

export interface CartaLine {
  menu_id: string; menu_name: string; event_id: string | null; line_id: string; scope: 'clasico' | 'gourmet' | 'barra'; code: string;
  name: string; description: string | null; sale_price_cents: number; active: boolean; allergens: string[]; allergens_checked: boolean;
  image_key: string | null; position: number;
}

export interface CartaMenu { id: string; name: string; eventId: string | null; lines: CartaLine[] }

/** La carta que toca a este flujo: la ligada, la de su evento o, si solo hay una, esa. */
export function pickMenu(menus: CartaMenu[], project: SyncProject): CartaMenu | null {
  return menus.find((m) => m.id === project.food_menu_id)
    ?? (project.booking_event_id ? menus.find((m) => m.eventId === project.booking_event_id) : undefined)
    ?? (menus.length === 1 ? menus[0]! : null);
}

export interface SyncPlan { operations: unknown[]; created: number; changed: number; priced: number; deactivated: number }

export function planSync(project: SyncProject, menu: CartaMenu, products: SyncProduct[]): SyncPlan {
  const ops: unknown[] = [];
  let created = 0, changed = 0, priced = 0, deactivated = 0;
  const live = products.filter((p) => !p.deleted_at && p.project_id === project.id);
  const seen = new Set<string>();
  for (const line of menu.lines) {
    // Primero por su línea de Food; si no, el mismo producto por código, aunque venga de otra carta (p. ej. la copiada de otra
    // barra, VG 28-10): se reaprovecha en vez de crear otro igual.
    const lineIds = new Set(menu.lines.map((l) => l.line_id));
    const current = live.find((p) => p.source_line_id === line.line_id)
      ?? live.filter((p) => !seen.has(p.id) && p.scope === line.scope && p.code === line.code && !(p.source_line_id && lineIds.has(p.source_line_id)))
        .sort((a, b) => Number(!!b.active) - Number(!!a.active))[0];
    const fields = {
      name: line.name, description: line.description, price_cents: line.sale_price_cents, active: line.active, image_key: line.image_key,
      allergens: line.allergens ?? [], allergens_checked: !!line.allergens_checked, source_line_id: line.line_id, position: Math.round(Number(line.position) || 0),
    };
    if (!current) {
      ops.push({ op: 'insert', table: TABLES.products, id: crypto.randomUUID(), fields: { ...fields, project_id: project.id, scope: line.scope, code: line.code, prepared: line.scope !== 'barra' } });
      created++;
      continue;
    }
    seen.add(current.id);
    const before = current as unknown as Record<string, unknown>; // misma forma que `fields`
    const diff = Object.fromEntries(Object.entries(fields).filter(([k, v]) => JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null)));
    if (Object.keys(diff).length) {
      ops.push({ op: 'update', table: TABLES.products, id: current.id, expectedRevision: current.revision, fields: diff });
      changed++;
      if ('price_cents' in diff) priced++;
    }
  }
  for (const p of live) {
    // Lo que la carta de Food no trae se retira, también un duplicado del mismo código que quedó sin línea.
    if (!seen.has(p.id) && p.active) {
      ops.push({ op: 'update', table: TABLES.products, id: p.id, expectedRevision: p.revision, fields: { active: false } });
      deactivated++;
    }
  }
  if (project.food_menu_id !== menu.id) ops.push({ op: 'update', table: TABLES.projects, id: project.id, expectedRevision: project.revision, fields: { food_menu_id: menu.id } });
  return { operations: ops, created, changed, priced, deactivated };
}
