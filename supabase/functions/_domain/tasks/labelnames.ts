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
  const found = enteringLabelClash(data, operations);
  if (!found) return;
  const l = found.label;
  reject(422, 'DUPLICATE_LABEL', labelClashMessage(found), {
    labelId: l.id, name: l.name, tabId: l.tab_id, familyId: l.family_id, parentId: l.parent_id ?? null,
    conflictId: found.clash.id, conflictName: found.clash.name, conflictTabId: found.clash.tab_id, where: found.where,
  });
}

/** Lo mismo que `assertLabelNames`, sin lanzar: el primer choque en el que entra una etiqueta del lote, o `null`. */
export function enteringLabelClash(data: Dataset, operations: readonly Operation[]): LabelClash | null {
  const touched = new Set(operations.filter((o) => o.op !== 'call' && (o.table === 'tasks.labels' || o.table === 'tasks.families')).map((o) => o.id!));
  if (!touched.size) return null;
  const before = index(data), after = index(applyOperations(data, operations));
  for (const l of after.labels) {
    if (!touched.has(l.id) && !touched.has(l.family_id)) continue;
    if (!visible(after, l)) continue;
    const old = before.byId.get(l.id);
    if (old && visible(before, old) && keyOf(before, old) === keyOf(after, l)) continue;
    const found = clashOf(after, l);
    if (found) return found;
  }
  return null;
}

/* ---------------------------------------------------------------------------------------------------------------------
 * «Repetidas → General» y «Hacer General» (FB_2026_023), vistos con la regla de nombres (FB_2026_033, §27.2).
 *
 * La fusión la hace el procedimiento `tasks.merge_labels_into_general` (migración 0318), y el hook de la 0331 mira su
 * resultado: si en un área queda viva otra etiqueta igual que no entra en el grupo, rechaza el lote entero con
 * DUPLICATE_LABEL. Para que la vista previa lo anticipe, `generalMergeOperations` reproduce lo que el procedimiento hace
 * con etiquetas y familias (las General nuevas, las hijas que se quedan en su área y las copias archivadas; no repunta
 * tareas, responsables ni vistas, que no cuentan para la regla) y `generalMergeProblem` le pasa la misma comprobación
 * del hook (`enteringLabelClash`).
 * ------------------------------------------------------------------------------------------------------------------- */

/** Un grupo, como lo manda la app a `POST labels/general/merge`: la lista de ids o `{ids, root: true}`. */
export type GeneralMergeGroup = readonly Uuid[] | { ids: readonly Uuid[]; root?: boolean };

export interface GeneralMergeSimulation {
  operations: Operation[];
  /** Etiqueta de área → id (provisional) de su General. */
  generals: Map<Uuid, Uuid>;
  /** Id provisional de cada General → índice de su grupo. */
  groupOf: Map<Uuid, number>;
}

export interface GeneralMergeProblem {
  code: 'DUPLICATE_LABEL' | 'INVALID_MERGE';
  /** Para la persona: «En Mejoras quedaría otra «VG» bajo «Staff»: archívala o renómbrala antes.» */
  message: string;
  /** Índice del grupo que lo provoca (nulo si no se sabe cuál). */
  group: number | null;
  /** La etiqueta viva que se queda fuera y choca. */
  conflictId?: Uuid;
  conflictName?: string;
  conflictTabId?: Uuid | null;
  conflictTabName?: string | null;
  /** Si meterla en ese grupo lo arregla (de otra área, y el procedimiento la acepta): su id. */
  include?: Uuid;
}

/** Id provisional de una fila que crearía la fusión (no es un uuid: no se confunde con ninguna real). */
const PREVIEW = 'general-preview:';
const lowerTrim = (s: unknown) => String(s ?? '').trim().toLowerCase();
const invalidMerge = (group: number, message: string, reason: string): never => reject(422, 'INVALID_MERGE', message, { group, reason });

/**
 * Las operaciones sobre `tasks.families` y `tasks.labels` que haría `tasks.merge_labels_into_general` con estos grupos,
 * con las mismas reglas: por rondas (primero las madres), la familia General de la madre o la General con la misma clave
 * o nombre (o una nueva), y las mismas comprobaciones de entrada (lanza `DomainError` INVALID_MERGE como el servidor).
 */
