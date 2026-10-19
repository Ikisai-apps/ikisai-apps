/**
 * Tasks · CSV de tareas (docs/tasks/API.md §6). Mismo formato que la app anterior: una fila por tarea, un nivel de hijas,
 * etiquetas como objetos `{family, text}` en JSON. Importar es editar el modelo anidado del área (proyectos nuevos con
 * el sufijo «(CSV)»); las operaciones salen después de `decompose`, como cualquier otro guardado.
 *
 * 2c (R2/P2): con cada fuente activa (`zone_source = 'spaces'`, `trade_source` o `people_source = 'central'`) se añaden al
 * final las columnas «Espacio», «Oficio» y «Personas»: la ruta corta del espacio, la ruta del oficio, y el nombre con las
 * iniciales de la persona («Lucía Prueba (LP)») o el grupo («Todo el staff»), separados por « | ». En modo personas, un
 * responsable persona o grupo va en `owner` como ese mismo texto (sin JSON). Sin fuentes activas, el CSV es el de siempre.
 */
import { reject, type Uuid } from './types.ts';
import type { LegacyFamily, LegacyLabel, LegacyProject, LegacyTab, LegacyTask } from './legacy.ts';

export const CSV_COLUMNS = ['project', 'task_id', 'parent_id', 'text', 'note', 'done', 'priority', 'due', 'labels', 'owner', 'depends_on'];
/** Columnas de la 2c, solo con su fuente activa. Al importar, la cabecera se reconoce sin mayúsculas ni tildes, en singular o plural. */
export const CSV_EXTRA_COLUMNS = { spaces: 'Espacio', trades: 'Oficio', people: 'Personas' } as const;
const EXTRA_HEADERS: Record<string, string> = { espacio: 'Espacio', espacios: 'Espacio', oficio: 'Oficio', oficios: 'Oficio', persona: 'Personas', personas: 'Personas' };
export const CSV_SEPARATOR = ' | ';

/** Un espacio de Recursos: `path`, la ruta corta («Albergue › Hab 3»); `aliases`, otras formas que casan (la ruta entera). */
export interface CsvSpace { id: Uuid; path: string; aliases?: string[]; active?: boolean }
/** Un oficio de Central: `path`, su ruta («Fontanería › ACS»). */
export interface CsvTrade { id: Uuid; path: string; name?: string }
/** Una persona (id de Central) o un grupo (`level:<nivel>`): `label`, lo que sale en el CSV. */
export interface CsvPerson { key: string; label: string; name?: string; initials?: string | null }
/** Los catálogos de las fuentes activas: sin uno, su columna no sale al exportar y se ignora (con aviso) al importar. */
export interface CsvCatalogs { spaces?: CsvSpace[]; trades?: CsvTrade[]; people?: CsvPerson[] }

/** Sin mayúsculas, sin tildes, con « › » como separador de ruta y sin espacios de sobra. */
export function normalizeCsvName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/\s*(›|>|»)\s*/g, ' › ').replace(/\s+/g, ' ').trim();
}

/** Buscador por nombre: casa con cualquiera de las formas de un elemento; una forma que tienen varios no casa. */
function finder(items: ReadonlyArray<{ key: string; names: ReadonlyArray<string | null | undefined> }>): (text: string) => string | null {
  const index = new Map<string, Set<string>>();
  for (const item of items) for (const name of [item.key, ...item.names]) {
    if (!name) continue;
    const k = normalizeCsvName(name);
    if (!index.has(k)) index.set(k, new Set());
    index.get(k)!.add(item.key);
  }
  return (text) => { const hit = index.get(normalizeCsvName(text)); return hit && hit.size === 1 ? [...hit][0]! : null; };
}

