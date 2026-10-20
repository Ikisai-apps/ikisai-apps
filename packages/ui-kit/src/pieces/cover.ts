/**
 * Portada y foco (MUELA-075, pieza 5: Tasks, Booking, Central y Food).
 * - `renderCover`: la foto en grande (o el color con las iniciales) con el título, una píldora («Vence el 30 oct»,
 *   «En pausa»), caras y una línea de cifras escritas («5 pendientes · 1 vencida · 40 % hecho»). Pulsarla abre.
 * - `createFocus`: «lo que toca ahora», una tarjeta grande con «✓ Hecha», «Abrir» y «Siguiente ›», y las dos
 *   siguientes asomando detrás. El orden de la cola lo da la app (vencida, hoy, mañana…); aquí solo se recorre.
 * Prefijos de clases: `cover-` y `focus-`.
 */
import { el, replace, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { itemColorStyle } from '../theme.ts';
import { initialsOf, renderMedal, type MedalOptions } from './medal.ts';

const bg = (image: string | null | undefined) => (image ? `--cover-image:url("${String(image).replace(/["\\]/g, '')}")` : '');

export interface CoverOptions {
  title: string;
  image?: string | null;
  /** Color del proyecto o el área (sin imagen, el fondo; con imagen, el borde). */
  color?: string | null;
  /** Píldora arriba («Vence el 30 oct», «En pausa»). */
  pill?: string | null;
  pillTone?: 'alert' | 'warn' | 'ok' | null;
  /** Línea de cifras ya escrita por la app. */
  stats?: string | null;
  /** Caras (hasta 4; la primera, quien lleva). */
  faces?: MedalOptions[];
  /** Algo junto al título (p. ej. la estrella de prioridad). */
  titleExtra?: Child;
  /** Botones encima de la foto (atrás, editar, más). */
  tools?: Child[];
  onOpen?: () => void;
  /** Más baja (cabecera de ficha). */
  compact?: boolean;
  feedbackId?: string;
  /**
   * El título como encabezado (`h2`…`h4`) en vez de texto suelto. Con `onOpen`, el botón va dentro del encabezado y su
   * zona de toque cubre toda la portada (como siempre).
   */
  headingLevel?: 2 | 3 | 4;
  /** Id del título (para `aria-labelledby` desde fuera); la portada se nombra con él. */
  titleId?: string;
}

export function renderCover(options: CoverOptions): HTMLElement {
  const faces = (options.faces ?? []).slice(0, 4);
  if (options.headingLevel || options.titleId) return renderCoverWithHeading(options, faces);
  const body: Child[] = [
    options.pill ? el('span', { class: 'cover-pill', dataset: { tone: options.pillTone ?? 'none' } }, options.pill) : null,
    options.image ? null : el('span', { class: 'cover-initials', 'aria-hidden': 'true' }, initialsOf(options.title)),
    el('span', { class: 'cover-title' }, options.title, options.titleExtra ?? null),
  ];
  const main = options.onOpen
    ? el('button', { type: 'button', class: 'cover-main', onclick: options.onOpen, ...(options.feedbackId ? { 'data-feedback-id': options.feedbackId, 'data-feedback-label': options.title } : {}) }, ...body)
    : el('div', { class: 'cover-main' }, ...body);
  return el('section', {
    class: `cover-box${options.image ? ' cover-has-image' : ''}${options.compact ? ' cover-compact' : ''}`,
    style: [bg(options.image), itemColorStyle(options.color ?? null)].filter(Boolean).join(';'),
    'aria-label': options.title,
  },
  main,
  options.tools?.length ? el('div', { class: 'cover-tools' }, ...options.tools) : null,
  faces.length || options.stats ? el('div', { class: 'cover-strip' },
    faces.length ? el('span', { class: 'cover-faces', 'aria-hidden': 'true' }, ...faces.map((f) => renderMedal({ size: 30, ...f }))) : null,
    options.stats ? el('span', { class: 'cover-stats' }, options.stats) : null) : null);
}

/** Portada con el título como encabezado: el botón (si hay `onOpen`) va dentro del encabezado y se estira a toda la portada. */
function renderCoverWithHeading(options: CoverOptions, faces: MedalOptions[]): HTMLElement {
  const tag = (`h${options.headingLevel ?? 2}`) as 'h2' | 'h3' | 'h4';
  const titleText = options.onOpen
    ? el('button', { type: 'button', class: 'cover-titlebtn', onclick: options.onOpen, ...(options.feedbackId ? { 'data-feedback-id': options.feedbackId, 'data-feedback-label': options.title } : {}) }, options.title)
    : options.title;
  return el('section', {
    class: `cover-box cover-headed${options.image ? ' cover-has-image' : ''}${options.compact ? ' cover-compact' : ''}`,
    style: [bg(options.image), itemColorStyle(options.color ?? null)].filter(Boolean).join(';'),
    ...(options.titleId ? { 'aria-labelledby': options.titleId } : { 'aria-label': options.title }),
  },
  el('div', { class: 'cover-main' },
    options.pill ? el('span', { class: 'cover-pill', dataset: { tone: options.pillTone ?? 'none' } }, options.pill) : null,
    options.image ? null : el('span', { class: 'cover-initials', 'aria-hidden': 'true' }, initialsOf(options.title)),
    el(tag, { class: 'cover-title', ...(options.titleId ? { id: options.titleId } : {}) }, titleText, options.titleExtra ?? null)),
  options.tools?.length ? el('div', { class: 'cover-tools' }, ...options.tools) : null,
  faces.length || options.stats ? el('div', { class: 'cover-strip' },
    faces.length ? el('span', { class: 'cover-faces', 'aria-hidden': 'true' }, ...faces.map((f) => renderMedal({ size: 30, ...f }))) : null,
    options.stats ? el('span', { class: 'cover-stats' }, options.stats) : null) : null);
}

export interface FocusItem {
  id: string;
  title: string;
  /** Encima del título («Vencida · toca ya», «Para hoy», «Lo siguiente»). */
  kicker?: string | null;
  /** `alert` marca la tarjeta (vencida). */
  tone?: 'alert' | 'warn' | null;
  note?: string | null;
  /** Datos cortos ya escritos («Vence hoy», «2/5 pasos»). */
  meta?: string[];
  image?: string | null;
  color?: string | null;
  /** Quién la lleva. */
  who?: (MedalOptions & { name: string }) | null;
  /** Texto del botón de abrir solo para esta tarjeta («Confirmar consumo», «Ver comentarios»); manda sobre `openLabel` de la pieza. */
  openLabel?: string | null;
}

export interface FocusOptions {
  label?: string;
  items: FocusItem[];
  /** «✓ Hecha». Sin esto (solo lectura), no hay botón. */
  onDone?: (item: FocusItem) => void;
  onOpen?: (item: FocusItem) => void;
  /** Texto del botón de `onOpen` («Ver en la Despensa»); por defecto «Abrir». */
  openLabel?: string;
  /** Una acción más de la tarjeta, destacada («A la compra»). */
  action?: { label: string; onClick: (item: FocusItem) => void; feedbackId?: string } | null;
  emptyTitle?: string;
  emptyText?: string;
  feedbackId?: string;
}

export interface Focus {
  element: HTMLElement;
  /** Nueva cola (tras marcar hecha, la app la vuelve a dar). Conserva la tarjeta si sigue en la cola. */
  setItems(items: FocusItem[]): void;
  next(): void;
  current(): FocusItem | null;
}

export function createFocus(options: FocusOptions): Focus {
  let items = options.items.slice();
  let index = 0;
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const live = el('p', { class: 'focus-count', 'aria-live': 'polite' });
  const element = el('section', { class: 'focus-stack', 'aria-label': options.label ?? kt('Lo que toca ahora'), ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label ?? 'Lo que toca ahora' } : {}) });

  function card(item: FocusItem): HTMLElement {
    return el('article', {
      class: `focus-card${item.image ? ' focus-has-image' : ''}`, dataset: { id: item.id, tone: item.tone ?? 'none' },
      style: [bg(item.image), itemColorStyle(item.color ?? null)].filter(Boolean).join(';'),
    },
    el('div', { class: 'focus-top' },
      item.kicker ? el('span', { class: 'focus-kicker' }, item.kicker) : null,
      item.who ? el('span', { class: 'focus-who' }, renderMedal({ size: 30, ...item.who }), item.who.name) : null),
    el('h2', { class: 'focus-title' }, item.title),
    item.note ? el('p', { class: 'focus-note' }, item.note) : null,
    item.meta?.length ? el('p', { class: 'focus-meta' }, item.meta.join(' · ')) : null,
    el('div', { class: 'focus-actions' },
      options.onDone ? el('button', { type: 'button', class: 'primary focus-btn', role: 'checkbox', 'aria-checked': 'false', 'aria-label': kt('Marcar hecha: {title}', { title: item.title }), ...mark('hecha', 'Marcar hecha'), onclick: () => options.onDone!(item) }, kt('✓ Hecha')) : null,
      options.action ? el('button', { type: 'button', class: `${options.onDone ? 'softbtn' : 'primary'} focus-btn`, ...(options.action.feedbackId ? { 'data-feedback-id': options.action.feedbackId, 'data-feedback-label': options.action.label } : mark('accion', options.action.label)), onclick: () => options.action!.onClick(item) }, options.action.label) : null,
      options.onOpen ? el('button', { type: 'button', class: 'ghost focus-btn', ...mark('abrir', 'Abrir'), onclick: () => options.onOpen!(item) }, item.openLabel ?? options.openLabel ?? kt('Abrir')) : null,
      items.length > 1 ? el('button', { type: 'button', class: 'ghost focus-btn focus-next', ...mark('siguiente', 'Siguiente'), onclick: () => api.next() }, kt('Siguiente ›')) : null));
  }

  function paint(): void {
    if (!items.length) {
      replace(element, el('article', { class: 'focus-card focus-done' },
        el('h2', { class: 'focus-title' }, options.emptyTitle ?? kt('Todo hecho')),
        options.emptyText ? el('p', { class: 'focus-note' }, options.emptyText) : null));
      live.textContent = '';
      return;
    }
    index = ((index % items.length) + items.length) % items.length;
    const ghosts = Math.min(2, items.length - 1);
    replace(element,
      el('div', { class: 'focus-pile' },
        card(items[index]!),
        ...Array.from({ length: ghosts }, (_, i) => el('div', { class: `focus-ghost focus-g${i + 1}`, 'aria-hidden': 'true' }))),
      live);
    live.textContent = kt('{n} de {m} por hacer', { n: String(index + 1), m: String(items.length) });
  }

  const api: Focus = {
    element,
    setItems(next) {
      const keep = items[index]?.id;
      items = next.slice();
      const at = keep ? items.findIndex((i) => i.id === keep) : -1;
      index = at >= 0 ? at : Math.min(index, Math.max(0, items.length - 1));
      paint();
    },
    // El foco se queda en «Siguiente ›» para seguir pasando con el teclado; el recuento se anuncia.
    next() { const had = element.contains(document.activeElement); index += 1; paint(); if (had) element.querySelector<HTMLElement>('.focus-next')?.focus(); },
    current: () => items[index] ?? null,
  };
  paint();
  return api;
}

