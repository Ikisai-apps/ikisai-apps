import { el, icon, plural, replace } from '@ikisai/ui-kit';
import { canSeeReserved, recentDecisions, todayInMadrid, type DueItem } from '@ikisai/domain-central';
import { computeDue, createDueQueue, plazo, type Data, type DueQueue } from './compliance.ts';
import { mountDashboard } from './dashboard.ts';
import { T } from '../app/client.ts';
import { fbMark } from './feedback.ts';
import type { ViewMount } from './shell.ts';

const ROLE_TEXT: Record<string, string> = {
  owner: 'Administras el ecosistema: cuentas y accesos de todas las apps.',
  editor: 'Puedes editar en Central.',
  reader: 'Puedes consultar Central.',
};

const dueHref = (x: DueItem) => (x.source === 'person_record' ? `#/personas/${x.parentId}` : x.source === 'requirement' ? `#/cumplimiento/${x.id}` : x.parentId ? `#/cumplimiento/${x.parentId}` : '#/cumplimiento/documentos');

/**
 * Inicio (MUELA-004 y 069, con las recomendaciones aprobadas por VG):
 * - Lo que vence, una cosa cada vez (orden de `computeDue`), y debajo las 4 siguientes con su fecha; «Ver todo» lleva a
 *   Vencimientos. La documentación de personas solo para quien ve datos reservados.
 * - Para quien administra, las 4 tarjetas de Accesos (con red).
 * - Las tres últimas decisiones y los enlaces de siempre (Decisiones, Textos y Entidad; también están en el menú).
 * - El panel de Dirección; sin red dice de cuándo son sus indicadores, sin rojo (el rojo de «Sin conexión» va en el menú).
 */
