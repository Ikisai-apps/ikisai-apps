import { el, icon, plural, replace } from '@ikisai/ui-kit';
import { canSeeReserved, todayInMadrid } from '@ikisai/domain-central';
import { computeDue } from './compliance.ts';
import { mountDashboard } from './dashboard.ts';
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
export const mountHome: ViewMount = ({ main, client, admin, isAdmin, navigate, usage }) => {
  const boot = client.bootstrap();
  const summary = el('div', { class: 'homecards', id: 'homeSummary', 'data-feedback-id': 'central.inicio.resumen', 'data-feedback-label': 'Resumen de cuentas' });
  const docs = el('div', { id: 'homeDocs', 'data-feedback-id': 'central.inicio.vencimientos', 'data-feedback-label': 'Vencimientos' });
  const dashboardHost = el('div', { 'data-feedback-id': 'central.inicio.direccion', 'data-feedback-label': 'Panel de dirección' });
  replace(
    main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.inicio.cabecera', 'data-feedback-label': 'Cabecera de Inicio' }, el('div', null,
      el('h2', { 'data-feedback-ignore': '' }, boot?.profile.displayName ? `Hola, ${boot.profile.displayName}` : 'Ikisai Central'),
      el('p', null, ROLE_TEXT[boot?.membership.role ?? 'reader'] ?? ''))),
    docs,
    summary,
    el('a', { class: 'homelink', href: '#/decisiones', id: 'homeDecisions', 'data-feedback-id': 'central.inicio.enlaces.decisiones', 'data-feedback-label': 'Registro de decisiones' }, icon('history', 18), 'Registro de decisiones', el('span', { class: 'muted small' }, 'qué se decidió, por qué y cómo se aplica')),
    el('a', { class: 'homelink', href: '#/entidad', id: 'homeEntity', 'data-feedback-id': 'central.inicio.enlaces.entidad', 'data-feedback-label': 'Datos de la entidad' }, icon('briefcase', 18), 'Datos de la entidad', el('span', { class: 'muted small' }, 'razón social, NIF/CIF, domicilio y logotipo')),
    dashboardHost,
  );

  // Lo que vence (obligaciones, documentos clave y, para quien la ve, documentación de personas), calculado en el dispositivo.
  async function paintDocs(): Promise<void> {
    const raw = {
      requirements: await client.list(T.requirements), documents: await client.list(T.keyDocuments), links: [], people: await client.list(T.people),
      records: canSeeReserved(boot?.membership) ? await client.list(T.personRecords) : [],
    } as unknown as Parameters<typeof computeDue>[0];
    const due = computeDue(raw, todayInMadrid());
    if (!due.length) { replace(docs); return; }
    const expired = due.filter((x) => x.state === 'vencido').length;
    const href = (x: (typeof due)[number]) => x.source === 'person_record' ? `#/personas/${x.parentId}` : x.source === 'requirement' ? `#/cumplimiento/${x.id}` : x.parentId ? `#/cumplimiento/${x.parentId}` : '#/cumplimiento/documentos';
    replace(docs, el('section', { class: 'card duecard', 'data-feedback-id': 'central.inicio.vencimientos.tarjeta', 'data-feedback-label': 'Vence pronto' },
      el('h3', null, icon('warn', 18), ' Vence pronto'),
      el('p', null, [expired ? plural(expired, 'vencido', 'vencidos') : '', due.length - expired ? plural(due.length - expired, 'vence pronto', 'vencen pronto') : ''].filter(Boolean).join(' · ')),
      el('ul', { class: 'plainlist', 'data-feedback-id': 'central.inicio.vencimientos.lista', 'data-feedback-label': 'Lista de vencimientos' }, ...due.slice(0, 5).map((x) => el('li', null,
        el('a', { href: href(x), 'data-feedback-id': 'central.inicio.vencimientos.enlace', 'data-feedback-label': 'Vencimiento' }, x.title), x.state === 'vencido' ? ` · venció el ${x.dueOn.split('-').reverse().join('/')}` : ` · vence el ${x.dueOn.split('-').reverse().join('/')}`))),
      due.length > 5 ? el('a', { href: '#/cumplimiento', 'data-feedback-id': 'central.inicio.vencimientos.ver_todos', 'data-feedback-label': 'Ver todos los vencimientos' }, 'Ver todos los vencimientos') : null));
  }
  void paintDocs();
  const unmountDashboard = mountDashboard(dashboardHost, client, isAdmin, usage);

  if (!isAdmin) return () => unmountDashboard();

  function card(id: string, title: string, value: string, hint: string, hash: string, slug: string): HTMLElement {
    return el('button', { class: 'homecard', type: 'button', id, 'data-feedback-id': `central.inicio.resumen.${slug}`, 'data-feedback-label': title, onclick: () => navigate(hash) },
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
        card('homeAccounts', 'Cuentas', String(humans.length), disabled ? `${plural(disabled, 'desactivada', 'desactivadas')}` : 'personas con acceso', '#/accesos', 'cuentas'),
        card('homeAgents', 'Agentes', String(activeKeys), plural(activeKeys, 'clave activa', 'claves activas'), '#/accesos/agentes', 'agentes'),
        card('homeInvite', 'Alta', '+', 'dar acceso a una persona nueva', '#/accesos/alta', 'alta'),
        card('homeLog', 'Registro', '', 'quién cambió qué y cuándo', '#/accesos/registro', 'registro'),
      );
    } catch {
      if (!alive) return;
      replace(summary, el('p', { class: 'muted' }, icon('offline', 18), ' Sin conexión: el resumen de cuentas necesita red.'));
    }
  }
  void load();
  return () => { alive = false; unmountDashboard(); };
};
