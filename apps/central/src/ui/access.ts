/**
 * Accesos (API.md §9.4): solo el owner humano de Central (una sola condición, `shell.ts`). Cuatro pestañas, cada una en
 * su módulo (Bloque 2, MUELA-085): Cuentas (cuadrícula cuentas × apps), Alta (persona primero), Agentes (grupos por app)
 * y Registro (por persona, con «Lo grave»). Todo necesita red; la última lista se pinta sin red mientras dure la sesión.
 */
import { el, replace } from '@ikisai/ui-kit';
import type { ViewMount } from './shell.ts';
import { fbMark } from './feedback.ts';
import { mountAccounts } from './access-accounts.ts';
import { mountInvite } from './access-invite.ts';
import { mountAgents } from './access-agents.ts';
import { mountLog } from './access-log.ts';
import type { AccessState } from './access-common.ts';

export { showSecret } from './access-common.ts';

export type AccessTab = 'cuentas' | 'alta' | 'agentes' | 'registro';

const TABS: Array<{ id: AccessTab; label: string; hash: string }> = [
  { id: 'cuentas', label: 'Cuentas', hash: '#/accesos' },
  { id: 'alta', label: 'Alta', hash: '#/accesos/alta' },
  { id: 'agentes', label: 'Agentes', hash: '#/accesos/agentes' },
  { id: 'registro', label: 'Registro', hash: '#/accesos/registro' },
];

export function mountAccess(tab: AccessTab): ViewMount {
  return (ctx) => {
    const { main, admin, client } = ctx;
    const body = el('div', { id: `access-${tab}` });
    // Ids fijos (el catálogo de la publicación solo recoge literales: kit 0.18.2).
    switch (tab) {
      case 'cuentas': fbMark(body, 'central.accesos.cuentas', 'Cuentas'); break;
      case 'alta': fbMark(body, 'central.accesos.alta', 'Alta'); break;
      case 'agentes': fbMark(body, 'central.accesos.agentes', 'Agentes'); break;
      case 'registro': fbMark(body, 'central.accesos.registro', 'Registro'); break;
    }
    replace(
      main,
      el('div', { class: 'pagehead', 'data-feedback-id': 'central.accesos.cabecera', 'data-feedback-label': 'Cabecera de Accesos' }, el('div', null, el('h2', null, 'Accesos'),
        el('p', null, 'Quién entra en cada app de Ikisai y con qué permiso.'))),
      el('nav', { class: 'segmented', 'aria-label': 'Secciones de accesos', 'data-feedback-id': 'central.accesos.pestanas', 'data-feedback-label': 'Pestañas de Accesos' },
        ...TABS.map((t) => el('a', { href: t.hash, class: t.id === tab ? 'active' : '', 'aria-current': t.id === tab ? 'page' : null, id: `tab-${t.id}` }, t.label))),
      body,
    );
    fbMark(main.querySelector('#tab-cuentas'), 'central.accesos.pestanas.cuentas', 'Pestaña Cuentas');
    fbMark(main.querySelector('#tab-alta'), 'central.accesos.pestanas.alta', 'Pestaña Alta');
    fbMark(main.querySelector('#tab-agentes'), 'central.accesos.pestanas.agentes', 'Pestaña Agentes');
    fbMark(main.querySelector('#tab-registro'), 'central.accesos.pestanas.registro', 'Pestaña Registro');
    const me = client.bootstrap()?.profile.userId ?? '';
    const state: AccessState = { alive: true, cleanups: [] };
    switch (tab) {
      case 'cuentas': void mountAccounts(body, admin, client, me, state, ctx.navigate, ctx.usage); break;
      case 'alta': void mountInvite(body, admin, client, ctx.navigate, ctx.usage, state); break;
      case 'agentes': void mountAgents(body, admin, state, ctx.usage); break;
      case 'registro': void mountLog(body, admin, state); break;
    }
    return () => { state.alive = false; for (const c of state.cleanups.splice(0)) c(); };
  };
}
