/**
 * Carriles agrupando por cualquier clave (traspaso de Flow v03, §12: «proyectar por agente, persona, fase, espacio u
 * objetivo, no solo las columnas»; `MUELA/equipo/feedback/flow/GUIADO.md`). Convierte una lista de cosas en los `lanes` de
 * `createLanes`, sin tocar `createLanes`. Para cambiar de agrupación, `lanes.setLanes(groupLanes(items, otraClave))`.
 * - `key(item)`: el grupo (`null` o '' → «Sin asignar»). La clave es el id del carril, así que la elección se conserva.
 * - `order`: carriles fijos, en ese orden y aunque estén vacíos (p. ej. las fases); los demás van detrás, por título.
 * - `hideEmpty`: quita los fijos vacíos.
 * - Dentro de cada carril: `card(item)` por cada cosa, o `mount(body, items, key)` para montarlo a mano.
 */
import { el } from '../dom.ts';
import { kt, kitLocaleTag } from '../i18n/i18n.ts';
import type { Lane } from './lanes.ts';

/** Id del carril de lo que no tiene clave. */
export const LANE_NONE = '__none';

export interface GroupLanesOptions<T> {
  key: (item: T) => string | null | undefined;
  /** Título del carril; por defecto la clave (y «Sin asignar» para lo que no tiene). */
  title?: (key: string, items: T[]) => string;
  short?: (key: string) => string | undefined;
  /** Carriles fijos y su orden. */
  order?: string[];
  hideEmpty?: boolean;
  /** Título del carril sin clave. */
  noneTitle?: string;
  /** Texto del carril vacío. */
  emptyText?: string;
  card?: (item: T) => HTMLElement;
  mount?: (body: HTMLElement, items: T[], key: string) => void | (() => void);
}

export function groupLanes<T>(items: readonly T[], options: GroupLanesOptions<T>): Lane[] {
  const groups = new Map<string, T[]>();
  for (const key of options.order ?? []) if (!groups.has(key)) groups.set(key, []);
  for (const item of items) {
    const raw = options.key(item);
    const key = raw === null || raw === undefined || String(raw).trim() === '' ? LANE_NONE : String(raw);
    const list = groups.get(key);
    if (list) list.push(item); else groups.set(key, [item]);
  }
  const fixed = new Set(options.order ?? []);
  const titleOf = (key: string, list: T[]) => key === LANE_NONE ? options.noneTitle ?? kt('Sin asignar') : options.title?.(key, list) ?? key;
  const collator = new Intl.Collator(kitLocaleTag(), { sensitivity: 'base', numeric: true });
  const free = [...groups.keys()].filter((k) => !fixed.has(k) && k !== LANE_NONE)
    .sort((a, b) => collator.compare(titleOf(a, groups.get(a)!), titleOf(b, groups.get(b)!)));
  const keys = [...(options.order ?? []).filter((k, i, all) => all.indexOf(k) === i), ...free, ...(groups.has(LANE_NONE) && !fixed.has(LANE_NONE) ? [LANE_NONE] : [])];
  return keys
    .filter((key) => !(options.hideEmpty && !groups.get(key)!.length))
    .map((key): Lane => {
      const list = groups.get(key)!;
      const short = options.short?.(key);
      return {
        id: key,
        title: titleOf(key, list),
        ...(short ? { short } : {}),
        count: list.length,
        empty: list.length === 0,
        mount: (body) => {
          if (options.mount) return options.mount(body, list, key);
          if (!list.length) { body.append(el('p', { class: 'hint lanes-groupempty' }, options.emptyText ?? kt('Nada aquí'))); return; }
          if (options.card) body.append(el('div', { class: 'lanes-group' }, ...list.map((item) => options.card!(item))));
        },
      };
    });
}