export interface CoverSlide {
  id: string;
  title: string;
  image?: string | null;
  color?: string | null;
  /** Estado ya escrito («Ahora · hasta el viernes», «Dentro de 12 días», «Ya pasó»). */
  state?: string | null;
  /** Fechas u otra línea. */
  meta?: string | null;
  faces?: MedalOptions[];
}

export interface CoverCarouselOptions {
  /** Qué se pasa («Tus retiros»). */
  label: string;
  slides: CoverSlide[];
  index?: number;
  onChange?: (slide: CoverSlide, index: number) => void;
  /** Encima de la portada (selector de persona, píldoras). */
  top?: Child;
  feedbackId?: string;
}

export interface CoverCarousel {
  element: HTMLElement;
  go(index: number, focus?: boolean): void;
  index(): number;
}

/**
 * Portada que se pasa con flechas (MUELA-075, pieza 16: Guests, Booking y Organizers): imagen, estado y fechas; flechas
 * y puntos debajo. `aria-roledescription` «carrusel» y «diapositiva», «n de N» anunciado al cambiar, flechas del
 * teclado con el foco dentro y deslizar con el dedo (horizontal claro: más de 50 px y 1,5 veces lo vertical). Sin
 * animaciones: el cambio es inmediato, así que no hay nada que reducir.
 */
