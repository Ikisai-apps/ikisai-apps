/**
 * Tasks · copia portable (docs/tasks/API.md §6). El contenido viaja como el modelo anidado de la interfaz
 * (`data.json` → `{ tabs }`) más los archivos adjuntos por huella. Importar crea áreas nuevas con ids independientes:
 * se remapean todos los ids y el resultado pasa por `decompose` contra un conjunto vacío.
 */
import { decompose, type LegacyTab } from './legacy.ts';
import { isPersonKey } from './people.ts';
import { emptyDataset, reject, TABLES, type Dataset, type Uuid } from './types.ts';

export const PORTABLE_FORMAT = 'ikisai.tasks.portable.v2';

/**
 * Comentario de una tarea en la copia (2c). La foto viaja como un adjunto más, por su huella en `files/`. El autor y la
 * hora se conservan al importar (`meta` de `tasks.import_rows`); si la cuenta del autor no existe, queda quien importa con
 * el nombre original.
 */
export interface PortableComment {
  id: Uuid; taskId: Uuid; body: string; authorId: Uuid | null; authorName: string; createdAt: string;
  photo: { sha256: string; mime: string; size: number; name: string } | null;
}
/** De dónde salen zonas, acciones y personas en la instalación que exportó (`tasks.settings`; sin fila, `labels`). */
export interface PortableSettings { zoneSource: 'labels' | 'spaces'; tradeSource: 'labels' | 'central'; peopleSource: 'labels' | 'central' }
/** `data.json`. `settings` y `comments` llegan con la 2c: una copia anterior no los trae y se importa igual que siempre. */
export interface PortableData { tabs: LegacyTab[]; settings?: PortableSettings; comments?: PortableComment[] }

export const PHOTO_MIME = ['image/webp', 'image/jpeg', 'image/png'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;

/** Los ajustes de origen de una instalación, a partir de `tasks.settings`. */
export function portableSettings(data: Pick<Dataset, 'tasks.settings'>): PortableSettings {
  const get = (key: string) => { const row = (data['tasks.settings'] ?? []).find((s) => s.key === key && !s.deleted_at); return typeof row?.value === 'string' ? row.value : null; };
  return { zoneSource: get('zone_source') === 'spaces' ? 'spaces' : 'labels', tradeSource: get('trade_source') === 'central' ? 'central' : 'labels', peopleSource: get('people_source') === 'central' ? 'central' : 'labels' };
}

/** Comentarios vivos de las tareas del modelo, para la copia. `photo` da los datos del archivo de cada `file_id`. */
export function portableComments(data: Pick<Dataset, 'tasks.task_comments'>, tabs: readonly LegacyTab[], photo: (fileId: Uuid) => PortableComment['photo']): PortableComment[] {
  const tasks = new Set(tabs.flatMap((t) => t.projects.flatMap((p) => p.tasks.map((x) => x.id))));
  return (data['tasks.task_comments'] ?? []).filter((c) => !c.deleted_at && tasks.has(c.task_id))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
    .map((c) => ({ id: c.id, taskId: c.task_id, body: c.body, authorId: c.author_id ?? null, authorName: c.author_name ?? '', createdAt: c.created_at, photo: c.file_id ? photo(c.file_id) : null }));
}

/** Comprobaciones de forma de los comentarios de una copia (opcionales). Lanza `INVALID_BUNDLE`. */
export function checkPortableComments(value: unknown, tabs: readonly LegacyTab[]): PortableComment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20000) invalid('comentarios mal formados.');
  const tasks = new Set(tabs.flatMap((t) => t.projects.flatMap((p) => p.tasks.map((x) => x.id))));
  const seen = new Set<string>();
  for (const c of value as PortableComment[]) {
    if (!c || typeof c.id !== 'string' || seen.has(c.id) || typeof c.taskId !== 'string' || !tasks.has(c.taskId)) invalid('un comentario no es de ninguna tarea de la copia.');
    seen.add(c.id);
    if (typeof c.body !== 'string' || !c.body.trim() || c.body.length > 2000) invalid('un comentario tiene que tener texto (hasta 2000 caracteres).');
    if (c.authorName !== undefined && (typeof c.authorName !== 'string' || c.authorName.length > 200)) invalid('autor de comentario mal formado.');
    if (c.photo != null && (typeof c.photo !== 'object' || !SHA.test(String(c.photo.sha256)) || !PHOTO_MIME.includes(String(c.photo.mime).toLowerCase()))) invalid('la foto de un comentario no es una imagen admitida.');
  }
  return value as PortableComment[];
}

