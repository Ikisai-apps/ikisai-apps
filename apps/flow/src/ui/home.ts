import { el, icon, openSheet, replace } from '@ikisai/ui-kit';
import type { ViewMount } from './shell.ts';

/**
 * Inicio (canon V1 §2.2): la pestaña de la casa, sin ocupar sitio encima de las colas. Carrusel con las cuatro guías
 * internas, con miniaturas para ir directo a una y «Ampliar» para verla entera. Las miniaturas se precargan; la guía a
 * tamaño completo solo se descarga al ampliarla (FLOW-DIR-001 §6). Estas guías nunca salen en la carta pública (§15.3).
 */
export const GUIDES = [
  { slug: 'montaditos', title: 'Montaditos · montaje y estaciones' },
  { slug: 'barra', title: 'Barra · bebidas y extras' },
  { slug: 'frigorifico', title: 'Frigorífico · almacenamiento y frío' },
  { slug: 'mesa', title: 'Mesa de trabajo · disposición y orden' },
] as const;

export const mountHome: ViewMount = ({ main }) => {
  let current = 0;
  const figure = el('figure', { class: 'guide-figure' });
  const thumbs = el('div', { class: 'guide-thumbs', role: 'tablist', 'aria-label': 'Guías' },
    ...GUIDES.map((g, i) => el('button', { type: 'button', class: 'guide-thumb', role: 'tab', 'aria-label': g.title, onclick: () => show(i) },
      el('img', { src: `/guias/${g.slug}-mini.webp`, alt: '', loading: 'lazy', decoding: 'async' }))));

  function show(i: number): void {
    current = (i + GUIDES.length) % GUIDES.length;
    const g = GUIDES[current]!;
    replace(figure,
      el('button', { type: 'button', class: 'guide-open', 'aria-label': `Ampliar: ${g.title}`, onclick: () => enlarge(current) },
        el('img', { src: `/guias/${g.slug}-mini.webp`, alt: g.title, decoding: 'async' })),
      el('figcaption', null, el('span', null, g.title), el('span', { class: 'muted small' }, `${current + 1} de ${GUIDES.length}`)));
    thumbs.querySelectorAll('.guide-thumb').forEach((b, j) => b.setAttribute('aria-selected', String(j === current)));
  }

  function enlarge(i: number): void {
    const g = GUIDES[i]!;
    openSheet({
      title: g.title,
      body: el('div', { class: 'guide-zoom' },
        el('img', { src: `/guias/${g.slug}.webp`, alt: g.title, decoding: 'async' }),
        el('a', { href: `/guias/${g.slug}.webp`, target: '_blank', rel: 'noopener' }, 'Abrir a pantalla completa')),
    });
  }

  main.append(
    el('h1', { class: 'col-title' }, 'Guías de la barra'),
    el('div', { class: 'guide-carousel', 'data-feedback-id': 'flow.inicio.guias', 'data-feedback-label': 'Guías' },
      el('button', { type: 'button', class: 'iconbtn guide-prev', 'aria-label': 'Guía anterior', onclick: () => show(current - 1) }, icon('chevronLeft', 22)),
      figure,
      el('button', { type: 'button', class: 'iconbtn guide-next', 'aria-label': 'Guía siguiente', onclick: () => show(current + 1) }, icon('chevronRight', 22))),
    thumbs,
  );
  show(0);
  return () => undefined;
};