export function createCoverCarousel(options: CoverCarouselOptions): CoverCarousel {
  const slides = options.slides;
  let at = Math.max(0, Math.min(slides.length - 1, options.index ?? 0));
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const live = el('p', { class: 'vh', 'aria-live': 'polite' });
  const slideBox = el('div', { class: 'cover-slide-host' });
  const prev = el('button', { type: 'button', class: 'cover-arrow', 'aria-label': kt('Anterior'), ...mark('anterior', 'Anterior'), onclick: () => api.go(at - 1, false) }, '‹');
  const next = el('button', { type: 'button', class: 'cover-arrow', 'aria-label': kt('Siguiente'), ...mark('siguiente', 'Siguiente'), onclick: () => api.go(at + 1, false) }, '›');
  const dots = el('div', { class: 'cover-dots', role: 'group', 'aria-label': options.label });
  const nav = slides.length > 1 ? el('div', { class: 'cover-nav' }, prev, dots, next) : null;
  const element = el('section', {
    class: 'cover-carousel', 'aria-roledescription': kt('carrusel'), 'aria-label': options.label,
    ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}),
    onkeydown: (e: Event) => {
      const k = (e as KeyboardEvent).key;
      if ((e.target as HTMLElement).closest('input,select,textarea')) return;
      if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); api.go(at + (k === 'ArrowRight' ? 1 : -1), true); }
    },
  }, options.top ? el('div', { class: 'cover-top' }, options.top) : null, slideBox, nav, live);

  function slide(s: CoverSlide, i: number): HTMLElement {
    const faces = (s.faces ?? []).slice(0, 4);
    return el('div', {
      class: `cover-box cover-slide${s.image ? ' cover-has-image' : ''}`, role: 'group', 'aria-roledescription': kt('diapositiva'),
      'aria-label': kt('{n} de {m}: {title}', { n: String(i + 1), m: String(slides.length), title: s.title }),
      style: [bg(s.image), itemColorStyle(s.color ?? null)].filter(Boolean).join(';'), dataset: { id: s.id },
    },
    el('div', { class: 'cover-main' },
      s.state ? el('span', { class: 'cover-pill' }, s.state) : null,
      s.image ? null : el('span', { class: 'cover-initials', 'aria-hidden': 'true' }, initialsOf(s.title)),
      el('h2', { class: 'cover-title', tabindex: '-1' }, s.title),
      s.meta || faces.length ? el('span', { class: 'cover-stats' }, faces.length ? el('span', { class: 'cover-faces', 'aria-hidden': 'true' }, ...faces.map((f) => renderMedal({ size: 26, ...f }))) : null, s.meta ?? '') : null));
  }

  function paint(): void {
    if (!slides.length) { replace(slideBox); return; }
    replace(slideBox, slide(slides[at]!, at));
    prev.disabled = at === 0;
    next.disabled = at === slides.length - 1;
    replace(dots, ...slides.map((s, i) => el('button', {
      type: 'button', class: 'cover-dot', 'aria-label': [s.title, s.state].filter(Boolean).join(', '), 'aria-current': i === at ? 'true' : null,
      ...mark('punto', 'Ir a esta portada'), onclick: () => api.go(i, true),
    })));
  }

  // Deslizar: solo un gesto horizontal claro; lo vertical sigue moviendo la página (`touch-action: pan-y`).
  let start: { x: number; y: number } | null = null;
  slideBox.addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest('button,a')) start = { x: e.clientX, y: e.clientY }; });
  slideBox.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) api.go(at + (dx < 0 ? 1 : -1), false);
  });
  slideBox.addEventListener('pointercancel', () => { start = null; });

  const api: CoverCarousel = {
    element,
    go(i, focus = false) {
      const target = Math.max(0, Math.min(slides.length - 1, i));
      if (target === at) return;
      at = target;
      paint();
      live.textContent = kt('{n} de {m}: {title}', { n: String(at + 1), m: String(slides.length), title: slides[at]!.title });
      if (focus) slideBox.querySelector<HTMLElement>('.cover-title')?.focus();
      options.onChange?.(slides[at]!, at);
    },
    index: () => at,
  };
  paint();
  return api;
}