export const mountHome: ViewMount = (ctx) => {
  const { main, client, admin, isAdmin, navigate, usage } = ctx;
  const boot = client.bootstrap();
  const canEdit = boot?.membership.role !== 'reader';
  const summary = el('div', { class: 'homecards', id: 'homeSummary', 'data-feedback-id': 'central.inicio.resumen', 'data-feedback-label': 'Resumen de cuentas' });
  const docs = el('section', { id: 'homeDocs', class: 'ctl-block', 'data-feedback-id': 'central.inicio.vencimientos', 'data-feedback-label': 'Vencimientos' });
  const decisions = el('section', { id: 'homeDecisionsBlock', class: 'ctl-block', 'data-feedback-id': 'central.inicio.decisiones', 'data-feedback-label': 'Últimas decisiones' });
  const dashboardHost = el('div', { 'data-feedback-id': 'central.inicio.direccion', 'data-feedback-label': 'Panel de dirección' });
  replace(
    main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.inicio.cabecera', 'data-feedback-label': 'Cabecera de Inicio' }, el('div', null,
      el('h2', { 'data-feedback-ignore': '' }, boot?.profile.displayName ? `Hola, ${boot.profile.displayName}` : 'Ikisai Central'),
      el('p', null, ROLE_TEXT[boot?.membership.role ?? 'reader'] ?? ''))),
    docs,
    summary,
    decisions,
    el('div', { class: 'ctl-links', 'data-feedback-id': 'central.inicio.enlaces', 'data-feedback-label': 'Enlaces' },
      el('a', { class: 'homelink', href: '#/decisiones', id: 'homeDecisions', 'data-feedback-id': 'central.inicio.enlaces.decisiones', 'data-feedback-label': 'Registro de decisiones' }, icon('history', 18), 'Registro de decisiones', el('span', { class: 'muted small' }, 'qué se decidió, por qué y cómo se aplica')),
      el('a', { class: 'homelink', href: '#/textos', id: 'homeTexts', 'data-feedback-id': 'central.inicio.textos', 'data-feedback-label': 'Textos y contacto' }, icon('list', 18), 'Textos y contacto', el('span', { class: 'muted small' }, 'avisos legales, declaraciones, mensajes y contacto de los portales')),
      el('a', { class: 'homelink', href: '#/entidad', id: 'homeEntity', 'data-feedback-id': 'central.inicio.enlaces.entidad', 'data-feedback-label': 'Datos de la entidad' }, icon('briefcase', 18), 'Datos de la entidad', el('span', { class: 'muted small' }, 'razón social, NIF/CIF, domicilio y logotipo'))),
    dashboardHost,
  );

  // Lo que vence (obligaciones, documentos clave y, para quien la ve, documentación de personas), calculado en el dispositivo.
  let data: Data | null = null;
  let due: DueItem[] = [];
  let queue: DueQueue | null = null;
  const next = el('ul', { class: 'ctl-next', 'data-feedback-id': 'central.inicio.vencimientos.siguientes', 'data-feedback-label': 'Las siguientes' });
  function paintNext(): void {
    if (!queue) return;
    const ids = queue.pending().slice(1, 5);
    const rows = ids.map((id) => due.find((x) => x.id === id)).filter((x): x is DueItem => !!x);
    replace(next, ...rows.map((x) => el('li', null,
      el('a', { href: dueHref(x), 'data-feedback-id': 'central.inicio.vencimientos.enlace', 'data-feedback-label': 'Vencimiento' }, el('span', { 'data-feedback-ignore': '' }, x.title)),
      el('span', { class: `ctl-nextwhen${x.state === 'vencido' ? ' alert' : ''}` }, plazo(x.dueOn, x.source === 'requirement' ? ['Vence el', 'Venció el'] : ['Caduca el', 'Caducó el'])))));
    next.hidden = rows.length === 0;
  }
  async function paintDocs(): Promise<void> {
    const [requirements, documents, people, records] = await Promise.all([
      client.list(T.requirements), client.list(T.keyDocuments), client.list(T.people), canSeeReserved(boot?.membership) ? client.list(T.personRecords) : Promise.resolve([]),
    ]);
    data = { requirements, documents, links: [], people, records } as unknown as Data;
    due = computeDue(data, todayInMadrid());
    if (!due.length) { queue = null; replace(docs); return; }
    const expired = due.filter((x) => x.state === 'vencido').length;
    if (queue) queue.setDue(due);
    else queue = createDueQueue(ctx, () => data!, due, { canEdit, onAll: () => navigate('#/cumplimiento'), where: 'inicio', onChange: paintNext });
    replace(docs,
      el('div', { class: 'blockhead' }, el('h3', null, 'Lo que vence'),
        el('span', { class: 'hint' }, [expired ? plural(expired, 'vencido', 'vencidos') : '', due.length - expired ? plural(due.length - expired, 'vence pronto', 'vencen pronto') : ''].filter(Boolean).join(' · '))),
      queue.element, next);
    paintNext();
  }
  void paintDocs();
  const offs = [T.requirements, T.keyDocuments, T.personRecords, T.people].map((t) => client.onTable(t, () => void paintDocs()));

  // Las tres últimas decisiones vigentes (las «Reciente» de Decisiones).
  async function paintDecisions(): Promise<void> {
    const rows = recentDecisions((await client.list(T.decisions)) as never, 3) as unknown as Array<{ id: string; name: string; code: string | null; decided_on: string }>;
    replace(decisions, rows.length ? el('div', { class: 'blockhead' }, el('h3', null, 'Últimas decisiones')) : null,
      rows.length ? el('ul', { class: 'ctl-next' }, ...rows.map((d) => el('li', null,
        el('a', { href: `#/decisiones/${d.id}`, 'data-feedback-id': 'central.inicio.decisiones.enlace', 'data-feedback-label': 'Decisión' }, d.name),
        el('span', { class: 'ctl-nextwhen', 'data-feedback-ignore': '' }, `${d.code ?? ''} · ${d.decided_on.split('-').reverse().join('/')}`)))) : null);
  }
  void paintDecisions();
  offs.push(client.onTable(T.decisions, () => void paintDecisions()));

  // `#/?direccion=<app>` (desde el menú): abre ese grupo del panel y baja hasta él.
  const focusApp = new URLSearchParams(location.hash.split('?')[1] ?? '').get('direccion');
  const unmountDashboard = mountDashboard(dashboardHost, client, isAdmin, usage, focusApp ?? (location.hash.includes('direccion') ? '' : null));

  const cleanup = () => { offs.forEach((off) => off()); unmountDashboard(); };
  if (!isAdmin) return cleanup;

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
        fbMark(card('homeAccounts', 'Cuentas', String(humans.length), disabled ? `${plural(disabled, 'desactivada', 'desactivadas')}` : 'personas con acceso', '#/accesos'), 'central.inicio.resumen.cuentas', 'Cuentas'),
        fbMark(card('homeAgents', 'Agentes', String(activeKeys), plural(activeKeys, 'clave activa', 'claves activas'), '#/accesos/agentes'), 'central.inicio.resumen.agentes', 'Agentes'),
        fbMark(card('homeInvite', 'Alta', '+', 'dar acceso a una persona nueva', '#/accesos/alta'), 'central.inicio.resumen.alta', 'Alta'),
        fbMark(card('homeLog', 'Registro', '', 'quién cambió qué y cuándo', '#/accesos/registro'), 'central.inicio.resumen.registro', 'Registro'),
      );
    } catch {
      if (!alive) return;
      replace(summary, el('p', { class: 'muted' }, icon('offline', 18), ' Sin conexión: el resumen de cuentas necesita red.'));
    }
  }
  void load();
  return () => { alive = false; cleanup(); };
};
