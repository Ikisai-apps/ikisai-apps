import { createQueue, deadlineInfo, el, icon, plural, replace, toastWithAction, type Queue, type QueueItem } from '@ikisai/ui-kit';
import {
  ATTENTION_RANK_LABELS, attentionSummary, canSeeReserved, centralAttention, formatKpi, formatPeriod, recentDecisions, todayInMadrid,
  type AttentionItem, type AttentionKpi, type DueItem,
} from '@ikisai/domain-central';
import { computeDue, dueText, openDue, openMarkDone, plazo, sourceLabel, undoMarkDone, type Data } from './compliance.ts';
import { APP_NAMES, mountDashboard } from './dashboard.ts';
import { T } from '../app/client.ts';
import { fbMark } from './feedback.ts';
import type { ViewMount } from './shell.ts';

const ROLE_TEXT: Record<string, string> = {
  owner: 'Administras el ecosistema: cuentas y accesos de todas las apps.',
  editor: 'Puedes editar en Central.',
  reader: 'Puedes consultar Central.',
};

const appName = (app: string) => APP_NAMES[app] ?? app;

/**
 * Inicio (MUELA-004 y 069; orden confirmado por VG en la 089):
 * - **Lo que urge**, una sola cola, una cosa cada vez: obligaciones, documentos clave, documentación de personas (solo para
 *   quien ve datos reservados) y los avisos de las otras apps (indicadores del panel en crítico o en atención). El orden es
 *   `centralAttention` del 004: lo que bloquea, lo crítico, lo vencido, lo que pide atención y lo que vence pronto.
 *   - La obligación lleva «Resolver y siguiente» (quien edita), con «Deshacer». El indicador, «Abrir» su app: sigue en la
 *     cola hasta que se resuelve allí. Lo demás, «Ver». Y siempre «Siguiente».
 *   - Debajo, las siguientes con su fecha o su estado, y «Ver todo» con la lista entera en el mismo orden; tocar una la sube
 *     a la tarjeta.
 * - Para quien administra, las 4 tarjetas de Accesos (con red).
 * - Las tres últimas decisiones y los enlaces de siempre (Decisiones, Textos y Entidad; también están en el menú).
 * - El panel de Dirección; sin red dice de cuándo son sus indicadores, sin rojo (el rojo de «Sin conexión» va en el menú).
 */
