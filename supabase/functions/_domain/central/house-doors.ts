/**
 * Ikisai Central · qué puertas abre el nivel de casa (encargo de VG del 26-10-2026, plazo 29-10; docs/central/API.md §2.15).
 * El nivel abre todas las apps internas (Flow incluida) y los portales de golpe:
 *  · dirección: propietario en las internas y, en Guests y Organizers, todos los retiros (los ve, se apunta y coorganiza);
 *  · staff: editor en las internas y, en Guests, huésped de los retiros en los que participa;
 *  · outsider: outsider en las internas y, en Guests, huésped.
 * Lo concede el núcleo (`core.apply_house_level`). Aquí solo se compara lo que pide el nivel con lo que la cuenta tiene, para
 * enseñarlo en la ficha con su estado y saber si «Aplicar accesos» tiene algo que hacer.
 */
import type { HouseGrant, HouseLevel } from './people.ts';

export type PortalReach = 'todos' | 'huesped';
/** Lo que el nivel pide en una app: un rol (internas) o un alcance de portal. */
export type DoorWant = { role: 'owner' | 'editor' | 'outsider' } | { portal: PortalReach };

export const HOUSE_LEVEL_INTERNAL_ROLE: Record<HouseLevel, 'owner' | 'editor' | 'outsider'> = { direccion: 'owner', staff: 'editor', outsider: 'outsider' };
export const HOUSE_LEVEL_PORTALS: Record<HouseLevel, Record<string, PortalReach>> = {
  direccion: { guests: 'todos', organizers: 'todos' },
  staff: { guests: 'huesped' },
  outsider: { guests: 'huesped' },
};
export const PORTAL_REACH_LABELS: Record<PortalReach, string> = {
  todos: 'Todos los retiros: los ve, se apunta y coorganiza',
  huesped: 'Huésped de los retiros en los que participa',
};

export type DoorStatus = 'concedido' | 'pendiente';
export interface HouseDoor {
  app: string;
  kind: 'internal' | 'portal';
  want: DoorWant;
  /** Rol que tiene hoy en esa app (null = sin acceso). */
  have: string | null;
  status: DoorStatus;
  /** Lo dio el nivel de casa (`core.house_grants`); si no, es un acceso puesto a mano. */
  derived: boolean;
}

const RANK: Record<string, number> = { reader: 1, outsider: 2, editor: 3, owner: 4 };

/**
 * Puertas del nivel para una cuenta, en el orden del catálogo: primero las internas, luego los portales.
 *  · Interna: concedida si su rol llega al que pide el nivel (el núcleo nunca rebaja: un rol mayor también vale).
 *  · Portal «huésped»: concedida si ya entra en el portal (sus retiros los pone Booking en los ámbitos).
 *  · Portal «todos»: concedida solo si se lo dio el nivel; el ámbito de todos los retiros lo define el núcleo (con Booking).
 * Sin nivel, ninguna puerta.
 */
export function houseDoors(
  level: HouseLevel | null | undefined,
  catalog: ReadonlyArray<{ id: string; kind: string }>,
  memberships: ReadonlyArray<{ app: string; role: string }>,
  grants: ReadonlyArray<Pick<HouseGrant, 'app' | 'role'>>,
): HouseDoor[] {
  if (!level || !(level in HOUSE_LEVEL_INTERNAL_ROLE)) return [];
  const roleIn = (app: string) => memberships.find((m) => m.app === app)?.role ?? null;
  const grantIn = (app: string) => grants.find((g) => g.app === app) ?? null;
  const internal = catalog.filter((a) => a.kind === 'internal').map((a): HouseDoor => {
    const role = HOUSE_LEVEL_INTERNAL_ROLE[level];
    const have = roleIn(a.id);
    const g = grantIn(a.id);
    return { app: a.id, kind: 'internal', want: { role }, have, status: have && RANK[have]! >= RANK[role]! ? 'concedido' : 'pendiente', derived: !!g && g.role === have };
  });
  const portals = catalog.filter((a) => a.kind === 'portal' && HOUSE_LEVEL_PORTALS[level][a.id]).map((a): HouseDoor => {
    const reach = HOUSE_LEVEL_PORTALS[level][a.id]!;
    const have = roleIn(a.id);
    const g = grantIn(a.id);
    const ok = reach === 'todos' ? !!g && g.role === have : !!have;
    return { app: a.id, kind: 'portal', want: { portal: reach }, have, status: ok ? 'concedido' : 'pendiente', derived: !!g && g.role === have };
  });
  return [...internal, ...portals];
}

export const pendingDoors = (doors: readonly HouseDoor[]) => doors.filter((d) => d.status === 'pendiente');

/** Lo que dice la casilla de un portal en Accesos: todos los retiros (lo dio dirección), huésped u organizador. */
export type PortalCell = 'todos' | 'huesped' | 'organiza';
export const PORTAL_CELL_LABELS: Record<PortalCell, string> = { todos: 'Todos', huesped: 'Huésped', organiza: 'Organiza' };
export const PORTAL_CELL_TEXT: Record<PortalCell, string> = {
  todos: 'todos los retiros', huesped: 'huésped de sus retiros', organiza: 'organiza sus retiros',
};
export function portalCell(app: string, membership: { role: string } | null | undefined, grant: Pick<HouseGrant, 'level'> | null | undefined): PortalCell | null {
  if (!membership) return null;
  if (grant && HOUSE_LEVEL_PORTALS[grant.level as HouseLevel]?.[app] === 'todos') return 'todos';
  return app === 'organizers' ? 'organiza' : 'huesped';
}