const cell = (values: readonly string[]): string => values.join(CSV_SEPARATOR);
const split = (value: string | undefined): string[] => (value ?? '').split('|').map((v) => literal(v.trim())).filter(Boolean);
const invalid = (message: string): never => reject(422, 'INVALID_CSV', 'CSV inválido: ' + message);
/** Evita que una hoja de cálculo interprete el texto como fórmula. */
const safe = (value: unknown): string => { const text = String(value ?? ''); return /^[=+@\-\t\r']/.test(text) ? "'" + text : text; };
const literal = (value: string): string => (/^'[=+@\-\t\r']/.test(value) ? value.slice(1) : value);
const familyRef = (family: LegacyFamily): string => family.system ?? family.name;

export function exportCSV(tab: LegacyTab, catalogs: CsvCatalogs = {}): string {
  const families = new Map(tab.families.map((f) => [f.id, f]));
  const labels = new Map(tab.labels.map((l) => [l.id, l]));
  const label = (id: Uuid) => { const l = labels.get(id); const f = l && families.get(l.family); return l && f ? { family: familyRef(f), text: l.text } : null; };
  // Lo que ya no está en el catálogo sale con su id, que también casa al volver a importar.
  const spaces = catalogs.spaces && new Map(catalogs.spaces.map((x) => [x.id, x.path]));
  const trades = catalogs.trades && new Map(catalogs.trades.map((x) => [x.id, x.path]));
  const people = catalogs.people && new Map(catalogs.people.map((x) => [x.key, x.label]));
  const named = (map: Map<string, string>, ids: readonly string[] | undefined) => safe(cell((ids ?? []).map((id) => map.get(id) ?? id)));
  const rows: string[][] = [[...CSV_COLUMNS, ...(spaces ? [CSV_EXTRA_COLUMNS.spaces] : []), ...(trades ? [CSV_EXTRA_COLUMNS.trades] : []), ...(people ? [CSV_EXTRA_COLUMNS.people] : [])]];
  for (const project of tab.projects.filter((p) => !p.deleted)) {
    for (const task of project.tasks.filter((t) => !t.deleted)) {
      const owner = people && task.ownerPerson ? safe(people.get(task.ownerPerson) ?? task.ownerPerson) : task.owner && label(task.owner) ? JSON.stringify(label(task.owner)) : '';
      rows.push([safe(project.title), task.id, task.parentId ?? '', safe(task.text), safe(task.note), task.done ? '1' : '0', task.priority || 'normal', task.due || '',
        JSON.stringify((task.labels ?? []).map(label).filter(Boolean)), owner, JSON.stringify(task.dependsOn ?? []),
        ...(spaces ? [named(spaces, task.spaces)] : []), ...(trades ? [named(trades, task.trades)] : []), ...(people ? [named(people, task.people)] : [])]);
    }
  }
  return '﻿' + rows.map((row) => row.map((v) => (/[",\r\n]/.test(v) ? '"' + v.replaceAll('"', '""') + '"' : v)).join(',')).join('\r\n') + '\r\n';
}

export function parseCSV(source: string): Array<Record<string, string>> {
  source = source.replace(/^﻿/, '');
  const header = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = (header.match(/;/g) ?? []).length > (header.match(/,/g) ?? []).length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"') { if (source[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c;
      continue;
    }
    if (c === '"') { if (field || closed) invalid('comillas inválidas.'); quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; closed = false; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v !== '')) rows.push(row);
      row = []; field = ''; closed = false;
      continue;
    }
    if (closed) invalid('texto tras el cierre de comillas.');
    field += c;
  }
  if (quoted) invalid('comillas sin cerrar.');
  if (field || row.length) { row.push(field); rows.push(row); }
  const columns = (rows.shift() ?? []).map((c) => (CSV_COLUMNS.includes(c) ? c : EXTRA_HEADERS[normalizeCsvName(c)] ?? c));
  const known = [...CSV_COLUMNS, ...Object.values(CSV_EXTRA_COLUMNS)] as string[];
  if (new Set(columns).size !== columns.length || !columns.includes('project') || !columns.includes('text') || columns.some((c) => !known.includes(c))) invalid('cabeceras project y text obligatorias; formato Ikisai.');
  if (rows.length < 1 || rows.length > 450 || rows.some((r) => r.length !== columns.length)) invalid('entre 1 y 450 tareas con todas las columnas.');
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]!])));
}

export interface CsvImport {
  summary: { tasks: number; projects: number; children: number };
  rows: Array<{ project: string; text: string; child: boolean }>;
  /** Lo que no casa con ningún espacio, oficio o persona (se deja fuera, sin fallar) y las columnas que se ignoran. */
  warnings: string[];
}

