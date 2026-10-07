import { el, icon, plural, replace } from '@ikisai/ui-kit';
import type { ViewMount } from './shell.ts';

const ROLE_TEXT: Record<string, string> = {
  owner: 'Administras el ecosistema: cuentas y accesos de todas las apps.',
  editor: 'Puedes editar en Central.',
  reader: 'Puedes consultar Central.',
};

/**
 * Inicio. En V1-a: quién eres en Central y, si administras, un resumen de cuentas y agentes con acceso rápido.
 * El panel de dirección (KPIs) y los vencimientos llegan con sus bloques (API.md §13).
 */
export const mountHome: ViewMount = ({ main, client, admin, isAdmin, navigate }) => {
  const boot = client.bootstrap();
  const summary = el('div', { class: 'homecards', id: 'homeSummary' });
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null,
      el('h2', null, boot?.profile.displayName ? `Hola, ${boot.profile.displayName}` : 'Ikisai Central'),
      el('p', null, ROLE_TEXT[boot?.membership.role ?? 'reader'] ?? ''))),
    summary,
    el('section', { class: 'card soon' },
      el('h3', null, 'Próximamente en Central'),
      el('ul', { class: 'plainlist' },
        el('li', null, 'Datos de la entidad (razón social, NIF, domicilio y logotipo) para propuestas y facturas.'),
        el('li', null, 'Personas: ficha, contacto reservado, documentación y formación con caducidad.'),
        el('li', null, 'Cumplimiento: obligaciones legales, seguros y licencias con sus vencimientos.'),
        el('li', null, 'Panel de dirección con los indicadores de cada app.'))),
  );

  if (!isAdmin) return () => {};

  function card(id: string, title: string, value: string, hint: string, hash: string): HTMLElement {
    return el('button', { class: 'homecard', type: 'button', id, onclick: () => navigate(hash) },
      el('span', { class: 'homecard-title' }, title), el('strong', null, value), el('span', { class: 'muted' }, hint));
  }

  let alive = true;
  async function load(): Promise<void> {
    replace(summary, el('p', { class: 'muted' }, 'Cargando cuentas…'));
    try {
      const [accounts, agents] = await Promise.all([admin.accounts(), admin.agents()]);
      if (!alive) return;
      const humans = accounts.filter((a) => a.kind !== 'agent');
      const disabled = humans.filter((a) => a.disabled).length;
      const activeKeys = agents.filter((k) => !k.revokedAt).length;
      replace(summary,
        card('homeAccounts', 'Cuentas', String(humans.length), disabled ? `${plural(disabled, 'desactivada', 'desactivadas')}` : 'personas con acceso', '#/accesos'),
        card('homeAgents', 'Agentes', String(activeKeys), plural(activeKeys, 'clave activa', 'claves activas'), '#/accesos/agentes'),
        card('homeInvite', 'Alta', '+', 'dar acceso a una persona nueva', '#/accesos/alta'),
        card('homeLog', 'Registro', '', 'quién cambió qué y cuándo', '#/accesos/registro'),
      );
    } catch {
      if (!alive) return;
      replace(summary, el('p', { class: 'muted' }, icon('offline', 18), ' Sin conexión: el resumen de cuentas necesita red.'));
    }
  }
  void load();
  return () => { alive = false; };
};