/** Ajustes de una copia: lo que no reconoce cuenta como `labels`; sin ajustes (copia anterior a la 2c), `null`. */
export function checkPortableSettings(value: unknown): PortableSettings | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return { zoneSource: v.zoneSource === 'spaces' ? 'spaces' : 'labels', tradeSource: v.tradeSource === 'central' ? 'central' : 'labels', peopleSource: v.peopleSource === 'central' ? 'central' : 'labels' };
}

export interface PortableManifest {
  format: typeof PORTABLE_FORMAT;
  exportedAt: string;
  data: { path: string; sha256: string };
  files: Array<{ path: string; sha256: string; size: number }>;
}

const invalid = (message: string): never => reject(422, 'INVALID_BUNDLE', 'Copia inválida: ' + message);

/** Comprobaciones de forma del modelo importado; lanza `INVALID_BUNDLE` o `UNRESOLVED_DEPENDENCIES`. */
export function checkPortableTabs(value: unknown): LegacyTab[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) invalid('no contiene áreas.');
  const tabs = value as LegacyTab[];
  for (const tab of tabs) {
    if (!tab || typeof tab.id !== 'string' || typeof tab.name !== 'string' || !Array.isArray(tab.projects) || !Array.isArray(tab.families) || !Array.isArray(tab.labels)) invalid('área mal formada.');
    const taskIds = new Set(tab.projects.flatMap((p) => (Array.isArray(p.tasks) ? p.tasks : invalid('proyecto sin tareas.')).map((t) => t.id)));
    for (const project of tab.projects) {
      checkRefs(project.ownSpaces, project.ownTrades, project.ownPeople, project.ownerPerson);
      for (const task of project.tasks) {
        if ((task.dependsOn ?? []).some((d) => !taskIds.has(d))) reject(422, 'UNRESOLVED_DEPENDENCIES', 'La copia tiene dependencias hacia tareas que no incluye.', { taskId: task.id });
        checkRefs(task.spaces, task.trades, task.people, task.ownerPerson);
      }
    }
  }
  return tabs;
}

/** Espacios y oficios: listas de uuid; personas y responsable: id de persona o `level:<nivel>`. Todo opcional. */
function checkRefs(spaces: unknown, trades: unknown, people: unknown, owner: unknown): void {
  const ids = (list: unknown) => list === undefined || (Array.isArray(list) && list.length <= 200 && list.every((x) => typeof x === 'string' && UUID.test(x)));
  if (!ids(spaces) || !ids(trades)) invalid('espacios u oficios mal formados.');
  if (people !== undefined && !(Array.isArray(people) && people.length <= 200 && people.every(isPersonKey))) invalid('personas mal formadas.');
  if (owner !== undefined && owner !== null && !isPersonKey(owner)) invalid('responsable mal formado.');
}

/** Todos los ids de entidad del modelo (áreas, familias, etiquetas, vistas, proyectos, tareas y adjuntos). */
export function collectIds(tabs: readonly LegacyTab[], comments: readonly PortableComment[] = []): string[] {
  const ids = new Set<string>(comments.map((c) => c.id));
  for (const tab of tabs) {
    ids.add(tab.id);
    for (const f of tab.families ?? []) ids.add(`${tab.id}|${f.id}`);
    for (const l of tab.labels ?? []) ids.add(l.id);
    for (const v of tab.views ?? []) ids.add(v.id);
    for (const p of tab.projects ?? []) {
      ids.add(p.id);
      for (const a of p.attachments ?? []) ids.add(a.id);
      for (const t of p.tasks ?? []) { ids.add(t.id); for (const a of t.attachments ?? []) ids.add(a.id); }
    }
  }
  return [...ids];
}

/**
 * Copia del modelo con todos los ids sustituidos según `map` (construido con `collectIds`). Las familias se identifican
 * por área (`<área>|<familia>`) porque las copias antiguas repiten los ids fijos `person`, `trade`… en cada área.
 */
