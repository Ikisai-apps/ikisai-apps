/**
 * Tasks · copia portable (docs/tasks/API.md §6). El contenido viaja como el modelo anidado de la interfaz
 * (`data.json` → `{ tabs }`) más los archivos adjuntos por huella. Importar crea áreas nuevas con ids independientes:
 * se remapean todos los ids y el resultado pasa por `decompose` contra un conjunto vacío.
 */
import { decompose, type LegacyTab } from './legacy.ts';
import { emptyDataset, reject, TABLES, type Uuid } from './types.ts';

export const PORTABLE_FORMAT = 'ikisai.tasks.portable.v2';

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
      for (const task of project.tasks) {
        if ((task.dependsOn ?? []).some((d) => !taskIds.has(d))) reject(422, 'UNRESOLVED_DEPENDENCIES', 'La copia tiene dependencias hacia tareas que no incluye.', { taskId: task.id });
      }
    }
  }
  return tabs;
}

/** Todos los ids de entidad del modelo (áreas, familias, etiquetas, vistas, proyectos, tareas y adjuntos). */
export function collectIds(tabs: readonly LegacyTab[]): string[] {
  const ids = new Set<string>();
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
  return tabs.map((tab) => {
    const family = (id: string): Uuid => map.get(`${tab.id}|${id}`) ?? invalid('familia desconocida.');
    return {
      ...tab, id: get(tab.id)!, name: tab.name + suffix, restricted: undefined,
      families: (tab.families ?? []).map((f) => ({ ...f, id: family(f.id), system: f.system ?? (SYSTEM.includes(f.id) ? f.id : null) })),
      labels: (tab.labels ?? []).map((l) => ({ ...l, id: get(l.id)!, family: family(l.family), parent: get(l.parent) })),
      views: (tab.views ?? []).map((v) => ({
        ...v, id: get(v.id)!, groupBy: ['project', 'state'].includes(v.groupBy) ? v.groupBy : family(v.groupBy),
        filters: Object.fromEntries(Object.entries(v.filters ?? {}).map(([key, ids]) => (key === '_state' || key === '_availability' ? [key, ids] : key === '_project' ? [key, ids.map((x) => get(x)).filter(Boolean) as string[]] : [family(key), ids.map((x) => get(x)).filter(Boolean) as string[]]))),
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

export function portableSummary(tabs: readonly LegacyTab[]): { tabs: Array<{ name: string; projects: number; tasks: number; labels: number }>; attachments: number } {
  return {
    tabs: tabs.map((t) => ({ name: t.name, projects: t.projects.length, tasks: t.projects.reduce((n, p) => n + p.tasks.length, 0), labels: (t.labels ?? []).length })),
    attachments: tabs.reduce((n, t) => n + t.projects.reduce((m, p) => m + (p.attachments ?? []).length + p.tasks.reduce((k, x) => k + (x.attachments ?? []).length, 0), 0), 0),
  };
}

/**
 * Filas para `tasks.import_rows` a partir del modelo ya remapeado. `fileIds` da el `file_id` de cada huella.
 * Lo que estaba en la papelera se inserta y se marca `deleted`. `newId` da los ids de las filas puente.
 */
export function importRows(tabs: LegacyTab[], fileIds: ReadonlyMap<string, Uuid>, newId: () => Uuid = () => crypto.randomUUID()): Record<string, Array<{ id: string; fields: Record<string, unknown>; deleted?: boolean }>> {
  const [inserts = [], deletes = []] = decompose(emptyDataset(), tabs, newId);
  const deleted = new Set(deletes.filter((op) => op.op === 'delete').map((op) => `${op.table}|${op.id}`));
  const rows: Record<string, Array<{ id: string; fields: Record<string, unknown>; deleted?: boolean }>> = {};
  for (const op of inserts) {
    if (op.op !== 'insert' || !op.table || !(TABLES as readonly string[]).includes(op.table)) invalid('operación inesperada.');
    const fields = { ...op.fields };
    const marker = fields.file_id as { $blob?: string } | undefined;
    if (marker && typeof marker === 'object') fields.file_id = fileIds.get(marker.$blob ?? '') ?? invalid('falta un archivo adjunto.');
    (rows[op.table!] ??= []).push({ id: op.id!, fields, ...(deleted.has(`${op.table}|${op.id}`) ? { deleted: true } : {}) });
  }
  return rows;
}
