/**
 * Tasks · fase P2, PR 3a: qué persona de Central corresponde a cada etiqueta de la familia «Grupo: Persona»
 * (docs/tasks/API.md §33).
 *
 * Funciones puras. Una persona en Tasks se guarda como su id de Central (`person_id`) o como un grupo por nivel de casa
 * (`house_level`: «todo el staff»). En el modelo anidado, las vistas guardadas y la correspondencia viajan como una sola
 * clave de texto: el id de la persona o `level:<nivel>`.
 *
 * La vista previa PROPONE una ficha por etiqueta y la propietaria la CONFIRMA (decisión del usuario del 18-10-2026): nada se
 * casa a ciegas. Las copias por área de una misma persona («VG» en cuatro áreas, con la misma madre) son una sola.
 */
import type { FamilyRow, LabelRow, Uuid } from './types.ts';

export type HouseLevel = 'direccion' | 'staff' | 'outsider';
export const HOUSE_LEVELS: readonly HouseLevel[] = ['direccion', 'staff', 'outsider'];

/** Una fila de `central.people_options` (personas activas; `initials` desde Central 1509). */
export interface PersonOption {
  person_id: Uuid;
  name: string;
  user_id?: Uuid | null;
  active?: boolean;
  house_level: HouseLevel | null;
  initials?: string | null;
}

/** Clave de una persona en Tasks: su id de Central o `level:<nivel>`. */
export type PersonKey = string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVEL = /^level:(direccion|staff|outsider)$/;

export function personKey(row: { person_id?: Uuid | null; house_level?: string | null }): PersonKey {
  return row.person_id ? row.person_id : `level:${row.house_level}`;
}

/** Columnas de una clave: `{person_id, house_level}` con exactamente uno de los dos. Lanza si la clave no vale. */
export function personFields(key: PersonKey): { person_id: Uuid | null; house_level: HouseLevel | null } {
  if (UUID.test(key)) return { person_id: key.toLowerCase(), house_level: null };
  const level = LEVEL.exec(key);
  if (level) return { person_id: null, house_level: level[1] as HouseLevel };
  throw new Error(`Persona inválida: ${key}`);
}

export function isPersonKey(value: unknown): value is PersonKey {
  return typeof value === 'string' && (UUID.test(value) || LEVEL.test(value));
}

/** Sin mayúsculas, sin tildes y sin espacios de sobra. */
export function normalizePersonText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** La familia de personas: la de sistema `person` o, por el nombre, «Persona» o «Grupo: Persona» (como el SQL). */
export function isPersonFamily(family: Pick<FamilyRow, 'name' | 'system_key'>): boolean {
  return family.system_key === 'person' || ['persona', 'grupo: persona'].includes(normalizePersonText(family.name));
}

/** El nivel de casa de una etiqueta madre de grupo, por su nombre: «Staff», «Outsiders», «Voluntarios», «Dirección». */
export function groupLevelOf(name: string): HouseLevel | null {
  const n = normalizePersonText(name);
  if (n === 'staff') return 'staff';
  if (/^outsiders?$/.test(n) || /^voluntari(o|os|as)$/.test(n)) return 'outsider';
  if (n === 'direccion') return 'direccion';
  return null;
}

export type PersonProposal =
  | { personId: Uuid; name: string; initials: string | null; by: 'initials' | 'name' | 'first_name' }
  | { houseLevel: HouseLevel }
  | null;

/**
 * La ficha que se propone para una etiqueta (solo entre las personas con nivel de casa, las del selector):
 * 1. la madre de grupo por su nombre → su nivel;
 * 2. la etiqueta igual a las iniciales de una ficha;
 * 3. si no, igual a su nombre completo;
 * 4. si no, igual a su nombre de pila, solo si es único.
 * Si un paso casa con varias fichas, no se propone ninguna (la ambigua la elige la propietaria).
 */
export function proposePerson(name: string, options: readonly PersonOption[]): PersonProposal {
  const level = groupLevelOf(name);
  if (level) return { houseLevel: level };
  const n = normalizePersonText(name);
  if (!n) return null;
  const people = options.filter((o) => o.house_level && o.active !== false);
  const pick = (matches: PersonOption[], by: 'initials' | 'name' | 'first_name'): PersonProposal | undefined => {
    if (matches.length === 1) return { personId: matches[0]!.person_id, name: matches[0]!.name, initials: matches[0]!.initials ?? null, by };
    if (matches.length > 1) return null;
    return undefined;
  };
  const steps: Array<[PersonOption[], 'initials' | 'name' | 'first_name']> = [
    [people.filter((o) => o.initials && normalizePersonText(o.initials) === n), 'initials'],
    [people.filter((o) => normalizePersonText(o.name) === n), 'name'],
    [people.filter((o) => normalizePersonText(o.name).split(' ')[0] === n), 'first_name'],
  ];
  for (const [matches, by] of steps) {
    const found = pick(matches, by);
    if (found !== undefined) return found;
  }
  return null;
}

/** El valor de una propuesta en la correspondencia (`personId`, `level:<nivel>`) o nulo. */
export function proposalValue(proposal: PersonProposal): string | null {
  if (!proposal) return null;
  return 'houseLevel' in proposal ? `level:${proposal.houseLevel}` : proposal.personId;
}

/** Un valor confirmado de la correspondencia: una persona, un nivel o quitarla. */
export function isPeopleMapValue(value: unknown): value is string {
  return isPersonKey(value) || value === 'remove';
}

export interface PersonLabelGroup {
  /** Clave del grupo: nombre y madre normalizados. */
  key: string;
  labelIds: Uuid[];
  name: string;
  parentName: string | null;
  /** Áreas de las copias (nula: la General). */
  tabIds: Array<Uuid | null>;
}

type FamilyLike = Pick<FamilyRow, 'id' | 'name' | 'system_key' | 'deleted_at'>;
type LabelLike = Pick<LabelRow, 'id' | 'name' | 'family_id' | 'parent_id' | 'tab_id' | 'deleted_at'>;

/**
 * Las etiquetas vivas de las familias de persona, agrupadas: las copias por área con el mismo nombre normalizado y la misma
 * madre (por su nombre) son una sola persona. Qué familias entran en juego lo decide el SQL; aquí, todas las de persona.
 */
export function personLabelGroups(families: readonly FamilyLike[], labels: readonly LabelLike[]): PersonLabelGroup[] {
  const personFamilies = new Set(families.filter((f) => !f.deleted_at && isPersonFamily(f)).map((f) => f.id));
  const own = labels.filter((l) => !l.deleted_at && personFamilies.has(l.family_id));
  const byId = new Map(own.map((l) => [l.id, l]));
  const groups = new Map<string, PersonLabelGroup>();
  for (const l of [...own].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const parent = l.parent_id ? byId.get(l.parent_id) : undefined;
    const key = `${normalizePersonText(l.name)}|${parent ? normalizePersonText(parent.name) : ''}`;
    const group = groups.get(key) ?? { key, labelIds: [], name: l.name, parentName: parent?.name ?? null, tabIds: [] };
    group.labelIds.push(l.id);
    if (!group.tabIds.includes(l.tab_id)) group.tabIds.push(l.tab_id);
    groups.set(key, group);
  }
  return [...groups.values()];
}