export function remapTabs(tabs: readonly LegacyTab[], map: ReadonlyMap<string, Uuid>, suffix = ' (copia)'): LegacyTab[] {
  const get = (id: string | null | undefined): Uuid | null => (id ? map.get(id) ?? null : null);
  const SYSTEM = ['person', 'trade', 'phase', 'building', 'space'];
  // Espacios, oficios y personas son de Recursos y de Central: viajan tal cual (si ya no existen, los quita la importación).
  const EXTERNAL = ['_space', '_trade', '_person'];
  const FIXED = ['project', 'state', ...EXTERNAL];
  return tabs.map((tab) => {
    const family = (id: string): Uuid => map.get(`${tab.id}|${id}`) ?? invalid('familia desconocida.');
    return {
      ...tab, id: get(tab.id)!, name: tab.name + suffix, restricted: undefined,
      families: (tab.families ?? []).map((f) => ({ ...f, id: family(f.id), system: f.system ?? (SYSTEM.includes(f.id) ? f.id : null) })),
      labels: (tab.labels ?? []).map((l) => ({ ...l, id: get(l.id)!, family: family(l.family), parent: get(l.parent) })),
      views: (tab.views ?? []).map((v) => ({
        ...v, id: get(v.id)!, groupBy: FIXED.includes(v.groupBy) ? v.groupBy : family(v.groupBy),
        filters: Object.fromEntries(Object.entries(v.filters ?? {}).map(([key, ids]) => (key === '_state' || key === '_availability' || key === '_priority' || EXTERNAL.includes(key) ? [key, ids]
          : key === '_project' ? [key, ids.map((x) => get(x)).filter(Boolean) as string[]]
          // «Sin…» mezcla etiquetas (se reasignan) con espacios, oficios y personas (viajan tal cual).
          : key === '_exclude' ? [key, ids.map((x) => get(x) ?? x)]
          : [family(key), ids.map((x) => get(x)).filter(Boolean) as string[]]))),
      })),
      projects: (tab.projects ?? []).map((p) => ({
        ...p, id: get(p.id)!, owner: get(p.owner), ownLabels: (p.ownLabels ?? []).map((x) => get(x)).filter(Boolean) as string[],
        attachments: (p.attachments ?? []).map((a) => ({ ...a, id: get(a.id)! })),
        tasks: (p.tasks ?? []).map((t) => ({
          ...t, id: get(t.id)!, parentId: get(t.parentId), owner: get(t.owner), labels: (t.labels ?? []).map((x) => get(x)).filter(Boolean) as string[],
          dependsOn: (t.dependsOn ?? []).map((x) => get(x) ?? invalid('dependencia sin resolver.')),
          attachments: (t.attachments ?? []).map((a) => ({ ...a, id: get(a.id)! })),
        })),
      })),
    };
  });
}

/** Copia de los comentarios con sus ids y los de sus tareas sustituidos según `map`. */
export function remapComments(comments: readonly PortableComment[], map: ReadonlyMap<string, Uuid>): PortableComment[] {
  return comments.map((c) => ({ ...c, id: map.get(c.id) ?? invalid('comentario sin id.'), taskId: map.get(c.taskId) ?? invalid('comentario de una tarea desconocida.') }));
}

export interface PortableSummary {
  tabs: Array<{ name: string; projects: number; tasks: number; labels: number }>;
  attachments: number;
  /** Cuántos distintos trae la copia (2c); una copia anterior da ceros y `settings` nulo. */
  spaces: number; trades: number; people: number; comments: number;
  settings: PortableSettings | null;
}

type Refs = { ownSpaces?: string[]; ownTrades?: string[]; ownPeople?: string[]; spaces?: string[]; trades?: string[]; people?: string[]; ownerPerson?: string | null };

export function portableSummary(tabs: readonly LegacyTab[], extra: { comments?: readonly PortableComment[]; settings?: PortableSettings | null } = {}): PortableSummary {
  const items: Refs[] = tabs.flatMap((t) => t.projects.flatMap((p) => [p as Refs, ...(p.tasks as Refs[])]));
  const distinct = (pick: (x: Refs) => ReadonlyArray<string | null | undefined>) => new Set(items.flatMap(pick).filter(Boolean)).size;
  return {
    tabs: tabs.map((t) => ({ name: t.name, projects: t.projects.length, tasks: t.projects.reduce((n, p) => n + p.tasks.length, 0), labels: (t.labels ?? []).length })),
    attachments: tabs.reduce((n, t) => n + t.projects.reduce((m, p) => m + (p.attachments ?? []).length + p.tasks.reduce((k, x) => k + (x.attachments ?? []).length, 0), 0), 0),
    spaces: distinct((x) => [...(x.ownSpaces ?? []), ...(x.spaces ?? [])]),
    trades: distinct((x) => [...(x.ownTrades ?? []), ...(x.trades ?? [])]),
    people: distinct((x) => [...(x.ownPeople ?? []), ...(x.people ?? []), x.ownerPerson]),
    comments: (extra.comments ?? []).length,
    settings: extra.settings ?? null,
  };
}

