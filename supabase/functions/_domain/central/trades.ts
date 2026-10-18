/**
 * Ikisai Central · importar el catálogo de oficios desde la familia «Tipo: Acción» de Tasks (fase P1, RECURSOS.md §13.3), con
 * vista previa. Lee `tasks.action_labels` (etiquetas vivas de esa familia en cada área y en General, con su madre y si están
 * archivadas). Las etiquetas de Tasks no se tocan: eso es la fase P2.
 *
 * - Las etiquetas repetidas entre áreas («Fontanería» en Albergue y en Casa) son un solo oficio: se juntan por su ruta de
 *   nombres, sin mirar mayúsculas, tildes ni espacios de los lados.
 * - Un oficio que ya existe en Central (por la etiqueta de la que vino o por la misma ruta) no se vuelve a crear.
 * - `source_label_id` guarda una etiqueta de origen por oficio (la de General si la hay); P2 casará las demás por la ruta.
 */
export interface ActionLabel {
  label_id: string;
  parent_id: string | null;
  name: string;
  position: number | string | null;
  archived: boolean;
  tab_id: string | null;
}

export interface ExistingTrade { id: string; parent_id: string | null; name: string; source_label_id: string | null; deleted_at?: string | null }

export interface ImportNode {
  /** Ruta normalizada: clave del oficio en la vista previa. */
  key: string;
  parentKey: string | null;
  name: string;
  path: string;
  depth: number;
  position: number;
  labelIds: string[];
  /** Etiqueta de origen que se guarda en el oficio. */
  sourceLabelId: string;
  /** En cuántas áreas aparece (General cuenta como una). */
  areas: number;
  /** Todas sus etiquetas están archivadas en Tasks. */
  archived: boolean;
  /** Oficio de Central que ya le corresponde, si existe. */
  existingId: string | null;
}

const norm = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');

/** Árbol de la importación en orden (madres antes que hijas), con lo que ya existe en Central marcado. */
export function planTradeImport(labels: readonly ActionLabel[], trades: readonly ExistingTrade[]): ImportNode[] {
  const byId = new Map(labels.map((l) => [l.label_id, l]));
  const pathOf = (l: ActionLabel, seen = new Set<string>()): string[] => {
    const parent = l.parent_id ? byId.get(l.parent_id) : undefined;
    if (!parent || seen.has(parent.label_id)) return [l.name.trim()];
    seen.add(l.label_id);
    return [...pathOf(parent, seen), l.name.trim()];
  };

  // Rutas de lo que ya hay en Central, para no duplicar.
  const alive = trades.filter((t) => !t.deleted_at);
  const tradeById = new Map(alive.map((t) => [t.id, t]));
  const tradePath = (t: ExistingTrade, depth = 0): string[] => {
    const parent = t.parent_id ? tradeById.get(t.parent_id) : undefined;
    return parent && depth < 5 ? [...tradePath(parent, depth + 1), t.name] : [t.name];
  };
  const existingByKey = new Map(alive.map((t) => [tradePath(t).map(norm).join(' › '), t.id]));
  const existingBySource = new Map(alive.filter((t) => t.source_label_id).map((t) => [t.source_label_id!, t.id]));

  const nodes = new Map<string, ImportNode>();
  for (const l of labels) {
    const parts = pathOf(l);
    const key = parts.map(norm).join(' › ');
    const node = nodes.get(key) ?? {
      key, parentKey: parts.length > 1 ? parts.slice(0, -1).map(norm).join(' › ') : null, name: parts[parts.length - 1]!, path: parts.join(' › '),
      depth: parts.length - 1, position: Number(l.position ?? 0) || 0, labelIds: [], sourceLabelId: l.label_id, areas: 0, archived: true, existingId: null,
    };
    node.labelIds.push(l.label_id);
    node.archived = node.archived && l.archived;
    if (l.tab_id === null) node.sourceLabelId = l.label_id; // la de General, si la hay
    node.existingId ??= existingBySource.get(l.label_id) ?? existingByKey.get(key) ?? null;
    nodes.set(key, node);
  }
  for (const n of nodes.values()) n.areas = new Set(labels.filter((l) => n.labelIds.includes(l.label_id)).map((l) => l.tab_id ?? '')).size;

  // Orden: por profundidad de árbol, madres primero, y por posición y nombre entre hermanas.
  const out: ImportNode[] = [];
  const children = (parentKey: string | null) => [...nodes.values()].filter((n) => n.parentKey === parentKey)
    .sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name, 'es'));
  const walk = (parentKey: string | null) => { for (const n of children(parentKey)) { out.push(n); walk(n.key); } };
  walk(null);
  // Hijas cuya madre no vino en la lectura (madre borrada en Tasks): como principales.
  for (const n of nodes.values()) if (!out.includes(n)) { n.parentKey = null; out.push(n); walk(n.key); }
  return out;
}

