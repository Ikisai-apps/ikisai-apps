/**
 * Espacios comunes (módulo `resources`, diseño RECURSOS.md §4.1 y §11.1): forma de la fila, tipos con su nivel y sus
 * padres, reglas de colocación, ruta («Altura 2 › Albergue › Hab 3»), descendientes y una fuente de datos en memoria
 * para la demo y las pruebas. Los componentes (`createSpaceTree`, `createSpacePicker`) trabajan contra `SpaceSource`,
 * que en las apps será el `sync-client` de `resources-api` (sin red: escribe en su cola local).
 */
import { kt } from '../i18n/i18n.ts';
import { normalizeName } from '../fields/suggest.ts';

export interface SpaceRow {
  id: string;
  parentId: string | null;
  kind: string;
  name: string;
  publicName: string | null;
  code: string | null;
  position: number;
  active: boolean;
  notes: string | null;
  attributes: Record<string, unknown>;
  /** Cambio local aún sin confirmar por el servidor (lo marca la fuente). */
  pending?: boolean;
}

export type SpaceAttribute =
  | { key: string; label: string; type: 'boolean' }
  | { key: string; label: string; type: 'number'; min?: number }
  | { key: string; label: string; type: 'choice'; options: Array<{ value: string; label: string }> };

export interface SpaceKind {
  kind: string;
  label: string;
  /** 1 altura · 2 edificio o exterior · 3 espacio · 4 subespacio. El tipo fija el nivel. */
  level: 1 | 2 | 3 | 4;
  /** Tipos de los que puede colgar; sin lista, cualquiera del nivel anterior (o la raíz si es el nivel 1). */
  parents?: string[];
  attributes?: SpaceAttribute[];
}

const BOOKING: SpaceAttribute[] = [
  { key: 'bookable', label: 'Reservable', type: 'boolean' },
  { key: 'capacity', label: 'Capacidad', type: 'number', min: 0 },
  { key: 'accessible', label: 'Accesible', type: 'boolean' },
];
const STORAGE: SpaceAttribute = { key: 'storage', label: 'Conservación', type: 'choice', options: [{ value: 'ambiente', label: 'Ambiente' }, { value: 'frio', label: 'Frío' }, { value: 'congelado', label: 'Congelado' }] };

/** Tipos de partida (RECURSOS.md §11.1). `resources-api` los dará como datos (`space_kinds`); hasta entonces, estos. */
export const DEFAULT_SPACE_KINDS: SpaceKind[] = [
  { kind: 'altura', label: 'Altura', level: 1 },
  { kind: 'edificio', label: 'Edificio', level: 2 },
  { kind: 'exterior', label: 'Exterior', level: 2, attributes: BOOKING },
  { kind: 'habitacion', label: 'Habitación', level: 3, attributes: [...BOOKING, { key: 'en_suite', label: 'Baño propio', type: 'boolean' }] },
  { kind: 'sala', label: 'Sala', level: 3, attributes: BOOKING },
  { kind: 'bano', label: 'Baño', level: 3 },
  { kind: 'cocina', label: 'Cocina', level: 3 },
  { kind: 'comedor', label: 'Comedor', level: 3, attributes: BOOKING },
  { kind: 'oficina', label: 'Oficina', level: 3 },
  { kind: 'zona_paso', label: 'Zona de paso', level: 3 },
  { kind: 'instalacion', label: 'Instalación', level: 3 },
  { kind: 'almacen', label: 'Almacén', level: 3, attributes: [STORAGE] },
  { kind: 'otro', label: 'Otro', level: 3 },
  { kind: 'cama', label: 'Cama', level: 4, parents: ['habitacion'], attributes: [{ key: 'bed_kind', label: 'Tipo de cama', type: 'choice', options: [{ value: 'individual', label: 'Individual' }, { value: 'doble', label: 'Doble' }, { value: 'litera', label: 'Litera' }] }, { key: 'capacity', label: 'Plazas', type: 'number', min: 0 }] },
  { kind: 'ubicacion', label: 'Ubicación', level: 4, parents: ['almacen', 'cocina', 'instalacion', 'otro', 'comedor'], attributes: [STORAGE] },
];

