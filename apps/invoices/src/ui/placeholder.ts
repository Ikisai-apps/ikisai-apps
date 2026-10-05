import { el, replace } from './dom.ts';
import type { ViewMount } from './shell.ts';

/** Sección anunciada pero aún no construida. */
export function mountPlaceholder(title: string, description: string): ViewMount {
  return ({ main }) => {
    replace(
      main,
      el('div', { class: 'pagehead' }, el('div', null, el('h2', null, title), el('p', null, description))),
      el('div', { class: 'empty' }, el('strong', null, 'Pendiente de la fase 1'), 'Esta sección llegará con la siguiente entrega. Mientras tanto puedes gestionar los proveedores desde Inicio.'),
    );
    return () => undefined;
  };
}
