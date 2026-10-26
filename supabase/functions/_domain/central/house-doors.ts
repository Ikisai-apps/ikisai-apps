/**
 * Ikisai Central · qué puertas abre el nivel de casa (encargo de VG del 26-10-2026, plazo 29-10; docs/central/API.md §2.15).
 * La tabla es la del núcleo (`core.house_level_roles`, migración 0095), app por app:
 *  · dirección: propietario en Central, Tasks, Finance, Booking, Food y Flow, y en Guests y Organizers todos los retiros
 *    (los ve, se apunta y coorganiza: `scopes.grants` con `{"all": true}`);
 *  · staff: editor en Tasks, Food y Flow, y huésped en Guests de los retiros en los que participa (eso lo pone Booking);
 *  · outsider: outsider en Tasks y Flow, y huésped en Guests.
 * Lo concede el núcleo (`core.apply_house_level`). Aquí solo se compara lo que pide el nivel con lo que la cuenta tiene, para
 * enseñarlo en la ficha con su estado y saber si «Aplicar accesos» tiene algo que hacer.
 */
import type { HouseGrant, HouseLevel } from './people.ts';

export type PortalReach = 'todos' | 'huesped';
/** Lo que el nivel pide en una app: un rol (internas) o un alcance de portal. `booking`: lo da Booking al apuntarle a un retiro. */
export type DoorWant = { role: 'owner' | 'editor' | 'outsider' } | { portal: PortalReach; booking?: true };

export const HOUSE_LEVEL_DOORS: Record<HouseLevel, Readonly<Record<string, DoorWant>>> = {
  direccion: {
    central: { role: 'owner' }, tasks: { role: 'owner' }, invoices: { role: 'owner' }, booking: { role: 'owner' }, food: { role: 'owner' }, flow: { role: 'owner' },
    guests: { portal: 'todos' }, organizers: { portal: 'todos' },
  },
  staff: { tasks: { role: 'editor' }, food: { role: 'editor' }, flow: { role: 'editor' }, guests: { portal: 'huesped', booking: true } },
  outsider: { tasks: { role: 'outsider' }, flow: { role: 'outsider' }, guests: { portal: 'huesped' } },
};
export const PORTAL_REACH_LABELS: Record<PortalReach, string> = {
  todos: 'Todos los retiros: los ve, se apunta y coorganiza',
  huesped: 'Huésped de los retiros en los que participa',
};

/** `al_participar`: el huésped de staff lo da Booking al apuntarle a un retiro; «Aplicar accesos» no lo abre. */
export type DoorStatus = 'concedido' | 'pendiente' | 'al_participar';
export interface HouseDoor {
  app: string;
  kind: 'internal' | 'portal';
  want: DoorWant;
  /** Rol que tiene hoy en esa app (null = sin acceso). */
  have: string | null;
  status: DoorStatus;
  /** Lo dio el nivel de casa (`core.house_grants`); si no, es un acceso puesto a mano o de otra vía. */
  derived: boolean;
}

const RANK: Record<string, number> = { reader: 1, outsider: 2, editor: 3, owner: 4 };

/** Ámbito «todos» de un portal: una entrada `{"all": true}` en `scopes.grants` (lo mismo que `core.portal_all_grant`). */
export function portalAllGrant(scopes: unknown): boolean {
  const grants = (scopes as { grants?: unknown } | null | undefined)?.grants;
  return Array.isArray(grants) && grants.some((g) => (g as { all?: unknown } | null)?.all === true);
}

/**
 * Puertas del nivel para una cuenta, en el orden del catálogo: primero las internas, luego los portales.
 *  · Interna: concedida si su rol llega al que pide el nivel (el núcleo nunca rebaja: un rol mayor también vale).
 *  · Portal «todos»: concedida si su pertenencia lleva el ámbito «todos».
 *  · Portal «huésped»: concedida si ya entra en el portal; si lo pone Booking y aún no entra, «al participar».
 * Solo las apps del catálogo (una app que aún no existe no sale). Sin nivel, ninguna puerta.
 */
export function houseDoors(
  level: HouseLevel | null | undefined,
  catalog: ReadonlyArray<{ id: string; kind: string }>,
  memberships: ReadonlyArray<{ app: string; role: string; scopes?: unknown }>,
  grants: ReadonlyArray<Pick<HouseGrant, 'app' | 'role'>>,
): HouseDoor[] {
  const table = level ? HOUSE_LEVEL_DOORS[level] : undefined;
  if (!table) return [];
  const door = (a: { id: string; kind: string }): HouseDoor => {
    const want = table[a.id]!;
    const m = memberships.find((x) => x.app === a.id) ?? null;
    const have = m?.role ?? null;
    const g = grants.find((x) => x.app === a.id) ?? null;
    const status: DoorStatus = 'role' in want ? (have && (RANK[have] ?? 0) >= RANK[want.role]! ? 'concedido' : 'pendiente')
      : want.portal === 'todos' ? (m && portalAllGrant(m.scopes) ? 'concedido' : 'pendiente')
        : m ? 'concedido' : want.booking ? 'al_participar' : 'pendiente';
    return { app: a.id, kind: 'role' in want ? 'internal' : 'portal', want, have, status, derived: !!g && g.role === have };
  };
  const listed = catalog.filter((a) => table[a.id]);
  return [...listed.filter((a) => 'role' in table[a.id]!).map(door), ...listed.filter((a) => !('role' in table[a.id]!)).map(door)];
}

export const pendingDoors = (doors: readonly HouseDoor[]) => doors.filter((d) => d.status === 'pendiente');

/** Lo que dice la casilla de un portal en Accesos: todos los retiros (ámbito «todos»), huésped u organizador. */
export type PortalCell = 'todos' | 'huesped' | 'organiza';
export const PORTAL_CELL_LABELS: Record<PortalCell, string> = { todos: 'Todos', huesped: 'Huésped', organiza: 'Organiza' };
export const PORTAL_CELL_TEXT: Record<PortalCell, string> = {
  todos: 'todos los retiros', huesped: 'huésped de sus retiros', organiza: 'organiza sus retiros',
};
export function portalCell(app: string, membership: { role: string; scopes?: unknown } | null | undefined): PortalCell | null {
  if (!membership) return null;
  if (portalAllGrant(membership.scopes)) return 'todos';
  return app === 'organizers' ? 'organiza' : 'huesped';
}
