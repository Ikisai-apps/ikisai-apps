/**
 * Carriles (encargo de VG, 27-10; lo consume Flow en su v2 y vale para cualquier app con columnas). Hay dos vistas que se
 * cambian con un conmutador visible:
 * - **Pestañas** (`tabs`): una tira de chips desplazable con título y recuento, y un carril a la vista. Es accesible como
 *   `tablist`: las flechas, Inicio y Fin cambian de carril.
 * - **Lado a lado** (`side`): desplazamiento horizontal, y vertical dentro de cada carril.
 *   - Cada carril mide `clamp(172px, 50vw − 22px, 240px)` y crecen hasta llenar el ancho: dos en un móvil en vertical, de 5 a 7
 *     en un PC.
 *   - Un carril `empty` se pliega a una mini columna con su título girado (o `short`); al tocarla se despliega.
 * La elección se recuerda en el dispositivo (`storageKey`). Sin ella, se usan pestañas por debajo de `wideFrom` px y lado a lado
 * por encima.
 * Lo que va dentro de cada carril lo monta la app con `mount(body)`, que puede devolver su limpieza (temporizadores,
 * suscripciones). Se monta una sola vez, la primera vez que el carril se ve. La limpieza se llama al quitar el carril con
 * `setLanes`, al volver a montarlo con `refresh(id)` o con `destroy()`.
 * - En «Pestañas», los carriles ya montados se ocultan, no se desmontan, así que conservan su estado.
 * - El mismo nodo pasa de una vista a otra.
 * `onSelect(id)` avisa del carril principal: al elegir una pestaña y, en «Lado a lado», al tocar una cabecera o cuando un
 * carril pasa a ser el primero visible al desplazar.
 * Prefijo de clases: `lanes-`.
 */
import { el, replace } from '../dom.ts';
import { kt, onKitLocaleChange } from '../i18n/i18n.ts';

export type LanesView = 'tabs' | 'side';

export interface Lane {
  id: string;
  title: string;
  /** Título corto de la mini columna (si no, el título girado). */
  short?: string;
  /** Recuento en el chip y en la cabecera; `null` o sin él, no se enseña. */
  count?: number | null;
  /** Sin nada dentro: en «Lado a lado» se pliega a una mini columna. */
  empty?: boolean;
  /** Monta el carril dentro de `body` (una vez, perezoso); puede devolver su limpieza. */
  mount: (body: HTMLElement) => void | (() => void);
}

export interface LanesOptions {
  /** Etiqueta accesible del conjunto («Columnas del tablero»). */
  label: string;
  lanes: Lane[];
  /** Vista al empezar. Si no se da, la guardada en `storageKey`; y si no hay ninguna, la que toca por el ancho. */
  view?: LanesView;
  /** Clave para recordar la vista en el dispositivo (p. ej. `flow-board`). */
  storageKey?: string;
  /** Ancho (px) a partir del cual la vista por defecto es «Lado a lado». Por defecto, 720. */
  wideFrom?: number;
  /** Carril principal al empezar. */
  selected?: string;
  /** Carril principal nuevo (pestaña elegida; en «Lado a lado», cabecera tocada o primer carril visible al desplazar). */
  onSelect?: (id: string) => void;
  onView?: (view: LanesView) => void;
  /**
   * Base de las marcas de feedback: `<base>.vista` en el conmutador, `<base>.carril` en los chips y cabeceras y
   * `<base>.desplegar` en las mini columnas.
   */
  feedbackId?: string;
}

export interface Lanes {
  element: HTMLElement;
  view(): LanesView;
  setView(view: LanesView): void;
  /** Carril principal. */
  selected(): string | null;
  /** Cambia los carriles (títulos, recuentos, `empty`). Los que siguen conservan su montaje; los que salen se limpian. */
  setLanes(lanes: Lane[]): void;
  /** Elige un carril: en «Pestañas» lo enseña; en «Lado a lado» lo despliega si está plegado y lo trae a la vista. */
  select(id: string, focus?: boolean): void;
  /** Vuelve a montar un carril, o todos los ya montados (limpieza y `mount` otra vez). */
  refresh(id?: string): void;
  /** Limpia todos los carriles y suelta los oyentes. */
  destroy(): void;
}

const storageName = (key: string) => `ikisai-lanes:${key}`;

function readView(key: string | undefined): LanesView | null {
  if (!key) return null;
  try { const v = localStorage.getItem(storageName(key)); return v === 'tabs' || v === 'side' ? v : null; } catch { return null; }
}

function saveView(key: string | undefined, view: LanesView): void {
  if (!key) return;
  try { localStorage.setItem(storageName(key), view); } catch { /* sin almacenamiento */ }
}

let uid = 0;