export function generalMergeOperations(data: Dataset, groups: readonly GeneralMergeGroup[]): GeneralMergeSimulation {
  const labels = new Map(data['tasks.labels'].map((l) => [l.id, l]));
  const families: Array<Pick<FamilyRow, 'id' | 'tab_id' | 'name' | 'color' | 'archived' | 'position' | 'system_key' | 'deleted_at'>> = data['tasks.families'].map((f) => ({ ...f }));
  const familyOf = new Map<Uuid, Uuid>(), positions = new Map<Uuid, number>();
  for (const l of data['tasks.labels']) positions.set(l.family_id, Math.max(positions.get(l.family_id) ?? 0, Number(l.position) || 0));
  const operations: Operation[] = [], generals = new Map<Uuid, Uuid>(), famMap = new Map<Uuid, Uuid>(), groupOf = new Map<Uuid, number>();
  let seq = 0;
  let pending = groups.map((g, i) => ({ i, ids: [...(Array.isArray(g) ? g : (g as { ids: readonly Uuid[] }).ids)], root: !Array.isArray(g) && !!(g as { root?: boolean }).root }));
  for (let round = 1; round <= 3 && pending.length; round++) {
    const next: typeof pending = [];
    for (const g of pending) {
      const ids = [...new Set(g.ids)];
      if (!ids.length) invalidMerge(g.i, 'Un grupo necesita al menos una etiqueta.', 'empty');
      const rows = ids.map((id) => labels.get(id));
      if (rows.some((l) => !l || l.deleted_at || l.tab_id == null)) invalidMerge(g.i, 'Alguna etiqueta del grupo ya no está o ya es General.', 'labels');
      const live = rows as LabelRow[];
      if (new Set(live.map((l) => l.tab_id)).size !== ids.length) invalidMerge(g.i, 'Hay dos etiquetas de la misma área en el grupo.', 'areas');
      // El servidor junta lo que solo cambia en mayúsculas, no en tildes.
      const names = [...new Set(live.map((l) => l.name.trim()))];
      if (new Set(names.map(lowerTrim)).size !== 1) invalidMerge(g.i, `Solo cambian en tildes (${names.map((n) => `«${n}»`).join(' y ')}): ponles el mismo nombre antes.`, 'names');
      const fams = live.map((l) => data['tasks.families'].find((f) => f.id === l.family_id));
      const keys = new Set(fams.map((f) => f?.system_key ?? null));
      const sameKey = keys.size === 1 && fams.every((f) => f?.system_key);
      if (new Set(fams.map((f) => lowerTrim(f?.name))).size !== 1 && !sameKey) invalidMerge(g.i, 'Las familias del grupo no son la misma.', 'families');
      let parent: Uuid | null = null;
      if (!g.root && live.some((l) => l.parent_id)) {
        const targets = live.map((l) => {
          if (!l.parent_id) return null;
          const pa = labels.get(l.parent_id);
          return generals.get(l.parent_id) ?? (!pa || pa.tab_id == null ? pa?.id ?? null : null);
        });
        if (targets.every(Boolean) && new Set(targets).size === 1) parent = targets[0]!;
        else if (round < 3) { next.push(g); continue; }
        else invalidMerge(g.i, 'Fusiona también la etiqueta madre.', 'mother');
      }
      const first = labels.get(g.ids[0]!)!, firstFam = data['tasks.families'].find((f) => f.id === first.family_id);
      const famKey = sameKey ? fams[0]!.system_key : null;
      let fam: Uuid | null = parent ? familyOf.get(parent) ?? labels.get(parent)?.family_id ?? null : null;
      if (!fam) {
        fam = families.filter((f) => f.tab_id == null && !f.deleted_at
            && (famKey ? f.system_key === famKey : f.system_key == null && lowerTrim(f.name) === lowerTrim(firstFam?.name)))
          .sort((a, b) => Number(a.archived) - Number(b.archived) || a.position - b.position)[0]?.id ?? null;
      }
      if (!fam) {
        fam = `${PREVIEW}family:${++seq}`;
        const position = Math.max(0, ...families.filter((f) => f.tab_id == null).map((f) => Number(f.position) || 0)) + 1024;
        const fields = { tab_id: null, name: firstFam?.name ?? '', color: firstFam?.color ?? '#777777', position, system_key: famKey, archived: false };
        families.push({ id: fam, ...fields, deleted_at: null });
        operations.push({ op: 'insert', table: 'tasks.families', id: fam, fields });
      }
      const gen = `${PREVIEW}label:${++seq}`, position = (positions.get(fam) ?? 0) + 1024;
      positions.set(fam, position);
      familyOf.set(gen, fam);
      operations.push({ op: 'insert', table: 'tasks.labels', id: gen, fields: {
        tab_id: null, family_id: fam, parent_id: parent, name: first.name.trim(), position,
        archived: !!families.find((f) => f.id === fam)?.archived,
      } });
      for (const id of ids) { generals.set(id, gen); famMap.set(id, fam); }
      groupOf.set(gen, g.i);
    }
    pending = next;
  }
  // Las hijas de una madre fusionada que se quedan en su área cuelgan de la madre General, en su familia.
  for (const l of data['tasks.labels']) {
    if (l.deleted_at || !l.parent_id || !generals.has(l.parent_id) || generals.has(l.id)) continue;
    operations.push({ op: 'update', table: 'tasks.labels', id: l.id, expectedRevision: l.revision, fields: { parent_id: generals.get(l.parent_id)!, family_id: famMap.get(l.parent_id)! } });
  }
  // Las copias de cada área, archivadas.
  for (const id of generals.keys()) {
    const l = labels.get(id)!;
    if (!l.archived) operations.push({ op: 'update', table: 'tasks.labels', id, expectedRevision: l.revision, fields: { archived: true } });
  }
  return { operations, generals, groupOf };
}

