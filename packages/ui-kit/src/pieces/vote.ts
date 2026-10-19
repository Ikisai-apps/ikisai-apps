/**
 * Votar deslizando (MUELA-075: Central Decisiones y Food Platos sugeridos): un mazo de tarjetas; a la derecha, a favor
 * («Se mantiene», «Aprobar»), a la izquierda, en contra («Retirar», «Descartar»). Los votos orientan; decide quien
 * administra, y eso es de la app, igual que la cola y los recuentos.
 * - Alternativas al gesto: dos botones grandes y las flechas ← → con el foco en el mazo.
 * - Gesto: más de 40 px enseña el sello; más de 90 px vota; un movimiento sobre todo vertical deja mover la página
 *   (`touch-action: pan-y`).
 * - Con movimiento reducido, la tarjeta no gira ni sale volando: cambia sin animación.
 * Prefijo de clases: `vote-`.
 */
import { el, replace, type Child } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';

export type Vote = 'keep' | 'drop';

export interface VoteTexts {
  /** Botón y sello a favor («Se mantiene», «Aprobar»). */
  keep: string;
  drop: string;
  /** Nombre accesible de los botones («Se mantiene: votar para que siga»). */
  keepLabel?: string;
  dropLabel?: string;
  /** Cómo se usa («Desliza la tarjeta: a la derecha se mantiene…»). */
  hint?: string;
  /** Al acabar («Has revisado todas las vigentes»). */
  empty?: string;
  /** Botón para ver la tarjeta entera («Leer entera»). */
  open?: string;
}

export interface VoteDeckOptions<T extends { id: string }> {
  /** Título del bloque («¿Se mantienen?»). */
  label: string;
  items: T[];
  /** Lo de dentro de cada tarjeta (lo pinta la app: medallón, título, por qué, recuento). */
  card: (item: T) => Child;
  /** Nombre corto de la tarjeta para el lector y los avisos. */
  name: (item: T) => string;
  onVote: (item: T, vote: Vote) => void;
  onOpen?: (item: T) => void;
  /** «Volver a empezar» al acabar. */
  onRestart?: () => void;
  texts: VoteTexts;
  feedbackId?: string;
}

export interface VoteDeck<T> {
  element: HTMLElement;
  setItems(items: T[]): void;
  /** Votar la de arriba sin gesto (lo mismo que los botones). */
  vote(vote: Vote): void;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createVoteDeck<T extends { id: string }>(options: VoteDeckOptions<T>): VoteDeck<T> {
  let items = options.items.slice();
  const t = options.texts;
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const progress = el('span', { class: 'vote-progress' });
  let seen = 0;
  const start = items.length;
  const stack = el('div', {
    class: 'vote-stack', tabindex: '0', role: 'group',
    'aria-label': kt('{label}: desliza a la derecha para «{keep}» o a la izquierda para «{drop}»; también con las flechas', { label: options.label, keep: t.keep, drop: t.drop }),
    onkeydown: (e: Event) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); api.vote(k === 'ArrowRight' ? 'keep' : 'drop'); }
    },
  });
  const live = el('p', { class: 'vh', 'aria-live': 'polite' });
  const actions = el('div', { class: 'vote-actions' });
  const element = el('section', { class: 'vote-box', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) },
    el('div', { class: 'vote-head' }, el('h3', null, options.label), progress),
    stack, actions, t.hint ? el('p', { class: 'hint vote-hint' }, t.hint) : null, live);

  let busy = false;
  function paint(): void {
    progress.textContent = start ? kt('{n} de {m}', { n: String(Math.min(seen + 1, start)), m: String(start) }) : '';
    if (!items.length) {
      replace(stack, el('div', { class: 'vote-empty' }, el('p', { tabindex: '-1' }, t.empty ?? kt('No queda nada por votar.')),
        options.onRestart ? el('button', { type: 'button', class: 'ghost', ...mark('reiniciar', 'Volver a empezar'), onclick: () => options.onRestart!() }, kt('Volver a empezar')) : null));
      replace(actions);
      stack.setAttribute('tabindex', '-1');
      return;
    }
    stack.setAttribute('tabindex', '0');
    const shown = items.slice(0, 3);
    replace(stack, ...shown.map((item, i) => el('article', { class: `vote-card${i ? ` vote-behind vote-d${i}` : ''}`, dataset: { id: item.id }, 'aria-hidden': i ? 'true' : null },
      i ? null : el('span', { class: 'vote-stamp vote-keep', 'aria-hidden': 'true' }, t.keep),
      i ? null : el('span', { class: 'vote-stamp vote-drop', 'aria-hidden': 'true' }, t.drop),
      options.card(item))).reverse());
    const top = items[0]!;
    replace(actions,
      el('button', { type: 'button', class: 'vote-btn vote-btn-drop', 'aria-label': t.dropLabel ?? t.drop, ...mark('en_contra', t.drop), onclick: () => api.vote('drop') }, '✕', el('span', null, t.drop)),
      options.onOpen ? el('button', { type: 'button', class: 'ghost vote-open', ...mark('abrir', t.open ?? 'Ver entera'), onclick: () => options.onOpen!(top) }, t.open ?? kt('Ver entera')) : null,
      el('button', { type: 'button', class: 'vote-btn vote-btn-keep', 'aria-label': t.keepLabel ?? t.keep, ...mark('a_favor', t.keep), onclick: () => api.vote('keep') }, '✓', el('span', null, t.keep)));
  }

  // --- Gesto -------------------------------------------------------------------------------------------------
  let drag: { x: number; y: number; dx: number; card: HTMLElement; id: number } | null = null;
  stack.addEventListener('pointerdown', (e) => {
    const card = stack.querySelector<HTMLElement>('.vote-card:not(.vote-behind)');
    if (!card || busy || (e.target as HTMLElement).closest('button,a,input')) return;
    drag = { x: e.clientX, y: e.clientY, dx: 0, card, id: e.pointerId };
    card.classList.add('vote-dragging');
  });
  stack.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dx) < 12) return;
    drag.dx = dx;
    if (!reduced()) drag.card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    drag.card.classList.toggle('vote-tilt-keep', dx > 40);
    drag.card.classList.toggle('vote-tilt-drop', dx < -40);
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dx, card } = drag;
    drag = null;
    card.classList.remove('vote-dragging');
    if (dx > 90) api.vote('keep');
    else if (dx < -90) api.vote('drop');
    else { card.style.transform = ''; card.classList.remove('vote-tilt-keep', 'vote-tilt-drop'); }
  };
  stack.addEventListener('pointerup', end);
  stack.addEventListener('pointercancel', end);

  const api: VoteDeck<T> = {
    element,
    setItems(next) { items = next.slice(); paint(); },
    vote(vote) {
      const item = items[0];
      if (!item || busy) return;
      busy = true;
      const card = stack.querySelector<HTMLElement>('.vote-card:not(.vote-behind)');
      const finish = () => {
        busy = false;
        items = items.slice(1);
        seen += 1;
        options.onVote(item, vote);
        live.textContent = `${options.name(item)}: ${vote === 'keep' ? t.keep : t.drop}`;
        const hadFocus = element.contains(document.activeElement);
        paint();
        if (hadFocus) (items.length ? stack : stack.querySelector<HTMLElement>('.vote-empty p'))?.focus();
      };
      if (card && !reduced()) {
        card.style.transform = '';
        card.classList.add(vote === 'keep' ? 'vote-gone-keep' : 'vote-gone-drop');
        setTimeout(finish, 260);
      } else finish();
    },
  };
  paint();
  return api;
}