const SOURCE_NAMES: Record<keyof PortableSettings, Record<string, string>> = {
  zoneSource: { labels: 'zonas (etiquetas)', spaces: 'espacios de Recursos', what: 'los espacios' },
  tradeSource: { labels: 'acciones (etiquetas)', central: 'oficios de Central', what: 'los oficios' },
  peopleSource: { labels: 'personas como etiquetas', central: 'personas de Central', what: 'las personas de Central' },
};

/**
 * Avisos de la importación para la persona: lo que se quitó porque ya no existe («3 espacios, 1 oficio y 2 personas que ya
 * no existen se han quitado.») y, si la copia viene de una instalación con otras fuentes, que esos datos se guardan pero
 * no se ven hasta cambiar de modo. Los ajustes de esta instalación nunca cambian al importar.
 */
export function importNotices(dropped: { spaces?: readonly string[]; trades?: readonly string[]; people?: readonly string[] } | null | undefined, from: PortableSettings | null, here: PortableSettings): string[] {
  const out: string[] = [];
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [
    dropped?.spaces?.length ? n(dropped.spaces.length, 'espacio', 'espacios') : '',
    dropped?.trades?.length ? n(dropped.trades.length, 'oficio', 'oficios') : '',
    dropped?.people?.length ? n(dropped.people.length, 'persona', 'personas') : '',
  ].filter(Boolean);
  if (parts.length) {
    const total = (dropped?.spaces?.length ?? 0) + (dropped?.trades?.length ?? 0) + (dropped?.people?.length ?? 0);
    const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' y ' + parts.at(-1);
    out.push(`${list} que ya no ${total === 1 ? 'existe se ha quitado' : 'existen se han quitado'}.`);
  }
  if (from) {
    for (const key of ['zoneSource', 'tradeSource', 'peopleSource'] as const) {
      if (from[key] === here[key] || from[key] === 'labels') continue;
      const names = SOURCE_NAMES[key];
      out.push(`La copia usa ${names[from[key]]} y esta app usa ${names[here[key]]}: ${names.what} de la copia se guardan, pero no se ven hasta cambiar de modo.`);
    }
  }
  return out;
}

/**
 * Filas para `tasks.import_rows` a partir del modelo ya remapeado. `fileIds` da el `file_id` de cada huella.
 * Lo que estaba en la papelera se inserta y se marca `deleted`. `newId` da los ids de las filas puente.
 */
export type ImportRow = { id: string; fields: Record<string, unknown>; deleted?: boolean; meta?: Record<string, unknown> };
export function importRows(tabs: LegacyTab[], fileIds: ReadonlyMap<string, Uuid>, newId: () => Uuid = () => crypto.randomUUID(), comments: readonly PortableComment[] = []): Record<string, ImportRow[]> {
  const [inserts = [], deletes = []] = decompose(emptyDataset(), tabs, newId);
  const deleted = new Set(deletes.filter((op) => op.op === 'delete').map((op) => `${op.table}|${op.id}`));
  const rows: Record<string, ImportRow[]> = {};
  for (const op of inserts) {
    if (op.op !== 'insert' || !op.table || !(TABLES as readonly string[]).includes(op.table)) invalid('operación inesperada.');
    const fields = { ...op.fields };
    const marker = fields.file_id as { $blob?: string } | undefined;
    if (marker && typeof marker === 'object') fields.file_id = fileIds.get(marker.$blob ?? '') ?? invalid('falta un archivo adjunto.');
    (rows[op.table!] ??= []).push({ id: op.id!, fields, ...(deleted.has(`${op.table}|${op.id}`) ? { deleted: true } : {}) });
  }
  // Comentarios (2c): no están en el modelo; van detrás de todo, con el autor y la hora de la copia en `meta`.
  const where = new Map(tabs.flatMap((t) => t.projects.flatMap((p) => p.tasks.map((x) => [x.id, { tab: t.id, project: p.id }] as const))));
  for (const c of comments) {
    const at = where.get(c.taskId) ?? invalid('comentario de una tarea desconocida.');
    const file = c.photo ? fileIds.get(c.photo.sha256) ?? invalid('falta la foto de un comentario.') : null;
    (rows['tasks.task_comments'] ??= []).push({ id: c.id, fields: { tab_id: at.tab, project_id: at.project, task_id: c.taskId, body: c.body, file_id: file }, meta: { author_id: c.authorId, author_name: c.authorName, created_at: c.createdAt } });
  }
  return rows;
}