export const mountHome: ViewMount = (ctx) => {
  const { main, client, admin, isAdmin, navigate, usage } = ctx;
  const boot = client.bootstrap();
  const canEdit = boot?.membership.role !== 'reader';
  const summary = el('div', { class: 'homecards', id: 'homeSummary', 'data-feedback-id': 'central.inicio.resumen', 'data-feedback-label': 'Resumen de cuentas' });
  const docs = el('section', { id: 'homeDocs', class: 'ctl-block', 'data-feedback-id': 'central.inicio.vencimientos', 'data-feedback-label': 'Lo que urge' });
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

  // --- Lo que urge ------------------------------------------------------------------------------------------------
  let data: Data | null = null;
  let due: DueItem[] = [];
  let kpis: AttentionKpi[] = [];
  let order: AttentionItem[] = [];
  /** Lo que ya se ha resuelto aquí (obligaciones marcadas): sale de la cola hasta que vuelva a vencer. */
  const passed = new Set<string>();
  let queue: Queue | null = null;
  let showAll = false;
  const byKey = new Map<string, AttentionItem>();
  const queueHost = el('div');
  const head = el('div', { class: 'blockhead' });
  const next = el('ul', { class: 'ctl-next', id: 'homeNext', 'data-feedback-id': 'central.inicio.vencimientos.siguientes', 'data-feedback-label': 'Las siguientes' });

  function openKpi(k: AttentionKpi): void {
    if (!k.link) return;
    if (k.link.startsWith('https://central.ikisai.com/')) { const hash = k.link.slice('https://central.ikisai.com/'.length); navigate(hash.startsWith('#') ? hash : `#${hash}`); return; }
    window.open(k.link, '_blank', 'noopener');
  }

  function toItem(a: AttentionItem): QueueItem {
    if (a.kind === 'kpi') {
      const k = a.kpi;
      return { id: a.key, title: k.label, tone: k.state === 'critico' ? 'alert' : 'warn', toneText: `${ATTENTION_RANK_LABELS[a.rank]} · ${appName(k.app)}`,
        value: formatKpi(k.value, k.unit), facts: [`Indicador de ${appName(k.app)}`, formatPeriod(k.period), 'Se resuelve en su app'] };
    }
    const i = a.due;
    const info = deadlineInfo(i.dueOn);
    return {
      id: a.key, title: i.title, tone: i.state === 'vencido' || i.blocksOperation ? 'alert' : 'warn',
      toneText: [i.blocksOperation ? 'Bloquea la operación' : '', i.state === 'vencido' ? 'Vencido' : 'Vence pronto'].filter(Boolean).join(' · '),
      value: info.left.charAt(0).toUpperCase() + info.left.slice(1),
      facts: [sourceLabel(i), dueText(i), ...(i.code ? [i.code] : [])],
    };
  }

  function buildQueue(list: AttentionItem[]): Queue {
    return createQueue({
      label: 'Lo que urge, una cosa cada vez', items: list.map(toItem), feedbackId: 'central.inicio.vencimientos.cola',
      primary: (item) => {
        const a = byKey.get(item.id);
        if (!a || a.kind !== 'due' || !canEdit || a.due.source !== 'requirement') return null;
        const req = data?.requirements.find((r) => r.id === a.due.id);
        if (!req) return null;
        return { label: 'Resolver y siguiente', onClick: () => openMarkDone(client, usage, req, {
          onSaved: (before) => {
            passed.add(a.key);
            queue?.done();
            paintNext();
            toastWithAction('Obligación marcada como cumplida.', { label: 'Deshacer', onClick: () => void undoMarkDone(client, req.id, before).then((ok) => { if (ok) { passed.delete(a.key); queue?.undo(); paintNext(); } }) });
          },
        }) };
      },
      secondary: (item) => {
        const a = byKey.get(item.id);
        if (!a) return null;
        if (a.kind === 'kpi') return a.kpi.link ? { label: `Abrir ${appName(a.kpi.app)}`, onClick: () => { openKpi(a.kpi); queue?.skip(); } } : null;
        return { label: 'Ver', onClick: () => { if (data) openDue(ctx, data, a.due); } };
      },
      onAll: () => { showAll = !showAll; paintNext(); },
      doneTitle: 'Has pasado por todo', doneText: 'Lo que urge sigue aquí hasta que se resuelva.',
    });
  }

  /** La lista de debajo: las cuatro siguientes o, con «Ver todo», todas, en el mismo orden. Tocar una la sube a la tarjeta. */
  function paintNext(): void {
    const left = order.filter((a) => !passed.has(a.key));
    const now = queue?.current()?.id ?? null;
    const rest = left.filter((a) => a.key !== now);
    const rows = showAll ? rest : rest.slice(0, 4);
    replace(next, ...rows.map((a) => el('li', null,
      el('button', { type: 'button', class: 'linkbtn ctl-raise', dataset: { key: a.key }, 'data-feedback-id': 'central.inicio.vencimientos.enlace', 'data-feedback-label': 'Subir a la tarjeta', onclick: () => raise(a.key) },
        el('span', { 'data-feedback-ignore': '' }, a.kind === 'kpi' ? a.kpi.label : a.due.title)),
      el('span', { class: `ctl-nextwhen${a.rank <= 3 ? ' alert' : ''}` }, a.kind === 'kpi'
        ? `${ATTENTION_RANK_LABELS[a.rank]} · ${appName(a.kpi.app)}`
        : plazo(a.due.dueOn, a.due.source === 'requirement' ? ['Vence el', 'Venció el'] : ['Caduca el', 'Caducó el'])))));
    next.hidden = rows.length === 0;
  }

  function raise(key: string): void {
    const left = order.filter((a) => !passed.has(a.key));
    const chosen = left.find((a) => a.key === key);
    if (!chosen) return;
    queue = buildQueue([chosen, ...left.filter((a) => a.key !== key)]);
    replace(queueHost, queue.element);
    paintNext();
    queue.element.querySelector<HTMLElement>('.queue-main, .queue-minor button')?.focus({ preventScroll: true });
  }

  function paintAttention(): void {
    order = centralAttention(due, kpis);
    byKey.clear();
    for (const a of order) byKey.set(a.key, a);
    for (const k of [...passed]) if (!byKey.has(k)) passed.delete(k);
    const left = order.filter((a) => !passed.has(a.key));
    if (!order.length) { queue = null; replace(docs); return; }
    if (queue) queue.setItems(left.map(toItem));
    else { queue = buildQueue(left); replace(queueHost, queue.element); }
    replace(head, el('h3', null, 'Lo que urge'), el('span', { class: 'hint', id: 'homeAttentionSummary' }, attentionSummary(left)));
    if (!docs.contains(queueHost)) replace(docs, head, queueHost, next);
    paintNext();
  }

  async function paintDocs(): Promise<void> {
    const [requirements, documents, people, records] = await Promise.all([
      client.list(T.requirements), client.list(T.keyDocuments), client.list(T.people), canSeeReserved(boot?.membership) ? client.list(T.personRecords) : Promise.resolve([]),
    ]);
    data = { requirements, documents, links: [], people, records } as unknown as Data;
    due = computeDue(data, todayInMadrid());
    paintAttention();
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

  // `#/?direccion=<app>` (desde el menú): abre ese grupo del panel y baja hasta él. Sus indicadores en crítico o en
  // atención entran en la cola (los de la última lectura, también sin red).
  const focusApp = new URLSearchParams(location.hash.split('?')[1] ?? '').get('direccion');
  const unmountDashboard = mountDashboard(dashboardHost, client, isAdmin, usage, focusApp ?? (location.hash.includes('direccion') ? '' : null),
    (items) => { kpis = items; paintAttention(); });

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