// ---------------------------------------------------------------------------
// Herencia de capacidades (1510, decisión del usuario del 18-10-2026): lo del padre baja a los hijos, nunca al revés. Misma
// regla que `central.person_trade_levels`; la usan la cobertura y las pantallas de Personas y Oficios.
// ---------------------------------------------------------------------------
export interface TradeNode { id: string; parent_id: string | null; active: boolean; deleted_at?: string | null }
export interface TradeCapability { person_id: string; trade_id: string; level: number; deleted_at?: string | null }

/** Grado efectivo de una persona en un oficio (1510). `from`: el antepasado del que lo hereda, si lo hereda. */
export interface EffectiveLevel { level: number; inherited: boolean; from: string | null }

/** Lo puesto por persona y oficio, solo en oficios vivos y activos (lo de un oficio archivado no cuenta). */
function ownLevels(trades: TradeNode[], capabilities: TradeCapability[]): { alive: Map<string, TradeNode>; own: Map<string, Map<string, number>> } {
  const alive = new Map(trades.filter((t) => !t.deleted_at).map((t) => [t.id, t]));
  const own = new Map<string, Map<string, number>>();
  for (const c of capabilities) {
    if (c.deleted_at || !alive.get(c.trade_id)?.active) continue;
    const m = own.get(c.person_id) ?? new Map<string, number>();
    m.set(c.trade_id, c.level);
    own.set(c.person_id, m);
  }
  return { alive, own };
}

/** El mayor grado puesto en un antepasado activo (el más cercano si empatan), pasando a través de los archivados. */
function bestAncestor(alive: Map<string, TradeNode>, mine: Map<string, number> | undefined, tradeId: string): { level: number; from: string } | null {
  let best: { level: number; from: string } | null = null;
  for (let id = alive.get(tradeId)?.parent_id ?? null, depth = 0; mine && id && alive.has(id) && depth < 5; id = alive.get(id)!.parent_id, depth++) {
    const l = mine.get(id);
    if (l !== undefined && (!best || l > best.level)) best = { level: l, from: id };
  }
  return best;
}

/** Lo que una persona hereda en un oficio de sus antepasados: el mínimo que puede tener en él (null si nada). */
export function inheritedLevel(trades: TradeNode[], capabilities: TradeCapability[], personId: string, tradeId: string): { level: number; from: string } | null {
  const { alive, own } = ownLevels(trades, capabilities);
  return bestAncestor(alive, own.get(personId), tradeId);
}

/**
 * Misma regla que `central.person_trade_levels` (1510): lo del padre baja a los hijos, nunca al revés. En cada oficio activo,
 * el máximo entre lo puesto en él y lo puesto en cualquiera de sus antepasados activos. Persona → oficio → grado.
 */
export function effectiveLevels(trades: TradeNode[], capabilities: TradeCapability[]): Map<string, Map<string, EffectiveLevel>> {
  const { alive, own } = ownLevels(trades, capabilities);
  const out = new Map<string, Map<string, EffectiveLevel>>();
  for (const [person, mine] of own) {
    const m = new Map<string, EffectiveLevel>();
    for (const t of alive.values()) {
      if (!t.active) continue;
      const self = mine.get(t.id);
      const up = bestAncestor(alive, mine, t.id);
      if (up && up.level > (self ?? -1)) m.set(t.id, { level: up.level, inherited: true, from: up.from });
      else if (self !== undefined) m.set(t.id, { level: self, inherited: false, from: null });
    }
    out.set(person, m);
  }
  return out;
}
