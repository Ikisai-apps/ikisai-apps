import { el } from '@ikisai/ui-kit';
import type { ViewMount } from './shell.ts';

/**
 * Inicio del primer incremento: saludo y aviso de que Flow está en preparación. Sin datos ni acciones de negocio hasta
 * que llegue el documento funcional (docs/flow/ESTADO.md).
 */
export const mountHome: ViewMount = ({ main, client }) => {
  const name = client.bootstrap()?.profile.displayName ?? '';
  main.append(
    el('h1', {}, name ? `Hola, ${name}` : 'Hola'),
    el('section', { class: 'card soon', 'data-feedback-id': 'flow.inicio.preparacion', 'data-feedback-label': 'En preparación' },
      el('h2', {}, 'Flow está en preparación'),
      el('p', { class: 'muted' }, 'Ya puedes entrar con tu cuenta de Ikisai. Las pantallas de trabajo llegarán en las próximas versiones.'),
    ),
  );
  return () => undefined;
};