export function createLanes(options: LanesOptions): Lanes {
  const id = `kit-lanes-${++uid}`;
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const wide = () => typeof matchMedia === 'function' && matchMedia(`(min-width: ${options.wideFrom ?? 720}px)`).matches;
  let lanes = options.lanes.slice();
  let view: LanesView = options.view ?? readView(options.storageKey) ?? (wide() ? 'side' : 'tabs');
  let current = options.selected && lanes.some((l) => l.id === options.selected) ? options.selected : lanes[0]?.id ?? null;
  const bodies = new Map<string, HTMLElement>();
  const cleanups = new Map<string, (() => void) | null>();
  /** Carriles vacíos que se han desplegado a mano. */
  const opened = new Set<string>();

  const element = el('section', { class: 'lanes', 'aria-label': options.label, id });
  const switcher = el('div', { class: 'lanes-switch', role: 'group' });
  const strip = el('div', { class: 'lanes-tabs', role: 'tablist', 'aria-label': options.label });
  const panels = el('div', { class: 'lanes-panels' });
  const track = el('div', { class: 'lanes-track' });

  function bodyOf(lane: Lane): HTMLElement {
    let body = bodies.get(lane.id);
    if (!body) { body = el('div', { class: 'lanes-body', id: `${id}-body-${lane.id}` }); bodies.set(lane.id, body); }
    if (!cleanups.has(lane.id)) {
      let cleanup: (() => void) | null = null;
      try { const done = lane.mount(body); cleanup = typeof done === 'function' ? done : null; } catch (error) { console.error('[ui-kit] createLanes: mount', error); }
      cleanups.set(lane.id, cleanup);
    }
    return body;
  }

  function unmount(laneId: string): void {
    if (!cleanups.has(laneId)) return;
    const cleanup = cleanups.get(laneId);
    cleanups.delete(laneId);
    try { cleanup?.(); } catch (error) { console.error('[ui-kit] createLanes: limpieza', error); }
    const body = bodies.get(laneId);
    if (body) replace(body);
  }

  const countText = (lane: Lane) => (typeof lane.count === 'number' ? String(lane.count) : null);
  const laneLabel = (lane: Lane) => (typeof lane.count === 'number' ? `${lane.title}, ${lane.count}` : lane.title);

  function paintSwitch(): void {
    switcher.setAttribute('aria-label', kt('Vista de los carriles'));
    replace(switcher, ...([['tabs', kt('Pestañas')], ['side', kt('Lado a lado')]] as const).map(([v, text]) =>
      el('button', { type: 'button', class: 'lanes-mode', 'aria-pressed': String(view === v), dataset: { view: v }, ...mark('vista', 'Pestañas o lado a lado'), onclick: () => setView(v, true) }, text)));
  }

  function paintTabs(focus: boolean): void {
    replace(strip, ...lanes.map((lane) => {
      const on = lane.id === current;
      return el('button', {
        type: 'button', role: 'tab', class: `lanes-tab${lane.empty ? ' lanes-tabempty' : ''}`, id: `${id}-tab-${lane.id}`,
        'aria-selected': String(on), 'aria-controls': `${id}-body-${lane.id}`, tabindex: on ? '0' : '-1', 'aria-label': laneLabel(lane),
        dataset: { lane: lane.id }, ...mark('carril', 'Carril'), onclick: () => select(lane.id, true),
      }, el('span', { class: 'lanes-tabtitle' }, lane.title), countText(lane) !== null ? el('span', { class: 'lanes-count', 'aria-hidden': 'true' }, countText(lane)) : null);
    }));
    // Solo se monta el carril elegido; los ya montados se quedan ocultos con su estado.
    const lane = lanes.find((l) => l.id === current);
    if (lane) bodyOf(lane);
    replace(panels, ...lanes.filter((l) => cleanups.has(l.id)).map((l) => {
      const body = bodies.get(l.id)!;
      body.hidden = l.id !== current;
      body.setAttribute('role', 'tabpanel');
      body.setAttribute('aria-labelledby', `${id}-tab-${l.id}`);
      body.setAttribute('tabindex', '0');
      return body;
    }));
    const tab = strip.querySelector<HTMLElement>('[aria-selected="true"]');
    if (tab) {
      requestAnimationFrame(() => {
        const left = tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2;
        strip.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
      });
      if (focus) tab.focus({ preventScroll: true });
    }
  }

  function asSideBody(lane: Lane): HTMLElement {
    const body = bodyOf(lane);
    body.hidden = false;
    for (const name of ['role', 'aria-labelledby', 'tabindex']) body.removeAttribute(name);
    return body;
  }

  function paintSide(): void {
    replace(track, ...lanes.map((lane) => {
      if (lane.empty && !opened.has(lane.id)) {
        return el('section', { class: 'lanes-lane lanes-mini', dataset: { lane: lane.id }, 'aria-label': laneLabel(lane) },
          el('button', {
            type: 'button', class: 'lanes-unfold', 'aria-expanded': 'false', title: lane.title, ...mark('desplegar', 'Desplegar el carril'),
            'aria-label': kt('{title}: sin elementos. Desplegar', { title: lane.title }),
            onclick: () => select(lane.id, true),
          }, el('span', { class: lane.short ? 'lanes-short' : 'lanes-turned' }, lane.short ?? lane.title)));
      }
      return el('section', { class: 'lanes-lane', dataset: { lane: lane.id }, 'aria-label': laneLabel(lane) },
        el('h3', { class: 'lanes-headwrap' },
          el('button', { type: 'button', class: 'lanes-head', 'aria-label': laneLabel(lane), 'aria-current': lane.id === current ? 'true' : null, ...mark('carril', 'Carril'), onclick: () => select(lane.id) },
            el('span', { class: 'lanes-title' }, lane.title), countText(lane) !== null ? el('span', { class: 'lanes-count', 'aria-hidden': 'true' }, countText(lane)) : null)),
        asSideBody(lane));
    }));
    observeSide();
  }

  // «Lado a lado»: el carril principal pasa a ser el primero que se ve casi entero al desplazar.
  let observer: IntersectionObserver | null = null;
  const seen = new Map<string, number>();
  let principalTimer = 0;
  let quietUntil = 0;
  function markCurrent(): void {
    for (const head of track.querySelectorAll<HTMLElement>('.lanes-head')) {
      if (head.closest<HTMLElement>('.lanes-lane')?.dataset.lane === current) head.setAttribute('aria-current', 'true'); else head.removeAttribute('aria-current');
    }
  }
  function observeSide(): void {
    observer?.disconnect();
    seen.clear();
    if (typeof IntersectionObserver !== 'function') return;
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set((e.target as HTMLElement).dataset.lane!, e.intersectionRatio);
      clearTimeout(principalTimer);
      principalTimer = window.setTimeout(() => {
        if (view !== 'side' || Date.now() < quietUntil) return;
        const first = lanes.find((l) => (seen.get(l.id) ?? 0) >= 0.6);
        if (first && first.id !== current) { current = first.id; markCurrent(); options.onSelect?.(first.id); }
      }, 150);
    }, { root: track, threshold: [0, 0.6, 1] });
    for (const node of track.querySelectorAll<HTMLElement>('.lanes-lane')) observer.observe(node);
  }

  function paint(focus = false): void {
    element.dataset.view = view;
    paintSwitch();
    if (view === 'tabs') {
      observer?.disconnect();
      replace(track);
      replace(element, el('div', { class: 'lanes-bar' }, el('span', { class: 'lanes-sum' }, options.label), switcher), strip, panels);
      paintTabs(focus);
    } else {
      replace(panels);
      replace(element, el('div', { class: 'lanes-bar' }, el('span', { class: 'lanes-sum' }, options.label), switcher), track);
      paintSide();
    }
  }

  function setView(next: LanesView, fromSwitch = false): void {
    if (next === view) return;
    view = next;
    saveView(options.storageKey, view);
    paint();
    if (fromSwitch) element.querySelector<HTMLElement>(`.lanes-mode[data-view="${view}"]`)?.focus();
    if (view === 'side' && current) { quietUntil = Date.now() + 400; track.querySelector<HTMLElement>(`[data-lane="${CSS.escape(current)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'start' }); }
    options.onView?.(view);
  }

  function select(laneId: string, focus = false): void {
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane) return;
    const changed = laneId !== current;
    current = laneId;
    if (view === 'tabs') paintTabs(focus);
    else {
      // El desplazamiento que provoca la elección no debe elegir otro carril.
      quietUntil = Date.now() + 400;
      clearTimeout(principalTimer);
      if (lane.empty && !opened.has(laneId)) { opened.add(laneId); paintSide(); } else markCurrent();
      const node = track.querySelector<HTMLElement>(`[data-lane="${CSS.escape(laneId)}"]`);
      node?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (focus) node?.querySelector<HTMLElement>('.lanes-head')?.focus({ preventScroll: true });
    }
    if (changed) options.onSelect?.(laneId);
  }

  strip.addEventListener('keydown', (e) => {
    if (!current) return;
    const at = lanes.findIndex((l) => l.id === current);
    const key = e.key;
    const next = key === 'ArrowRight' ? lanes[at + 1] : key === 'ArrowLeft' ? lanes[at - 1] : key === 'Home' ? lanes[0] : key === 'End' ? lanes[lanes.length - 1] : undefined;
    if (!next) return;
    e.preventDefault();
    select(next.id, true);
  });
  const stopLocale = onKitLocaleChange(() => paint());
  paint();

  return {
    element,
    view: () => view,
    setView: (v) => setView(v),
    selected: () => current,
    setLanes(next) {
      const ids = new Set(next.map((l) => l.id));
      for (const key of [...bodies.keys()]) if (!ids.has(key)) { unmount(key); bodies.delete(key); opened.delete(key); }
      // Un carril que deja de estar vacío ya no necesita estar «abierto a mano».
      for (const lane of next) if (!lane.empty) opened.delete(lane.id);
      lanes = next.slice();
      if (!current || !ids.has(current)) current = lanes[0]?.id ?? null;
      paint();
    },
    select,
    refresh(laneId) {
      for (const lane of lanes) {
        if ((laneId && lane.id !== laneId) || !cleanups.has(lane.id)) continue;
        unmount(lane.id);
        bodyOf(lane);
      }
    },
    destroy() {
      observer?.disconnect();
      clearTimeout(principalTimer);
      stopLocale();
      for (const key of [...cleanups.keys()]) unmount(key);
      element.remove();
    },
  };
}
