import { el, replace } from '@ikisai/ui-kit';
import type { ViewMount } from './shell.ts';

/** Sección anunciada pero aún no construida. */
export function mountPlaceholder(title: string, description: string): ViewMount {
  return ({ main }) => {
    replace(
      main,
      el('div', { class: 'pagehead' }, el('div', null, el('h2', null, title), el('p', null, description))),
      el('div', { class: 'empty' }, el('strong', null, 'En construcción'), 'Esta sección llega en una entrega próxima. Mientras tanto puedes trabajar con las reservas.'),
    );
    return () => undefined;
  };
}
