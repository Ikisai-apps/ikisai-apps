/**
 * Tasks · fase P2: qué oficio de Central corresponde a cada etiqueta de la familia «Tipo: Acción» (docs/tasks/API.md §32).
 *
 * Función pura: recibe las familias y etiquetas de Tasks y las opciones que publica Central (`central.trade_options`, que
 * tasks-api lee con el usuario que pide) y devuelve la correspondencia que los procedimientos SQL reciben como argumento
 * (allí cada oficio se revalida con `central.trade_alive`). Tasks nunca lee las tablas de Central desde SQL.
 */
import type { FamilyRow, LabelRow, Uuid } from './types.ts';

/** Una fila de `central.trade_options`: oficios activos, con su ruta «Madre › Hija». */
export interface TradeOption {
  trade_id: Uuid;
  parent_id: Uuid | null;
  name: string;
  path: string;
  position?: number;
  source_label_id: Uuid | null;
}

export type ActionTradeReason = 'no_trade' | 'several_trades';

export interface ActionTrade {
  labelId: Uuid;
  name: string;
  parentId: Uuid | null;
  /** Área de la etiqueta (nula en la General). */
  tabId: Uuid | null;
  familyId: Uuid;
  tradeId: Uuid | null;
  /** Ruta del oficio en Central («Fontanería › ACS»). */
  tradePath: string | null;
  /** Cómo se encontró: por `source_label_id` o por la ruta. */
  by: 'source' | 'path' | null;
  reason: ActionTradeReason | null;
}

const PATH_SEPARATOR = '›';

/** Sin mayúsculas, sin tildes y sin espacios de sobra (también alrededor de «›»). */
export function normalizeTradeText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(PATH_SEPARATOR).map((part) => part.trim().replace(/\s+/g, ' ')).join(` ${PATH_SEPARATOR} `);
}

/** La familia «Tipo: Acción» se reconoce por el nombre, como en `tasks.action_labels` (0321): la General y sus copias de área. */
export function isActionFamily(name: string): boolean {
  return normalizeTradeText(name) === 'tipo: accion';
}

type FamilyLike = Pick<FamilyRow, 'id' | 'name' | 'deleted_at'>;
type LabelLike = Pick<LabelRow, 'id' | 'name' | 'family_id' | 'parent_id' | 'tab_id' | 'deleted_at'>;

/**
 * Para cada etiqueta viva de las familias «Tipo: Acción» (la General y las copias de área, archivadas o no; qué familias
 * entran en juego lo decide el SQL), su oficio:
 * 1. el que dice venir de ella (`source_label_id`);
 * 2. si no, el mismo que otra etiqueta con la misma ruta encontrada por el paso 1 (las copias de área casan con el oficio
 *    de la General aunque Central lo haya renombrado);
 * 3. si no, el oficio cuya ruta es la de la etiqueta («Madre › Hija» o «Nombre»), sin mirar mayúsculas ni tildes.
 * Si la ruta casa con varios oficios distintos, no se elige ninguno (`several_trades`); si con ninguno, `no_trade`.
 */
export function actionTradeMap(families: readonly FamilyLike[], labels: readonly LabelLike[], options: readonly TradeOption[]): ActionTrade[] {
  const actionFamilies = new Set(families.filter((f) => !f.deleted_at && isActionFamily(f.name)).map((f) => f.id));
  const own = labels.filter((l) => !l.deleted_at && actionFamilies.has(l.family_id));
  const byId = new Map(own.map((l) => [l.id, l]));
  const labelPath = (l: LabelLike): string => {
    const parent = l.parent_id ? byId.get(l.parent_id) : undefined;
    return normalizeTradeText(parent && parent.family_id === l.family_id ? `${parent.name} ${PATH_SEPARATOR} ${l.name}` : l.name);
  };
  const tradeById = new Map(options.map((o) => [o.trade_id, o]));
  const bySource = new Map<Uuid, TradeOption>();
  for (const o of options) if (o.source_label_id) bySource.set(o.source_label_id, o);
  const byPath = new Map<string, Set<Uuid>>();
  for (const o of options) {
    const key = normalizeTradeText(o.path || o.name);
    byPath.set(key, (byPath.get(key) ?? new Set()).add(o.trade_id));
  }

  const result = new Map<Uuid, ActionTrade>();
  const viaSource = new Map<string, Set<Uuid>>();
  const entry = (l: LabelLike, trade: TradeOption | undefined, by: ActionTrade['by'], reason: ActionTradeReason | null): ActionTrade => ({
    labelId: l.id, name: l.name, parentId: l.parent_id, tabId: l.tab_id, familyId: l.family_id,
    tradeId: trade?.trade_id ?? null, tradePath: trade ? trade.path || trade.name : null, by, reason,
  });
  for (const l of own) {
    const trade = bySource.get(l.id);
    if (!trade) continue;
    result.set(l.id, entry(l, trade, 'source', null));
    const key = labelPath(l);
    viaSource.set(key, (viaSource.get(key) ?? new Set()).add(trade.trade_id));
  }
  for (const l of own) {
    if (result.has(l.id)) continue;
    const key = labelPath(l);
    const sourced = viaSource.get(key);
    const candidates = sourced && sourced.size > 0 ? sourced : byPath.get(key);
    if (!candidates || candidates.size === 0) result.set(l.id, entry(l, undefined, null, 'no_trade'));
    else if (candidates.size > 1) result.set(l.id, entry(l, undefined, null, 'several_trades'));
    else result.set(l.id, entry(l, tradeById.get([...candidates][0]!), 'path', null));
  }
  return own.map((l) => result.get(l.id)!);
}

/** Lo que reciben los procedimientos SQL (`map`): sin nombres, solo ids y el motivo. */
export function tradeMapArgument(map: readonly ActionTrade[]): Array<{ labelId: Uuid; tradeId: Uuid | null; reason: ActionTradeReason | null }> {
  return map.map((m) => ({ labelId: m.labelId, tradeId: m.tradeId, reason: m.reason }));
}
