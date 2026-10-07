import { el, icon, plural, replace } from '@ikisai/ui-kit';
import { canSeeReserved, dueState, todayInMadrid } from '@ikisai/domain-central';
import { T } from '../app/client.ts';
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
  const docs = el('div', { id: 'homeDocs' });
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null,
      el('h2', null, boot?.profile.displayName ? `Hola, ${boot.profile.displayName}` : 'Ikisai Central'),
      el('p', null, ROLE_TEXT[boot?.membership.role ?? 'reader'] ?? ''))),
    docs,
    summary,
    el('section', { class: 'card soon' },
      el('h3', null, 'Próximamente en Central'),
      el('ul', { class: 'plainlist' },
        el('li', null, 'Cumplimiento: obligaciones legales, seguros y licencias con sus vencimientos.'),
        el('li', null, 'Panel de dirección con los indicadores de cada app.'))),
  );

  // Documentación de personas que caduca (solo quien ve los datos reservados), calculada en el dispositivo.
  async function paintDocs(): Promise<void> {
    if (!canSeeReserved(boot?.membership)) return;
    const today = todayInMadrid();
    const people = new Map((await client.list(T.people)).map((p) => [p.id, String(p.display_name ?? '')]));
    const due = (await client.list(T.personRecords))
      .filter((r) => people.has(String(r.person_id)) && r.status !== 'no_aplica')
      .map((r) => ({ r, state: dueState(r.expires_on as string | null, today, 30) }))
      .filter((x) => x.state !== 'al_dia');
    if (!due.length) { replace(docs); return; }
    const expired = due.filter((x) => x.state === 'vencido').length;
    replace(docs, el('section', { class: 'card duecard' },
      el('h3', null, icon('warn', 18), ' Documentación de personas'),
      el('p', null, [expired ? plural(expired, 'registro caducado', 'registros caducados') : '', due.length - expired ? plural(due.length - expired, 'caduca en 30 días', 'caducan en 30 días') : ''].filter(Boolean).join(' · ')),
      el('ul', { class: 'plainlist' }, ...due.slice(0, 5).map(({ r, state }) => el('li', null,
        el('a', { href: `#/personas/${String(r.person_id)}` }, people.get(String(r.person_id)) ?? ''), state === 'vencido' ? ' · caducado' : ` · caduca el ${String(r.expires_on).split('-').reverse().join('/')}`)))));
  }
  void paintDocs();

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
