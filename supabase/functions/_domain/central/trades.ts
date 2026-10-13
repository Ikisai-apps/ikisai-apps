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
