/**
 * Tasks · regla de nombres de etiquetas (FB_2026_033; aprobada por el usuario el 13-10-2026; docs/tasks/API.md §27.2).
 *
 * Dentro de una familia, entre lo que se ve a la vez en un área (sus etiquetas propias y las General, `tab_id` nulo):
 * - madres únicas: dos etiquetas raíz no se llaman igual;
 * - hijas únicas dentro de su madre;
 * - la misma hija bajo madres distintas sí vale («Albergue › Baño» y «Salas › Baño»).
 *
 * Funciones puras sobre el conjunto de filas. La autoridad es el hook SQL `tasks.validate_label_names` (migración 0331),
 * que calcula lo mismo: solo rechaza lo que **entra** en un choque, para que los datos viejos repetidos no se rompan.
 */
import { applyOperations } from './ops.ts';
import { reject, type Dataset, type FamilyRow, type LabelRow, type Operation, type Uuid } from './types.ts';

const ACCENTS: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ä: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u',
};

/** Nombre normalizado: sin mayúsculas, sin espacios a los lados y sin tildes (la «ñ» se queda). Como `tasks.label_name_key`. */
export function labelNameKey(name: unknown): string {
  return String(name ?? '').trim().toLowerCase().replace(/[áàâäéèêëíìîïóòôöúùûü]/g, (c) => ACCENTS[c]!);
}

/** Clave de familia: la de sistema o, sin ella, el nombre (como `familyKey` de la app y `tasks.family_name_key`). */
export function familyNameKey(family: Pick<FamilyRow, 'system_key' | 'name'> | null | undefined): string {
  return family?.system_key ?? 'name:' + String(family?.name ?? '').trim().toLowerCase();
}

export interface LabelCandidate {
  id?: Uuid | null;
  tab_id: Uuid | null;
  family_id: Uuid;
  parent_id?: Uuid | null;
  name: string;
}

export interface LabelClash {
  /** La etiqueta que entra en el choque. */
  label: LabelCandidate;
  /** La viva con la que choca. */
  clash: LabelRow;
  /** Dónde: el nombre de la madre o, si es raíz, el de la familia. */
  where: string;
  /** Área de la que choca (nula si es General). */
  tabName: string | null;
}

interface Index {
  families: Map<string, FamilyRow>;
  liveTabs: Set<string>;
  tabNames: Map<string, string>;
  labels: LabelRow[];
  byId: Map<string, LabelRow>;
}

function index(data: Dataset): Index {
  const families = new Map(data['tasks.families'].map((f) => [f.id, f]));
  const liveTabs = new Set(data['tasks.tabs'].filter((t) => !t.deleted_at).map((t) => t.id));
  const tabNames = new Map(data['tasks.tabs'].map((t) => [t.id, t.name]));
  return { families, liveTabs, tabNames, labels: data['tasks.labels'], byId: new Map(data['tasks.labels'].map((l) => [l.id, l])) };
}

const familyAlive = (f: FamilyRow | undefined): f is FamilyRow => !!f && !f.deleted_at && !f.archived;

/** Viva y visible: sin papelera ni archivo, de familia viva y de un área viva (o General). */
function visible(ix: Index, l: Pick<LabelRow, 'deleted_at' | 'archived' | 'family_id' | 'tab_id'>): boolean {
  return !l.deleted_at && !l.archived && familyAlive(ix.families.get(l.family_id)) && (l.tab_id == null || ix.liveTabs.has(l.tab_id));
}

function keyOf(ix: Index, l: Pick<LabelRow, 'family_id' | 'parent_id' | 'name' | 'tab_id'>): string {
  return [familyNameKey(ix.families.get(l.family_id)), l.parent_id ?? '-', labelNameKey(l.name), l.tab_id ?? '-'].join('|');
}

function clashOf(ix: Index, candidate: LabelCandidate): LabelClash | null {
  const family = ix.families.get(candidate.family_id);
  const fkey = familyNameKey(family), name = labelNameKey(candidate.name), parent = candidate.parent_id ?? null;
  const clash = ix.labels.find((m) => m.id !== candidate.id && visible(ix, m)
    && (m.parent_id ?? null) === parent && labelNameKey(m.name) === name
    && (m.tab_id == null || candidate.tab_id == null || m.tab_id === candidate.tab_id)
    && familyNameKey(ix.families.get(m.family_id)) === fkey);
  if (!clash) return null;
  return { label: candidate, clash, where: ((parent && ix.byId.get(parent)?.name) || family?.name || '').trim(), tabName: clash.tab_id ? ix.tabNames.get(clash.tab_id) ?? null : null };
}

/**
 * ¿Choca esta etiqueta (nueva o editada) con otra viva? Para el editor: el aviso inmediato, sin esperar al servidor.
 * Devuelve la primera con la que choca, o `null`.
 */
export function labelNameClash(data: Dataset, candidate: LabelCandidate): LabelClash | null {
  return clashOf(index(data), candidate);
}

/** Texto para la persona: «Ya hay una «Baño» en «Albergue».» */
export function labelClashMessage(found: LabelClash): string {
  const { clash, label } = found;
  const scope = clash.tab_id === (label.tab_id ?? null) ? '' : clash.tab_id == null ? ' (General)' : found.tabName ? ` (de ${found.tabName})` : '';
  return `Ya hay una «${clash.name.trim()}» en «${found.where}»${scope}.`;
}

/**
 * Lo que comprueba el hook, antes de encolar: aplica el lote y busca una etiqueta que **entre** en un choque (crear,
 * renombrar, mover de madre o de familia, hacer General, desarchivar). Una etiqueta que ya tenía esa clave antes del lote
 * no se mira: los datos viejos repetidos no se rompen. Lanza `DomainError` DUPLICATE_LABEL con el primero.
 */
export function assertLabelNames(data: Dataset, operations: readonly Operation[]): void {
  const touched = new Set(operations.filter((o) => o.op !== 'call' && (o.table === 'tasks.labels' || o.table === 'tasks.families')).map((o) => o.id!));
  if (!touched.size) return;
  const before = index(data), after = index(applyOperations(data, operations));
  for (const l of after.labels) {
    if (!touched.has(l.id) && !touched.has(l.family_id)) continue;
    if (!visible(after, l)) continue;
    const old = before.byId.get(l.id);
    if (old && visible(before, old) && keyOf(before, old) === keyOf(after, l)) continue;
    const found = clashOf(after, l);
    if (!found) continue;
    reject(422, 'DUPLICATE_LABEL', labelClashMessage(found), {
      labelId: l.id, name: l.name, tabId: l.tab_id, familyId: l.family_id, parentId: l.parent_id ?? null,
      conflictId: found.clash.id, conflictName: found.clash.name, conflictTabId: found.clash.tab_id, where: found.where,
    });
  }
}
