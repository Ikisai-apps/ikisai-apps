/**
 * Baldosa con cifra y relleno (MUELA-075, pieza 6; la baldosa de K22): icono o medallón, nombre, una cifra grande y el
 * relleno de su color hasta el nivel. La marca del mínimo es una raya; el tono (bien, justo, poco) lo decide la app.
 * **`levelText` es obligatorio**: el nivel siempre se dice con palabras («queda poco»), no solo con color.
 * Tocar abre o avanza (`onClick`); sin él, no es un botón.
 *
 * **Varios mandos** (0.57, MUELA-093 y 094): un botón no puede ir dentro de otro, así que con `actions` (o `media`) la
 * baldosa es un `div` con botones hermanos:
 * - `onClick`, si lo hay, es un botón que cubre la baldosa por debajo de los demás (tocar la baldosa);
 * - `slot: 'media'`: el dibujo (`media`, por ejemplo el envase) es su botón; sin esa acción, el dibujo no es botón;
 * - `slot: 'corner'`: el redondo de la esquina, 46 px (el carrito o la casilla; con `pressed`, `aria-pressed`);
 * - `slot: 'more'`: el «⋯», 46 px, en la fila del medallón y a la izquierda de la esquina, sin que la baldosa crezca.
 * La pulsación larga equivale al «⋯» (`onLongPress`, por defecto la acción `more`); los botones lo dicen en su descripción.
 * Prefijo de clases: `tile-`.
 */
import { el } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { renderMedal, type MedalOptions } from './medal.ts';

export interface TileAction {
  slot: 'media' | 'corner' | 'more';
  /** Nombre accesible («Cambiar el envase de Harina», «Marcar comprado: Harina»). */
  label: string;
  onClick: (event: MouseEvent) => void;
  /** Icono del botón (esquina: `check` por defecto; «⋯»: `more`). En `media`, el dibujo es `TileOptions.media`. */
  icon?: IconName | Node | null;
  /** Botón de dos estados (comprado / sin comprar). */
  pressed?: boolean | null;
  disabled?: boolean;
  feedbackId?: string;
}

export interface TileOptions {
  title: string;
  value: string | number;
  /** Lo que dice el nivel en palabras («queda poco», «va justo», «bien»). Obligatorio. */
  levelText: string;
  /** Relleno: porcentaje (0–100), el mínimo como marca y el tono. Sin `level`, la baldosa no se rellena. */
  level?: { pct: number; min?: number | null; tone?: 'alert' | 'warn' | 'ok' | null } | null;
  medal?: MedalOptions | null;
  icon?: IconName | Node | null;
  onClick?: () => void;
  feedbackId?: string;
  /** Un dibujo grande bajo el nombre (el envase). Es botón solo con una acción `slot: 'media'`. */
  media?: Node | null;
  /** Mandos de la baldosa (ver arriba). */
  actions?: TileAction[] | null;
  /** Nombre accesible de tocar la baldosa (`onClick`) cuando hay varios mandos; por defecto, el título. */
  mainLabel?: string;
  /** Pulsación larga; por defecto, la acción `more`. `null` la quita. */
  onLongPress?: (() => void) | null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
const LONG_MS = 480;
let uid = 0;

/**
 * Pulsación larga en `node`: llama a `fn` y se traga el clic que llega después. Dentro de una estantería que arrastra
 * (`[data-shelf-drag]`), con el dedo la pulsación larga levanta la baldosa: entonces `fn` va al soltar sin haberla movido.
 */
export function bindLongPress(node: HTMLElement, fn: () => void): () => void {
  let timer = 0;
  let start: { x: number; y: number; id: number; type: string; at: number } | null = null;
  let swallow = false;
  const deferred = () => !!start && start.type !== 'mouse' && !!node.closest('[data-shelf-drag="1"]');
  const fire = () => { swallow = true; start = null; fn(); };
  const cancel = () => { clearTimeout(timer); start = null; };
  const down = (e: PointerEvent) => {
    if (e.button > 0 || !e.isPrimary) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, at: Date.now() };
    swallow = false;
    clearTimeout(timer);
    if (!deferred()) timer = window.setTimeout(fire, LONG_MS);
  };
  const move = (e: PointerEvent) => { if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel(); };
  const up = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const held = Date.now() - start.at >= LONG_MS;
    const moved = node.closest<HTMLElement>('[data-shelf-moved="1"]');
    if (deferred() && held && !moved) fire();
    else if (deferred() && held) swallow = true;
    cancel();
  };
  const click = (e: Event) => { if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); } };
  const menu = (e: Event) => e.preventDefault();
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', menu);
  return () => {
    cancel();
    node.removeEventListener('pointerdown', down);
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerup', up);
    node.removeEventListener('pointercancel', cancel);
    node.removeEventListener('click', click, true);
    node.removeEventListener('contextmenu', menu);
  };
}