export interface SpaceSource {
  /** Todas las filas (activas y archivadas). */
  list(): SpaceRow[] | Promise<SpaceRow[]>;
  /** Avisa con todas las filas cuando cambian (también por cambios de otros); devuelve la baja. */
  subscribe(listener: (rows: SpaceRow[]) => void): () => void;
  create(row: SpaceRow): Promise<void> | void;
  /** Varias altas en un lote («Duplicar» con sus camas). */
  createMany(rows: SpaceRow[]): Promise<void> | void;
  /** Editar y mover (`{ parentId, position }`). */
  update(id: string, fields: Partial<Omit<SpaceRow, 'id'>>): Promise<void> | void;
  /** Archivar (el servidor puede negarse y devolver el motivo: reservas futuras, stock, tareas abiertas). */
  archive(ids: string[]): Promise<void> | void;
  restore(ids: string[]): Promise<void> | void;
}

export const kindOf = (kinds: readonly SpaceKind[], kind: string): SpaceKind | undefined => kinds.find((k) => k.kind === kind);

export function kindLabel(kinds: readonly SpaceKind[], kind: string): string {
  return kt(kindOf(kinds, kind)?.label ?? kind);
}

/** Mapa id → fila. */
export function indexSpaces(rows: readonly SpaceRow[]): Map<string, SpaceRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

/** Hijos de `parentId` (o de la raíz), en su orden. */
export function childrenOf(rows: readonly SpaceRow[], parentId: string | null, includeArchived = false): SpaceRow[] {
  return rows.filter((r) => r.parentId === parentId && (includeArchived || r.active)).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** Antepasados de una fila, del más alto al padre. */
export function ancestorsOf(rows: readonly SpaceRow[] | Map<string, SpaceRow>, id: string): SpaceRow[] {
  const byId = rows instanceof Map ? rows : indexSpaces(rows);
  const out: SpaceRow[] = [];
  const seen = new Set<string>([id]);
  let parent = byId.get(id)?.parentId ?? null;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const row = byId.get(parent);
    if (!row) break;
    out.unshift(row);
    parent = row.parentId;
  }
  return out;
}

/** Ruta legible: «Altura 2 › Albergue › Hab 3». */
export function spacePath(rows: readonly SpaceRow[] | Map<string, SpaceRow>, id: string): string {
  const byId = rows instanceof Map ? rows : indexSpaces(rows);
  const row = byId.get(id);
  if (!row) return '';
  return [...ancestorsOf(byId, id), row].map((r) => r.name).join(' › ');
}