const SOURCE_OFF: Record<string, string> = {
  Espacio: 'La columna «Espacio» se ignora: esta app usa zonas (etiquetas).',
  Oficio: 'La columna «Oficio» se ignora: esta app usa acciones (etiquetas).',
  Personas: 'La columna «Personas» se ignora: esta app usa personas como etiquetas.',
};

/** Añade al modelo del área los proyectos, tareas, etiquetas y familias del CSV. Modifica `tab`. */
export function importCSV(tab: LegacyTab, source: string, newId: () => Uuid = () => crypto.randomUUID(), catalogs: CsvCatalogs = {}): CsvImport {
  if (tab.deleted) reject(422, 'TAB_DELETED', 'Restaura el área antes de importar.');
  if (new TextEncoder().encode(source).length > 2 * 1024 * 1024) reject(413, 'PAYLOAD_TOO_LARGE', 'CSV máximo 2 MB.');
  const rows = parseCSV(source);
  const warnings: string[] = [];
  const columns = new Set(Object.keys(rows[0] ?? {}));
  const findSpace = catalogs.spaces && finder(catalogs.spaces.filter((x) => x.active !== false).map((x) => ({ key: x.id, names: [x.path, ...(x.aliases ?? [])] })));
  const findTrade = catalogs.trades && finder(catalogs.trades.map((x) => ({ key: x.id, names: [x.path, x.name] })));
  const findPerson = catalogs.people && finder(catalogs.people.map((x) => ({ key: x.key, names: [x.label, x.name, x.initials] })));
  const active: Record<string, ((text: string) => string | null) | undefined> = { Espacio: findSpace, Oficio: findTrade, Personas: findPerson };
  for (const column of Object.values(CSV_EXTRA_COLUMNS)) if (columns.has(column) && !active[column]) warnings.push(SOURCE_OFF[column]!);
  const WHAT: Record<string, string> = { Espacio: 'ningún espacio', Oficio: 'ningún oficio de Central', Personas: 'ninguna persona de Central' };
  /** Los de una celda que casan; lo que no, a los avisos. `undefined` si la columna no está o su fuente no está activa. */
  const match = (row: Record<string, string>, column: string, line: number): string[] | undefined => {
    const find = active[column];
    if (!find || !(column in row)) return undefined;
    const out: string[] = [];
    for (const value of split(row[column])) {
      const key = find(value);
      if (key) { if (!out.includes(key)) out.push(key); } else warnings.push(`Fila ${line} · ${column}: «${value}» no casa con ${WHAT[column]}; se deja fuera.`);
    }
    return out;
  };
  const families = new Map<string, LegacyFamily>();
  for (const f of tab.families) { families.set(f.id, f); families.set(f.name.trim().toLocaleLowerCase(), f); if (f.system) families.set(f.system, f); }
  const labels = new Map<string, LegacyLabel>(tab.labels.filter((l) => !l.archived).map((l) => [JSON.stringify([l.family, l.text]), l]));
  const json = (value: string | undefined, fallback: unknown): unknown => { try { return value ? JSON.parse(value) : fallback; } catch { return invalid('JSON inválido en etiquetas o dependencias.'); } };

  function label(value: unknown, owner = false): Uuid {
    const v = value as { family?: unknown; text?: unknown } | null;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'family,text' || typeof v.family !== 'string' || typeof v.text !== 'string' || !v.text.trim()) invalid('etiquetas: objetos family/text.');
    const reference = (v!.family as string).trim(), text = (v!.text as string).trim();
    let family = families.get(reference) ?? families.get(reference.toLocaleLowerCase());
    if (owner && family?.system !== 'person') invalid('el responsable debe pertenecer a la familia Persona.');
    if (family?.archived) invalid('desarchiva la familia ' + family.name + '.');
    if (!family) {
      family = { id: newId(), name: reference, color: '#6f5a8f', archived: false, system: null, version: 1 };
      tab.families.push(family); families.set(family.id, family); families.set(reference.toLocaleLowerCase(), family);
    }
    const key = JSON.stringify([family.id, text]);
    let found = labels.get(key);
    if (!found) { found = { id: newId(), text, family: family.id, parent: null, archived: false, version: 1 }; tab.labels.push(found); labels.set(key, found); }
    return found.id;
  }

  const projects = new Map<string, LegacyProject>();
  const taskIds = new Map<string, Uuid>();
  const baseOrder = Math.max(0, ...tab.projects.map((p) => p.order || 0));
  const parsed = rows.map((r, index) => {
    const title = literal(r.project ?? '').trim(), text = literal(r.text ?? '').trim(), sourceId = r.task_id || 'row-' + (index + 1);
    if (!title || !text || taskIds.has(sourceId)) invalid('proyecto o texto vacíos, o task_id duplicado.');
    taskIds.set(sourceId, newId());
    if (!projects.has(title)) {
      const project: LegacyProject = { id: newId(), title: title + ' (CSV)', note: '', status: 'active', priority: 'normal', due: '', ownLabels: [], owner: null, attachments: [], deleted: false, deletedAt: null, order: baseOrder + (projects.size + 1) * 1024, color: null, budget: null, system: null, version: 1, updatedAt: '', tasks: [] };
      projects.set(title, project); tab.projects.push(project);
    }
    const done = (r.done || '0').trim().toLowerCase();
    if (!['', '0', '1', 'true', 'false'].includes(done)) invalid('done: 0/1 o false/true.');
    const priority = (r.priority || 'normal') as LegacyTask['priority'];
    if (!['normal', 'high', 'critical'].includes(priority)) invalid('priority: normal, high o critical.');
    const line = index + 2;
    // En modo personas, el responsable puede venir como texto («Lucía Prueba (LP)», «Todo el staff»); como JSON, es una etiqueta.
    const ownerText = findPerson && r.owner && !r.owner.trim().startsWith('{') ? literal(r.owner.trim()) : null;
    const tags = json(r.labels, []), owner = ownerText ? null : json(r.owner, null);
    if (!Array.isArray(tags)) invalid('labels debe ser una lista JSON.');
    let ownerPerson: string | null = null;
    if (ownerText) { ownerPerson = findPerson!(ownerText); if (!ownerPerson) warnings.push(`Fila ${line} · owner: «${ownerText}» no casa con ninguna persona de Central; queda sin responsable.`); }
    const spaces = match(r, 'Espacio', line), trades = match(r, 'Oficio', line), people = match(r, 'Personas', line);
    const task: LegacyTask = {
      id: taskIds.get(sourceId)!, text, note: literal(r.note ?? ''), done: ['1', 'true'].includes(done), priority, due: r.due || '', labels: (tags as unknown[]).map((v) => label(v)), owner: owner ? label(owner, true) : null,
      parentId: null, order: (index + 1) * 1024, attachments: [], deleted: false, deletedAt: null, deleteBatch: null, dependsOn: [], cost: null, version: 1, updatedAt: '',
      ...(spaces?.length ? { spaces } : {}), ...(trades?.length ? { trades } : {}), ...(people?.length ? { people } : {}), ...(ownerPerson ? { ownerPerson } : {}),
    };
    return { sourceId, parent: r.parent_id || null, title, task, deps: r.depends_on };
  });
  const bySource = new Map(parsed.map((p) => [p.sourceId, p]));
  for (const item of parsed) {
    const deps = json(item.deps, []);
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !taskIds.has(d)) || new Set(deps).size !== deps.length) invalid('dependencias sin resolver o duplicadas.');
    const parent = item.parent ? bySource.get(item.parent) : undefined;
    if (item.parent && (!parent || parent.parent || parent.title !== item.title || parent === item)) invalid('solo un nivel de hijas en el mismo proyecto.');
    item.task.parentId = parent ? parent.task.id : null;
    item.task.dependsOn = (deps as string[]).map((d) => taskIds.get(d)!);
    projects.get(item.title)!.tasks.push(item.task);
  }
  return {
    summary: { tasks: parsed.length, projects: projects.size, children: parsed.filter((p) => p.parent).length },
    rows: parsed.map((p) => ({ project: p.title, text: p.task.text, child: !!p.parent })),
    warnings,
  };
}
