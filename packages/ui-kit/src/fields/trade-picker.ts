/**
 * Elegir oficios en dos (o tres) niveles (`createTradePicker`, VG 06-11): «Fontanería › ACS».
 * - Se marca el oficio entero («Fontanería», con todas sus especialidades) o solo una especialidad («ACS»).
 * - Marcar el padre quita sus especialidades ya marcadas (las cubre); marcar una especialidad con el padre marcado
 *   lo cambia por ella (se acota). Nunca quedan a la vez un oficio y algo suyo.
 * - Buscar por el nombre del oficio o de la especialidad: «fonta» da Fontanería y todas sus especialidades; «acs», ACS.
 * - «Elegir en el árbol» (por defecto): cada oficio plegable con su chip «entero» primero y sus especialidades.
 * Las filas son las de `central.trade_options` tal cual (`trade_id`, `parent_id`, `name`, `position`) o ya en camelCase;
 * la app las lee (`client.api('/read/central.trade_options', …)`) y las pasa en `trades` o con `load`.
 * Es `createSpacePicker` por dentro: mismas teclas, chips y marcas de feedback.
 */
import { kt } from '../i18n/i18n.ts';
import { createSpacePicker, type SpacePicker } from '../spaces/picker.ts';
import type { SpaceKind, SpaceRow } from '../spaces/model.ts';

/** Una fila de `central.trade_options`, o la misma en camelCase. */
export interface TradeOption {
  trade_id?: string;
  id?: string;
  parent_id?: string | null;
  parentId?: string | null;
  name: string;
  path?: string;
  position?: number | null;
  active?: boolean;
}

export interface TradePickerOptions {
  label: string;
  trades?: readonly TradeOption[];
  /** Lee los oficios (una vez al montar); mientras tanto, los de `trades`. */
  load?: () => Promise<readonly TradeOption[]>;
  /** Varios (por defecto) o uno. */
  multiple?: boolean;
  value?: string[] | string | null;
  onChange?: (ids: string[]) => void;
  /** Solo se pueden elegir los que cumplan esto (p. ej. solo especialidades). */
  filter?: (trade: { id: string; parentId: string | null; name: string; depth: number }) => boolean;
  /** Ids de los más usados que da la app. */
  quick?: string[];
  recentKey?: string;
  /** «Elegir en el árbol» (por defecto, sí). */
  tree?: boolean;
  feedbackId?: string;
}

export interface TradePicker extends Omit<SpacePicker, 'setRows'> {
  setTrades(trades: readonly TradeOption[]): void;
}

const KINDS: SpaceKind[] = [
  { kind: 'oficio', label: 'Oficio', level: 1 },
  { kind: 'especialidad', label: 'Especialidad', level: 2 },
];

const tradeId = (t: TradeOption): string => (t.trade_id ?? t.id ?? '') as string;
const tradeParent = (t: TradeOption): string | null => (t.parent_id !== undefined ? t.parent_id : t.parentId ?? null) || null;

function toRows(trades: readonly TradeOption[]): SpaceRow[] {
  const ids = new Set(trades.map(tradeId));
  return trades.filter((t) => tradeId(t)).map((t) => {
    const parent = tradeParent(t);
    return { id: tradeId(t), parentId: parent && ids.has(parent) ? parent : null, kind: parent && ids.has(parent) ? 'especialidad' : 'oficio', name: t.name,
      publicName: null, code: null, position: t.position ?? 0, active: t.active !== false, notes: null, attributes: {} };
  });
}

function parents(trades: readonly TradeOption[]): Map<string, string | null> {
  return new Map(trades.map((t) => [tradeId(t), tradeParent(t)]));
}

function ancestors(parentOf: Map<string, string | null>, id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  let p = parentOf.get(id) ?? null;
  while (p && !seen.has(p)) { out.push(p); seen.add(p); p = parentOf.get(p) ?? null; }
  return out;
}

/** ¿Lo elegido cubre este oficio? Sí si está elegido él o uno de sus padres («Fontanería» cubre «ACS»). */
export function tradeCovers(trades: readonly TradeOption[], selected: readonly string[], id: string): boolean {
  const parentOf = parents(trades);
  return selected.includes(id) || ancestors(parentOf, id).some((a) => selected.includes(a));
}

/** Lo elegido con todas sus especialidades dentro: para buscar tareas o personas por oficio. */
export function expandTrades(trades: readonly TradeOption[], selected: readonly string[]): string[] {
  const parentOf = parents(trades);
  return [...parentOf.keys()].filter((id) => selected.includes(id) || ancestors(parentOf, id).some((a) => selected.includes(a)));
}

/** Quita lo redundante tras marcar `added`: un oficio y algo suyo no quedan juntos. */
function normalize(parentOf: Map<string, string | null>, prev: readonly string[], next: string[]): string[] {
  const added = next.filter((x) => !prev.includes(x));
  if (!added.length) return next;
  const a = added[added.length - 1]!;
  const up = ancestors(parentOf, a);
  return next.filter((x) => x === a || (!up.includes(x) && !ancestors(parentOf, x).includes(a)));
}

export function createTradePicker(options: TradePickerOptions): TradePicker {
  let trades = options.trades ?? [];
  let parentOf = parents(trades);
  const multiple = options.multiple !== false;
  let current: string[] = Array.isArray(options.value) ? options.value.slice() : options.value ? [options.value] : [];
  const depthOf = (id: string) => ancestors(parentOf, id).length;
  const inner = createSpacePicker({
    label: options.label, rows: toRows(trades), kinds: KINDS, multiple, value: current, quick: options.quick, recentKey: options.recentKey,
    tree: options.tree !== false, feedbackId: options.feedbackId,
    filter: options.filter ? (r) => options.filter!({ id: r.id, parentId: r.parentId, name: r.name, depth: depthOf(r.id) }) : undefined,
    texts: {
      empty: kt('Ningún oficio coincide con «{q}».', { q: '{q}' }), search: kt('Buscar oficio o especialidad…'), tree: kt('Elegir en la lista de oficios'),
      feedback: { quick: kt('Oficio más usado'), search: kt('Buscar oficio'), option: kt('Oficio o especialidad'), remove: kt('Quitar oficio'), tree: kt('Elegir en la lista de oficios') },
    },
    onChange: (ids) => {
      const next = multiple ? normalize(parentOf, current, ids) : ids;
      if (next.length !== ids.length) inner.set(next);
      current = next;
      options.onChange?.(next.slice());
    },
  });
  inner.element.classList.add('trade-picker');
  function setTrades(next: readonly TradeOption[]): void {
    trades = next;
    parentOf = parents(trades);
    inner.setRows(toRows(trades));
  }
  if (options.load) void options.load().then(setTrades, () => { /* sin red: siguen los de `trades` */ });
  return {
    element: inner.element,
    get: () => inner.get(),
    set(ids) { inner.set(ids); current = inner.get(); },
    setTrades,
    destroy: () => inner.destroy(),
  };
}
