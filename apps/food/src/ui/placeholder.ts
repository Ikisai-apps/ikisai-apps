import { el, replace } from './dom.ts';
import type { ViewMount } from './shell.ts';

/** Sección anunciada pero aún no construida. */
export function mountPlaceholder(title: string, description: string): ViewMount {
  return ({ main }) => {
    replace(
      main,
      el('div', { class: 'pagehead' }, el('div', null, el('h2', null, title), el('p', null, description))),
      el('div', { class: 'empty' }, el('strong', null, 'En construcción'), 'Esta sección llega en la siguiente entrega. El recetario y la maquinaria ya funcionan, también sin conexión.'),
    );
    return () => undefined;
  };
}