export function renderTile(options: TileOptions): HTMLElement {
  const level = options.level ?? null;
  const pct = level ? clamp(level.pct) : null;
  const lead = options.medal ? renderMedal({ size: 40, name: options.title, ...options.medal })
    : options.icon ? el('span', { class: 'tile-icon', 'aria-hidden': 'true' }, typeof options.icon === 'string' ? icon(options.icon as IconName, 22) : options.icon) : null;
  const fill = [
    pct !== null ? el('span', { class: 'tile-fill', 'aria-hidden': 'true', style: `height:${pct}%` }) : null,
    pct !== null && level?.min != null ? el('span', { class: 'tile-min', 'aria-hidden': 'true', style: `bottom:${clamp(level.min)}%` }) : null,
  ];
  const attrs = {
    class: 'tile-box', dataset: { tone: level?.tone ?? 'none' },
    ...(options.feedbackId ? { 'data-feedback-id': options.feedbackId, 'data-feedback-label': options.title } : {}),
  };
  const actions = options.actions ?? [];
  if (!actions.length && !options.media) {
    const body = [...fill,
      el('span', { class: 'tile-top' }, lead, el('span', { class: 'tile-title' }, options.title)),
      el('strong', { class: 'tile-value' }, String(options.value)),
      el('span', { class: 'tile-level' }, options.levelText)];
    return options.onClick ? el('button', { type: 'button', ...attrs, onclick: options.onClick }, ...body) : el('div', attrs, ...body);
  }

  // Varios mandos: botones hermanos, ninguno dentro de otro.
  const slot = (name: TileAction['slot']) => actions.find((a) => a.slot === name) ?? null;
  const moreAction = slot('more');
  const long = options.onLongPress === undefined ? (moreAction && !moreAction.disabled ? () => moreAction.onClick(new MouseEvent('click')) : null) : options.onLongPress;
  const hintId = long ? `tile-hint-${++uid}` : null;
  const described = hintId ? { 'aria-describedby': hintId } : {};
  const mark = (a: TileAction) => (a.feedbackId ? { 'data-feedback-id': a.feedbackId, 'data-feedback-label': a.label } : {});
  const button = (a: TileAction, cls: string, ...kids: Array<Node | string | null>) => el('button', {
    type: 'button', class: cls, 'aria-label': a.label, title: a.slot === 'media' ? null : a.label, disabled: !!a.disabled,
    'aria-pressed': a.pressed === undefined || a.pressed === null ? null : String(a.pressed),
    'aria-haspopup': a.slot === 'more' ? 'dialog' : null, ...mark(a), ...(a.slot === 'more' ? {} : described),
    onclick: (e: Event) => a.onClick(e as MouseEvent),
  }, ...kids);
  const glyph = (a: TileAction, fallback: IconName) => (a.icon instanceof Node ? a.icon : icon((a.icon as IconName | null | undefined) ?? fallback, 22));
  const corner = slot('corner');
  const mediaAction = slot('media');
  const tools = moreAction || corner
    ? el('span', { class: 'tile-tools' },
      moreAction ? button(moreAction, 'tile-more', glyph(moreAction, 'more')) : null,
      corner ? button(corner, 'tile-corner', glyph(corner, 'check')) : null)
    : null;
  const media = options.media
    ? mediaAction ? button(mediaAction, 'tile-media', options.media) : el('span', { class: 'tile-media' }, options.media)
    : null;
  const main = options.onClick ? el('button', { type: 'button', class: 'tile-main', 'aria-label': options.mainLabel ?? options.title, ...described, onclick: options.onClick }) : null;
  const node = el('div', { ...attrs, class: 'tile-box tile-multi', dataset: { tone: level?.tone ?? 'none', pressed: corner?.pressed ? 'true' : 'false' } },
    ...fill, main,
    el('span', { class: 'tile-top' }, lead, el('span', { class: 'tile-title' }, options.title), tools),
    media,
    String(options.value) !== '' ? el('strong', { class: 'tile-value' }, String(options.value)) : null,
    el('span', { class: 'tile-level' }, options.levelText),
    hintId ? el('span', { id: hintId, class: 'vh' }, kt('Mantén pulsado para más acciones')) : null);
  if (long) bindLongPress(node, long);
  return node;
}