/**
 * ¿Qué rechazaría el servidor de esta fusión? `null` si nada: ni el procedimiento (INVALID_MERGE) ni el hook de nombres
 * (DUPLICATE_LABEL). Con un choque dice dónde queda la otra y, si meterla en el grupo lo arregla, `include`.
 */
export function generalMergeProblem(data: Dataset, groups: readonly GeneralMergeGroup[], tryInclude = true): GeneralMergeProblem | null {
  let sim: GeneralMergeSimulation;
  try { sim = generalMergeOperations(data, groups); } catch (error) {
    const e = error as { code?: string; message?: string; details?: { group?: number } };
    if (e?.code !== 'INVALID_MERGE') throw error;
    return { code: 'INVALID_MERGE', message: e.message ?? 'No se puede fusionar este grupo.', group: e.details?.group ?? null };
  }
  const found = enteringLabelClash(data, sim.operations);
  if (!found) return null;
  const isNew = (id: unknown) => String(id ?? '').startsWith(PREVIEW);
  // La que se queda fuera es la viva de antes (no la General nueva).
  const after = applyOperations(data, sim.operations);
  const byId = new Map(after['tasks.labels'].map((l) => [l.id, l]));
  const leftover = (isNew(found.clash.id) ? byId.get(found.label.id!) : byId.get(found.clash.id)) ?? found.clash;
  const general = isNew(found.clash.id) ? found.clash.id : isNew(found.label.id) ? found.label.id! : null;
  const group = general ? sim.groupOf.get(general) ?? null : groupForMoved(sim, data, leftover);
  const tabName = leftover.tab_id ? data['tasks.tabs'].find((t) => t.id === leftover.tab_id)?.name ?? null : null;
  const parent = leftover.parent_id ? byId.get(leftover.parent_id) : null;
  const where = (parent?.name ?? after['tasks.families'].find((f) => f.id === leftover.family_id)?.name ?? '').trim();
  const problem: GeneralMergeProblem = {
    code: 'DUPLICATE_LABEL', group,
    message: `En ${tabName ?? 'General'} quedaría otra «${leftover.name.trim()}» ${parent ? 'bajo' : 'en'} «${where}»: archívala o renómbrala antes.`,
    conflictId: leftover.id, conflictName: leftover.name, conflictTabId: leftover.tab_id, conflictTabName: tabName,
  };
  // ¿Se arregla metiéndola en el grupo? Solo si es de otra área (una por área) y así el servidor no rechaza nada.
  if (tryInclude && group != null && general && leftover.tab_id && !isNew(leftover.id)) {
    const g = groups[group]!, ids = Array.isArray(g) ? g : (g as { ids: readonly Uuid[] }).ids;
    const tabs = new Set(ids.map((id) => data['tasks.labels'].find((l) => l.id === id)?.tab_id));
    if (!tabs.has(leftover.tab_id)) {
      const widened = groups.map((x, i) => i !== group ? x : Array.isArray(x) ? [...ids, leftover.id] : { ...(x as object), ids: [...ids, leftover.id] }) as GeneralMergeGroup[];
      if (!generalMergeProblem(data, widened, false)) problem.include = leftover.id;
    }
  }
  return problem;
}

/** Un choque entre dos que ya existían (hijas que pasan a la madre General): el grupo es el de esa madre. */
function groupForMoved(sim: GeneralMergeSimulation, data: Dataset, moved: LabelRow): number | null {
  const old = data['tasks.labels'].find((l) => l.id === moved.id);
  const gen = old?.parent_id ? sim.generals.get(old.parent_id) : undefined;
  return gen ? sim.groupOf.get(gen) ?? null : null;
}

/** Lanza `DomainError` con lo que rechazaría el servidor (para no mandar nunca un lote que el hook va a rechazar). */
export function assertGeneralMerge(data: Dataset, groups: readonly GeneralMergeGroup[]): void {
  const problem = generalMergeProblem(data, groups, false);
  if (problem) reject(422, problem.code, problem.message, problem);
}