/** Ids de todo lo que hay dentro (sin la propia fila). Para filtrar «Albergue» con sus habitaciones. */
export function spaceDescendants(rows: readonly SpaceRow[], id: string, includeArchived = false): string[] {
  const out: string[] = [];
  const stack = [id];
  const seen = new Set<string>([id]);
  while (stack.length) {
    const current = stack.pop()!;
    for (const child of rows) {
      if (child.parentId !== current || seen.has(child.id) || (!includeArchived && !child.active)) continue;
      seen.add(child.id);
      out.push(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

export type Placement = { ok: true } | { ok: false; reason: string };

/**
 * ¿Puede ir un espacio de tipo `kind` dentro de `parent` (null = raíz)? Reglas de RECURSOS.md §4.1: el tipo fija el
 * nivel; una altura solo en la raíz; una cama solo en una habitación; una ubicación en almacén, cocina, instalación,
 * comedor u otro; sin ciclos (`movingId`). `legacyRoot`: durante la migración, un edificio o exterior sin altura.
 */
export function canPlace(kinds: readonly SpaceKind[], kind: string, parent: SpaceRow | null, options: { rows?: readonly SpaceRow[]; movingId?: string; legacyRoot?: boolean } = {}): Placement {
  const k = kindOf(kinds, kind);
  if (!k) return { ok: false, reason: kt('Tipo desconocido: {kind}.', { kind }) };
  if (!parent) {
    if (k.level === 1) return { ok: true };
    if (k.level === 2 && options.legacyRoot) return { ok: true };
    return { ok: false, reason: k.level === 2 ? kt('Un edificio o un exterior va dentro de una altura.') : kt('«{kind}» no puede ir fuera de un edificio o exterior.', { kind: kt(k.label) }) };
  }
  if (options.movingId && (parent.id === options.movingId || (options.rows && ancestorsOf(options.rows, parent.id).some((a) => a.id === options.movingId)))) {
    return { ok: false, reason: kt('Un espacio no puede ir dentro de sí mismo.') };
  }
  const p = kindOf(kinds, parent.kind);
  if (k.level === 1) return { ok: false, reason: kt('Una altura solo va en la raíz.') };
  if (k.parents?.length) {
    if (!k.parents.includes(parent.kind)) {
      if (kind === 'cama') return { ok: false, reason: kt('Una cama solo va dentro de una habitación.') };
      return { ok: false, reason: kt('«{kind}» no puede ir dentro de «{parent}».', { kind: kt(k.label), parent: kt(p?.label ?? parent.kind) }) };
    }
    return { ok: true };
  }
  if (!p || p.level !== k.level - 1) return { ok: false, reason: kt('«{kind}» no puede ir dentro de «{parent}».', { kind: kt(k.label), parent: kt(p?.label ?? parent.kind) }) };
  return { ok: true };
}

/** Tipos que se pueden crear dentro de `parent` (null = raíz). */
export function kindsFor(kinds: readonly SpaceKind[], parent: SpaceRow | null): SpaceKind[] {
  return kinds.filter((k) => canPlace(kinds, k.kind, parent).ok);
}

/** Primer número libre de altura (1–5), o null si ya están las cinco. */
export function nextAltura(rows: readonly SpaceRow[]): number | null {
  const used = new Set(rows.filter((r) => r.kind === 'altura' && r.active).map((r) => Number(/(\d+)/.exec(r.name)?.[1])));
  for (let n = 1; n <= 5; n += 1) if (!used.has(n)) return n;
  return null;
}

/** Coincide con la búsqueda (nombre, nombre público, código o ruta), sin mayúsculas ni tildes. */
export function spaceMatches(rows: Map<string, SpaceRow>, row: SpaceRow, query: string): boolean {
  const words = normalizeName(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  // Cada palabra en el nombre, el nombre público, el código o la ruta («albergue hab 3»).
  const haystack = normalizeName([row.name, row.publicName ?? '', row.code ?? '', spacePath(rows, row.id)].join(' '));
  return words.every((w) => haystack.includes(w));
}

let seq = 0;
/** Id nuevo (uuid si el navegador lo da). */
export function newSpaceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `space-${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

/** Fuente en memoria (demo y pruebas). `delay` simula la latencia; `failArchive` simula una negativa del servidor. */
export function createMemorySpaceSource(initial: SpaceRow[], options: { delay?: number; failArchive?: (ids: string[], rows: SpaceRow[]) => string | null } = {}): SpaceSource & { rows(): SpaceRow[] } {
  let rows = initial.map((r) => ({ ...r, attributes: { ...r.attributes } }));
  const listeners = new Set<(rows: SpaceRow[]) => void>();
  const emit = () => { const copy = rows.map((r) => ({ ...r })); listeners.forEach((l) => l(copy)); };
  const wait = () => (options.delay ? new Promise<void>((r) => setTimeout(r, options.delay)) : Promise.resolve());
  return {
    rows: () => rows.map((r) => ({ ...r })),
    list: () => rows.map((r) => ({ ...r })),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async create(row) { await wait(); rows = [...rows, { ...row }]; emit(); },
    async createMany(list) { await wait(); rows = [...rows, ...list.map((r) => ({ ...r }))]; emit(); },
    async update(id, fields) { await wait(); rows = rows.map((r) => (r.id === id ? { ...r, ...fields } : r)); emit(); },
    async archive(ids) {
      await wait();
      const refused = options.failArchive?.(ids, rows);
      if (refused) throw new Error(refused);
      rows = rows.map((r) => (ids.includes(r.id) ? { ...r, active: false } : r));
      emit();
    },
    async restore(ids) { await wait(); rows = rows.map((r) => (ids.includes(r.id) ? { ...r, active: true } : r)); emit(); },
  };
}

const row = (id: string, parentId: string | null, kind: string, name: string, position: number, extra: Partial<SpaceRow> = {}): SpaceRow => ({ id, parentId, kind, name, publicName: null, code: null, position, active: true, notes: null, attributes: {}, ...extra });

/** Datos de demo: las cinco alturas del usuario (con su descripción en `notes`) y algo dentro de cada una. */
export function demoSpaces(): SpaceRow[] {
  return [
    row('alt-1', null, 'altura', 'Altura 1', 1024, { notes: 'Edificio de salas' }),
    row('alt-2', null, 'altura', 'Altura 2', 2048, { notes: 'Entre edificios' }),
    row('alt-3', null, 'altura', 'Altura 3', 3072, { notes: 'Albergue' }),
    row('alt-4', null, 'altura', 'Altura 4', 4096, { notes: 'Piscina' }),
    row('alt-5', null, 'altura', 'Altura 5', 5120, { notes: 'Depósito' }),
    row('ed-salas', 'alt-1', 'edificio', 'Edificio de salas', 1024),
    row('sala-roble', 'ed-salas', 'sala', 'Sala Roble', 1024, { attributes: { bookable: true, capacity: 30, accessible: true } }),
    row('sala-olivo', 'ed-salas', 'sala', 'Sala Olivo', 2048, { attributes: { bookable: true, capacity: 12 } }),
    row('cocina', 'ed-salas', 'cocina', 'Cocina', 3072),
    row('despensa', 'cocina', 'ubicacion', 'Despensa', 1024, { attributes: { storage: 'ambiente' } }),
    row('camara', 'cocina', 'ubicacion', 'Cámara', 2048, { attributes: { storage: 'frio' } }),
    row('jardin', 'alt-2', 'exterior', 'Jardín', 1024),
    row('albergue', 'alt-3', 'edificio', 'Albergue', 1024),
    row('hab-1', 'albergue', 'habitacion', 'Hab 1', 1024, { publicName: 'Habitación 1', attributes: { bookable: true, capacity: 2, en_suite: true } }),
    row('hab-1-c1', 'hab-1', 'cama', 'Cama 1', 1024, { attributes: { bed_kind: 'doble', capacity: 2 } }),
    row('hab-3', 'albergue', 'habitacion', 'Hab 3', 2048, { publicName: 'Habitación 3', attributes: { bookable: true, capacity: 4 } }),
    row('hab-3-c1', 'hab-3', 'cama', 'Cama 1', 1024, { attributes: { bed_kind: 'litera', capacity: 2 } }),
    row('hab-3-c2', 'hab-3', 'cama', 'Cama 2', 2048, { attributes: { bed_kind: 'litera', capacity: 2 } }),
    row('banos-alb', 'albergue', 'bano', 'Baños', 3072),
    row('piscina', 'alt-4', 'exterior', 'Piscina', 1024),
    row('ext-deposito', 'alt-5', 'exterior', 'Zona del depósito', 1024),
    row('deposito', 'ext-deposito', 'instalacion', 'Depósito de agua', 1024),
    // Migración: un exterior todavía sin altura (grupo «Sin altura»).
    row('huerto', null, 'exterior', 'Huerto', 9000),
  ];
}
