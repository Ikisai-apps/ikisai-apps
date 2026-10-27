import type { RowOperation } from '@ikisai/sync-client';
import {
  bindOnline, confirmDialog, createQueue, el, icon, listRow, openSheet, renderAreaTabs, renderGroups, renderMedal, renderSteps, replace, toast,
  type QueueItem, type Sheet,
} from '@ikisai/ui-kit';
import {
  REVIEW_APPS, REVIEW_APP_LABELS, REVIEW_STEPS, REVIEW_STEP_LABELS, REVIEW_STEPS_TO_ACT, reviewProgress, screenOfReport, screensToAct, sortScreens,
  stepCounts, stepIndex, validateOperations, type ReviewStep,
} from '@ikisai/domain-central';
import { T, describeError, type Mirror } from '../app/client.ts';
import { guard } from '../app/guard.ts';
import type { ViewMount } from './shell.ts';

/**
 * Revisión (MUELA-027 y 069; migración `1512`, API.md §2.14): el avance de cada pantalla de las apps en los diez pasos del
 * cuadro y su feedback, dentro de Central. De arriba abajo:
 * - «Lo que te toca», una cosa cada vez. Quien administra: pantallas por valorar o validar, reportes nuevos por aprobar y
 *   arreglos por comprobar. Los demás, su parte (069, MUELA-086): los arreglos de lo que comentaron, por comprobar
 *   («Funciona» o «Sigue fallando», que el núcleo deja a quien lo informó).
 * - «Cuánto se ha hecho», paso a paso: «33 de 92 pantallas pasadas a Sevilla» y lo siguiente de cada app.
 * - El tablero: los diez pasos con su cifra y las pantallas del paso elegido, con filtro por app.
 * - La hoja de ruta por app, con sus pantallas, su paso y sus reportes.
 * Las pantallas las escribe solo quien administra («Importar pantallas» o «Nueva pantalla»); los demás ven el avance y lo
 * que comentaron. El feedback necesita red (sus botones, apagados con el motivo: `bindOnline`); el avance sale del espejo.
 */

type Screen = Mirror<{
  id: string; revision: number; deleted_at: string | null; app: string; name: string; step: string; url: string | null; route: string | null;
  feedback_prefix: string | null; handoff: string | null; note: string | null; position: number;
}>;
interface Report {
  id: string; code: string; originApp: string; message: string; display: string; reviewStatus?: string; blocking?: boolean; canVerify?: boolean;
  node: { id: string; path: string[] } | null; routeRaw?: string | null; createdAt: string;
}

/** Colores del cuadro de avance (VG, 15-10-2026): los mismos en el tablero, la leyenda y la ficha. */
const STEP_COLORS: Record<ReviewStep, string> = {
  cal: '#c63b2e', fuera: '#1d1d1b', sin: '#bdb7ab', hoy: '#e8822a', alt: '#e8822a', demo: '#f4cf3c', listo: '#f4cf3c', cons: '#2f6fb5', aprob: '#2f6fb5', hecha: '#2f8a45',
};
const APP_COLORS: Record<string, string> = {
  central: '#56663f', tasks: '#7a4f9a', invoices: '#2f6f6a', booking: '#b35a2b', food: '#9a6b14', guests: '#3b6aa0', organizers: '#8a3b5c', resources: '#5b6470', flow: '#2c6a87', transversal: '#4b4b4b',
};
const DISPLAY: Record<string, string> = { open: 'Abierto', in_progress: 'En curso', pending_verify: 'Por comprobar', verified: 'Verificado', dismissed: 'Descartado' };
const OPEN = new Set(['open', 'in_progress', 'pending_verify']);

const appName = (app: string) => REVIEW_APP_LABELS[app] ?? app;
const stepName = (step: string) => REVIEW_STEP_LABELS[step as ReviewStep] ?? step;
const firstLine = (text: string) => text.split('\n')[0]!.slice(0, 140);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const appMedal = (app: string) => renderMedal({ name: appName(app), color: APP_COLORS[app] ?? '#56663f', size: 40 });

const NEEDS_NETWORK = 'Aprobar, descartar y comprobar los reportes necesita conexión: el feedback se guarda en el momento.';

export const mountReview: ViewMount = ({ main, client, isAdmin, usage }) => {
  let screens: Screen[] = [];
  let reports: Report[] = [];
  let reportsState: 'loading' | 'ok' | 'offline' | 'error' = 'loading';
  let stepFilter: ReviewStep | null = null;
  let appFilter: string | null = new URLSearchParams(location.hash.split('?')[1] ?? '').get('app');
  const onlyMine = new URLSearchParams(location.hash.split('?')[1] ?? '').has('toca');
  let queue: ReturnType<typeof createQueue> | null = null;

  const queueHost = el('section', { class: 'ctl-rv-block', 'data-feedback-id': 'central.revision.toca', 'data-feedback-label': 'Lo que te toca' });
  const stepsHost = el('section', { class: 'ctl-rv-block', 'data-feedback-id': 'central.revision.avance', 'data-feedback-label': 'Cuánto se ha hecho' });
  const boardHost = el('section', { class: 'ctl-rv-block', id: 'reviewBoard', 'data-feedback-id': 'central.revision.tablero', 'data-feedback-label': 'Tablero' });
  const roadHost = el('section', { class: 'ctl-rv-block', 'data-feedback-id': 'central.revision.hoja_de_ruta', 'data-feedback-label': 'Hoja de ruta por app' });
  const note = el('p', { class: 'hint', id: 'reviewNote', role: 'status', 'data-feedback-id': 'central.revision.estado', 'data-feedback-label': 'Estado del feedback' });
  replace(main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.revision.cabecera', 'data-feedback-label': 'Cabecera de Revisión' },
      el('div', null, el('h2', null, 'Revisión'), el('p', null, 'Cómo va cada pantalla de las apps, en los diez pasos del cuadro, y lo que se ha comentado de ella.')),
      isAdmin ? el('div', { class: 'ctl-headtools' },
        el('a', { class: 'ghost btnlike', href: '#/revision/uso', id: 'openCoverage', 'data-feedback-id': 'central.revision.uso', 'data-feedback-label': 'Uso y cobertura' }, 'Uso y cobertura'),
        el('button', { class: 'ghost', type: 'button', id: 'importScreens', 'data-feedback-id': 'central.revision.importar', 'data-feedback-label': 'Importar pantallas', onclick: () => openImport() }, icon('upload', 18), 'Importar pantallas'),
        el('button', { class: 'primary', type: 'button', id: 'newScreen', 'data-feedback-id': 'central.revision.nueva', 'data-feedback-label': 'Nueva pantalla', onclick: () => openScreen(null) }, icon('plus', 18), 'Nueva pantalla')) : null),
    note, queueHost, stepsHost, boardHost, roadHost);
  // Los botones de la cola que necesitan red (se crean de nuevo con cada tarjeta): el motivo va en una sola línea.
  const queueWhy = el('div', { class: 'ctl-rv-why' });
  const queueWhyQuiet = el('div', { hidden: true });
  let unbindQueue: Array<() => void> = [];

  const live = () => sortScreens(screens);
  const reportsOf = (s: Screen) => reports.filter((r) => screenOfReport({ originApp: r.originApp, node: r.node, sourceRoute: r.routeRaw ?? null }, [s, ...live().filter((x) => x.id !== s.id)])?.id === s.id);
  const openReports = (s: Screen) => reportsOf(s).filter((r) => OPEN.has(r.display));

  // ---------------------------------------------------------------------------
  // Lo que te toca: una cosa cada vez
  // ---------------------------------------------------------------------------
  type Todo = { kind: 'screen'; screen: Screen } | { kind: 'review' | 'check'; report: Report };
  function todos(): Todo[] {
    // Quien no administra: solo los arreglos de lo que comentó (los reportes que lee son los suyos, `mine=true`).
    if (!isAdmin) return reports.filter((r) => r.display === 'pending_verify' && r.canVerify !== false).map((report) => ({ kind: 'check' as const, report }));
    const toReview = reports.filter((r) => r.reviewStatus === 'new');
    const toCheck = reports.filter((r) => r.reviewStatus !== 'new' && r.display === 'pending_verify');
    return [
      ...screensToAct(screens).map((screen) => ({ kind: 'screen' as const, screen })),
      ...toReview.map((report) => ({ kind: 'review' as const, report })),
      ...toCheck.map((report) => ({ kind: 'check' as const, report })),
    ];
  }
  const todoById = new Map<string, Todo>();
  function queueItems(): QueueItem[] {
    todoById.clear();
    return todos().map((t) => {
      if (t.kind === 'screen') {
        const s = t.screen;
        const id = `s:${s.id}`;
        todoById.set(id, t);
        const n = openReports(s).length;
        return { id, title: s.name, tone: 'warn' as const, toneText: s.step === 'alt' ? 'Prototipo por valorar' : 'Demo por validar',
          medal: { name: appName(s.app), color: APP_COLORS[s.app] },
          facts: [appName(s.app), stepName(s.step), n ? plural(n, 'comentario abierto', 'comentarios abiertos') : 'sin comentarios abiertos', ...(s.handoff ? [`Traspaso ${s.handoff}`] : [])] };
      }
      const r = t.report;
      const id = `r:${r.id}`;
      todoById.set(id, t);
      return { id, title: firstLine(r.message), tone: r.blocking ? 'alert' as const : 'warn' as const,
        toneText: t.kind === 'review' ? (r.blocking ? 'Nuevo · le bloquea' : 'Reporte nuevo') : 'Arreglo por comprobar',
        medal: { name: appName(r.originApp), color: APP_COLORS[r.originApp] }, value: r.code,
        facts: [appName(r.originApp), ...(r.node?.path?.length ? [r.node.path.join(' › ')] : [])] };
    });
  }
  async function act(report: Report, path: 'approve' | 'verify' | 'dismiss' | 'reopen', json: unknown, done: string): Promise<boolean> {
    try {
      const call = () => client.api(`/feedback/${encodeURIComponent(report.id)}/${path}`, { method: 'POST', json });
      // Ids de uso literales (el catálogo de la publicación solo recoge literales).
      if (path === 'approve') await usage.run('central.revision.aprobar', call);
      else if (path === 'verify') await usage.run('central.revision.funciona', call);
      else if (path === 'dismiss') await usage.run('central.revision.descartar', call);
      else await usage.run('central.revision.sigue_fallando', call);
      toast(done);
      reports = reports.map((r) => (r.id === report.id ? { ...r, reviewStatus: path === 'dismiss' ? 'rejected' : 'approved', display: path === 'verify' ? 'verified' : path === 'dismiss' ? 'dismissed' : path === 'reopen' ? 'open' : r.display } : r));
      return true;
    } catch (error) {
      toast(navigator.onLine ? describeError(error) : 'Sin conexión: el feedback necesita red.');
      return false;
    }
  }
  /** Ata a la red los botones de la tarjeta de ahora que la necesitan (aprobar, descartar, comprobar). */
  function bindQueue(): void {
    unbindQueue.forEach((off) => off());
    unbindQueue = [];
    const now = queue?.current();
    if (!now || todoById.get(now.id)?.kind === 'screen') return;
    const main = queueHost.querySelector<HTMLElement>('.queue-card [data-feedback-id="central.revision.toca.cola.principal"]');
    const minor = queueHost.querySelector<HTMLElement>('.queue-card [data-feedback-id="central.revision.toca.cola.secundaria"]');
    if (main) unbindQueue.push(bindOnline(main, { client, reason: NEEDS_NETWORK, reasonHost: queueWhy }));
    if (minor) unbindQueue.push(bindOnline(minor, { client, reason: NEEDS_NETWORK, reasonHost: queueWhyQuiet }));
  }
  function paintQueue(): void {
    // Quien no administra y no tiene nada suyo que comprobar no ve el bloque (sus reportes se leen con red).
    if (!isAdmin && (reportsState !== 'ok' || !todos().length) && !queue) { replace(queueHost); queueHost.hidden = true; return; }
    queueHost.hidden = false;
    const items = queueItems();
    if (queue) { queue.setItems(items); bindQueue(); return; }
    queue = createQueue({
      label: 'Lo que te toca', items, feedbackId: 'central.revision.toca.cola',
      primary: (item) => {
        const t = todoById.get(item.id);
        if (!t) return null;
        if (t.kind === 'screen') return { label: t.screen.url ? 'Abrir y siguiente' : 'Ver y siguiente', onClick: () => { if (t.screen.url) window.open(t.screen.url, '_blank', 'noopener'); else openScreen(t.screen); queue?.done(); } };
        if (t.kind === 'review') return { label: 'Aprobar y siguiente', onClick: async () => { if (await act(t.report, 'approve', {}, 'Aprobado: pasa al buzón del agente.')) queue?.done(); } };
        return { label: 'Funciona y siguiente', onClick: async () => { if (await act(t.report, 'verify', { build: null }, 'Verificado.')) queue?.done(); } };
      },
      secondary: (item) => {
        const t = todoById.get(item.id);
        if (!t || t.kind === 'screen') return null;
        return t.kind === 'review'
          ? { label: 'Descartar…', onClick: () => askReason(t.report, 'dismiss') }
          : { label: 'Sigue fallando…', onClick: () => askReason(t.report, 'reopen') };
      },
      onOpen: (item) => { const t = todoById.get(item.id); if (t?.kind === 'screen') openScreen(t.screen); else if (t) openReport(t.report); },
      onAll: () => { stepFilter = null; appFilter = null; paintBoard(); boardHost.scrollIntoView({ block: 'start' }); },
      doneTitle: 'Nada te espera',
      doneText: isAdmin ? 'Cuando una pantalla pase a «Prototipo hecho» o «Demo hecha», o llegue un reporte nuevo, saldrá aquí.'
        : 'Cuando arreglen algo que comentaste, saldrá aquí para que lo compruebes.',
    });
    replace(queueHost, el('h3', { class: 'ctl-rv-h' }, 'Lo que te toca'), queue.element, queueWhy, queueWhyQuiet);
    // La tarjeta se pinta de nuevo al pasar, saltar o deshacer: se vuelven a atar sus botones.
    new MutationObserver(() => bindQueue()).observe(queue.element, { childList: true });
    bindQueue();
  }
  function askReason(report: Report, path: 'dismiss' | 'reopen'): void {
    let sheet: Sheet | null = null;
    const reason = el('textarea', { id: 'rv-reason', rows: '3', maxlength: '500', 'data-feedback-ignore': '' }) as HTMLTextAreaElement;
    const error = el('p', { class: 'formerror', role: 'alert' });
    const send = el('button', { class: 'primary', type: 'button', id: 'rv-reason-send', 'data-feedback-id': 'central.revision.motivo.enviar', 'data-feedback-label': 'Enviar', onclick: async () => {
      if (path === 'dismiss' && !reason.value.trim()) { error.textContent = 'Escribe el motivo: lo verá quien lo informó.'; reason.focus(); return; }
      const ok = await act(report, path, path === 'dismiss' ? { reason: reason.value.trim() } : (reason.value.trim() ? { message: reason.value.trim() } : {}), path === 'dismiss' ? 'Descartado.' : 'Reabierto.');
      if (ok) { await sheet?.close(true); queue?.done(); }
    } }, path === 'dismiss' ? 'Descartar' : 'Enviar: sigue fallando');
    const unbindSend = bindOnline(send, { client, reason: 'Necesita conexión: el feedback se guarda en el momento.' });
    sheet = openSheet({ title: path === 'dismiss' ? 'Descartar el reporte' : 'Sigue fallando', meta: report.code, onClose: () => unbindSend(),
      panelAttrs: { 'data-feedback-id': 'central.revision.motivo', 'data-feedback-label': 'Motivo' },
      body: el('div', null, el('p', { class: 'hint' }, firstLine(report.message)),
        el('label', { class: 'field' }, el('span', null, path === 'dismiss' ? 'Motivo (lo verá quien lo informó)' : '¿Qué sigue pasando? (opcional)'), reason), error),
      foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), send], initialFocus: reason });
  }

  // ---------------------------------------------------------------------------
  // Cuánto se ha hecho: paso a paso
  // ---------------------------------------------------------------------------
  function paintSteps(): void {
    const all = live();
    const { done, total } = reviewProgress(all);
    if (!total) {
      replace(stepsHost, el('div', { class: 'empty', 'data-feedback-id': 'central.revision.vacio', 'data-feedback-label': 'Sin pantallas' },
        el('strong', null, 'Todavía no hay pantallas'),
        isAdmin ? 'Impórtalas desde el cuadro de avance con «Importar pantallas» o añade una con «Nueva pantalla».' : 'Las carga quien administra Central.'));
      return;
    }
    const toAct = screensToAct(all);
    const apps = REVIEW_APPS.filter((a) => all.some((s) => s.app === a));
    const nextOf = (rows: Screen[]) => {
      const pending = rows.filter((s) => s.step !== 'hecha');
      if (!pending.length) return null;
      const counts = stepCounts(pending);
      // Lo siguiente de cada app: el paso más avanzado que aún no está hecho y tiene pantallas.
      const step = [...REVIEW_STEPS].reverse().find((s) => s !== 'hecha' && counts[s] > 0)!;
      return `${plural(counts[step], 'pantalla', 'pantallas')} en «${stepName(step)}»`;
    };
    replace(stepsHost, el('h3', { class: 'ctl-rv-h' }, 'Cuánto se ha hecho'),
      renderSteps({
        title: `${done} de ${total} pantallas pasadas a Sevilla`, feedbackId: 'central.revision.avance.pasos',
        readyText: 'Todas las pantallas están pasadas a Sevilla.',
        items: [
          ...(isAdmin && toAct.length ? [{ id: 'mine', title: 'Valorar prototipos y validar demos', done: false, stateText: plural(toAct.length, 'pantalla te espera', 'pantallas te esperan'), action: 'Empezar', minutes: toAct.length * 3, icon: 'star',
            onClick: () => queueHost.scrollIntoView({ block: 'start' }) }] : []),
          ...(!isAdmin && todos().length ? [{ id: 'mine', title: 'Comprobar lo que comentaste', done: false, stateText: plural(todos().length, 'arreglo te espera', 'arreglos te esperan'), action: 'Empezar', minutes: todos().length, icon: 'star',
            onClick: () => queueHost.scrollIntoView({ block: 'start' }) }] : []),
          ...apps.map((a) => {
            const rows = all.filter((s) => s.app === a);
            const passed = rows.filter((s) => s.step === 'hecha').length;
            const next = nextOf(rows);
            return { id: a, title: appName(a), done: !next, stateText: `${passed} de ${rows.length} pasadas${next ? ` · siguiente: ${next}` : ''}`, action: 'Ver sus pantallas', icon: 'grid',
              onClick: () => { appFilter = a; stepFilter = null; paintBoard(); boardHost.scrollIntoView({ block: 'start' }); } };
          }),
        ],
      }));
  }

  // ---------------------------------------------------------------------------
  // Tablero: los diez pasos con su cifra y las pantallas del paso elegido
  // ---------------------------------------------------------------------------
  function screenRow(s: Screen): HTMLLIElement {
    const open = openReports(s);
    const blocking = open.some((r) => r.blocking);
    return listRow({
      id: s.id, title: el('span', { class: 'ctl-rv-title' }, appMedal(s.app), el('span', null, s.name)),
      chips: [
        el('span', { class: `chip ctl-st ctl-st-${s.step}` }, el('span', { class: 'ctl-st-dot', 'aria-hidden': 'true' }), stepName(s.step)),
        isAdmin && REVIEW_STEPS_TO_ACT.includes(s.step as ReviewStep) ? el('span', { class: 'chip warn' }, 'Te toca') : null,
      ],
      meta: [appName(s.app), reportsState === 'ok' ? (open.length ? `${plural(open.length, 'comentario abierto', 'comentarios abiertos')}${blocking ? ' · bloquea' : ''}` : 'sin comentarios abiertos') : ''].filter(Boolean),
      pending: !!s._pending, onClick: () => openScreen(s), label: `${s.name}, ${appName(s.app)}, ${stepName(s.step)}`,
    });
  }
  function paintBoard(): void {
    const all = live();
    if (!all.length) { replace(boardHost); return; }
    const scoped = appFilter ? all.filter((s) => s.app === appFilter) : all;
    const counts = stepCounts(scoped);
    const shown = scoped.filter((s) => !stepFilter || s.step === stepFilter);
    const apps = REVIEW_APPS.filter((a) => all.some((s) => s.app === a));
    replace(boardHost,
      el('h3', { class: 'ctl-rv-h' }, 'Tablero'),
      el('div', { class: 'chips ctl-rv-apps', role: 'group', 'aria-label': 'Filtrar por app', 'data-feedback-id': 'central.revision.tablero.apps', 'data-feedback-label': 'Filtro por app' },
        el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(!appFilter), onclick: () => { appFilter = null; paintBoard(); } }, `Todas (${all.length})`),
        ...apps.map((a) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(appFilter === a), onclick: () => { appFilter = appFilter === a ? null : a; paintBoard(); } }, `${appName(a)} (${all.filter((s) => s.app === a).length})`))),
      renderAreaTabs({
        label: 'Pasos del cuadro', layout: 'columns', attrs: { 'data-feedback-id': 'central.revision.tablero.pasos', 'data-feedback-label': 'Pasos del cuadro' },
        items: [
          { label: 'Todas', general: true, active: !stepFilter, count: scoped.length, countText: plural(scoped.length, 'pantalla', 'pantallas'), attrs: { onclick: () => { stepFilter = null; paintBoard(); } } as never },
          ...REVIEW_STEPS.map((step, i) => ({ label: `${i} · ${stepName(step)}`, color: STEP_COLORS[step], active: stepFilter === step, count: counts[step], countText: plural(counts[step], 'pantalla', 'pantallas'),
            attrs: { onclick: () => { stepFilter = stepFilter === step ? null : step; paintBoard(); } } as never })),
        ],
      }),
      shown.length ? el('ul', { class: 'list ctl-rv-list', 'aria-label': stepFilter ? `Pantallas en «${stepName(stepFilter)}»` : 'Pantallas', 'data-feedback-id': 'central.revision.tablero.lista', 'data-feedback-label': 'Pantallas del paso' }, ...shown.map(screenRow))
        : el('p', { class: 'hint' }, 'Ninguna pantalla en este paso.'));
  }

  // ---------------------------------------------------------------------------
  // Hoja de ruta por app
  // ---------------------------------------------------------------------------
  function paintRoad(): void {
    const all = live();
    if (!all.length) { replace(roadHost); return; }
    const apps = REVIEW_APPS.filter((a) => all.some((s) => s.app === a));
    const view = renderGroups<Screen>({
      label: 'Hoja de ruta por app', feedbackId: 'central.revision.hoja_de_ruta.grupos',
      toneOf: (s) => (openReports(s).some((r) => r.blocking) ? 'alert' : isAdmin && REVIEW_STEPS_TO_ACT.includes(s.step as ReviewStep) ? 'warn' : s.step === 'hecha' ? 'ok' : null),
      groups: apps.map((a) => {
        const rows = all.filter((s) => s.app === a).sort((x, y) => stepIndex(y.step) - stepIndex(x.step) || x.name.localeCompare(y.name, 'es'));
        const passed = rows.filter((s) => s.step === 'hecha').length;
        const mine = isAdmin ? rows.filter((s) => REVIEW_STEPS_TO_ACT.includes(s.step as ReviewStep)).length : 0;
        return { key: a, title: appName(a), medal: { name: appName(a), color: APP_COLORS[a] }, items: rows, open: onlyMine ? mine > 0 : false,
          summary: [`${passed} de ${rows.length} pasadas`, mine ? plural(mine, 'te espera', 'te esperan') : ''].filter(Boolean).join(' · ') };
      }),
      row: (s) => screenRow(s),
    });
    replace(roadHost, el('h3', { class: 'ctl-rv-h' }, 'Hoja de ruta por app'), view.element);
  }

  // ---------------------------------------------------------------------------
  // Ficha de una pantalla y de un reporte
  // ---------------------------------------------------------------------------
  function openReport(r: Report): void {
    openSheet({ title: r.code, meta: `${appName(r.originApp)} · ${DISPLAY[r.display] ?? r.display}`,
      panelAttrs: { 'data-feedback-id': 'central.revision.reporte', 'data-feedback-label': 'Reporte' },
      body: el('div', { class: 'ctl-rv-sheet' },
        r.node?.path?.length ? el('p', { class: 'hint' }, r.node.path.join(' › ')) : null,
        el('p', { class: 'pre', 'data-feedback-ignore': '' }, r.message),
        el('p', { class: 'hint' }, `Para aprobarlo, descartarlo o comprobarlo con su pantalla delante, ábrelo en «Sugerencias y QA» de ${appName(r.originApp)}.`)) });
  }

  function openScreen(s: Screen | null): void {
    let sheet: Sheet | null = null;
    const ro = !isAdmin;
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.revision.pantalla.error', 'data-feedback-label': 'Error del formulario' });
    const input = (id: string, value: unknown, attrs: Record<string, string> = {}) => el('input', { id, type: 'text', value: value == null ? '' : String(value), disabled: ro, ...attrs }) as HTMLInputElement;
    const appSel = el('select', { id: 'rs-app', disabled: ro || s !== null }, ...REVIEW_APPS.map((a) => el('option', { value: a, selected: (s?.app ?? 'central') === a }, appName(a)))) as HTMLSelectElement;
    const name = input('rs-name', s?.name, { maxlength: '120' });
    const step = el('select', { id: 'rs-step', disabled: ro }, ...REVIEW_STEPS.map((k, i) => el('option', { value: k, selected: (s?.step ?? 'sin') === k }, `${i} · ${stepName(k)}`))) as HTMLSelectElement;
    const url = input('rs-url', s?.url, { type: 'url', maxlength: '500', placeholder: 'https://…', 'data-feedback-ignore': '' });
    const route = input('rs-route', s?.route, { maxlength: '200', placeholder: '#/cumplimiento' });
    const prefix = input('rs-prefix', s?.feedback_prefix, { maxlength: '120', placeholder: 'central.cumplimiento' });
    const handoff = input('rs-handoff', s?.handoff, { maxlength: '60', placeholder: 'MUELA-027' });
    const noteArea = el('textarea', { id: 'rs-note', rows: '3', maxlength: '2000', disabled: ro }) as HTMLTextAreaElement;
    noteArea.value = s?.note ?? '';
    const values = (): Record<string, unknown> => ({
      app: appSel.value, name: name.value.trim(), step: step.value, url: url.value.trim() || null, route: route.value.trim() || null,
      feedback_prefix: prefix.value.trim() || null, handoff: handoff.value.trim() || null, note: noteArea.value.trim() || null,
    });
    const changed = () => (s ? Object.fromEntries(Object.entries(values()).filter(([k, v]) => k !== 'app' && (s[k] ?? null) !== (v ?? null))) : values());
    const refresh = () => { const dirty = Object.keys(changed()).length > 0; guard.dirtyEditor = !ro && (s ? dirty : name.value.trim() !== ''); sheet?.setFootHidden(ro || (s !== null && !dirty)); };
    const save = el('button', { class: 'primary', type: 'submit', id: 'saveScreen', form: 'screenForm', 'data-feedback-id': 'central.revision.pantalla.guardar', 'data-feedback-label': 'Guardar' }, 'Guardar') as HTMLButtonElement;
    const reps = s ? reportsOf(s) : [];
    const form = el('form', { novalidate: true, id: 'screenForm', class: 'ctl-rv-sheet', 'data-feedback-id': 'central.revision.pantalla.formulario', 'data-feedback-label': 'Datos de la pantalla', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
      event.preventDefault();
      if (ro) return;
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = 'El nombre es obligatorio.'; name.focus(); return; }
      const fields = changed();
      const ops: RowOperation[] = s
        ? [{ op: 'update', table: T.reviewScreens, id: s.id, expectedRevision: s.revision, fields }]
        : [{ op: 'insert', table: T.reviewScreens, id: crypto.randomUUID(), fields: { ...fields, position: Date.now() / 1000 } }];
      const issue = validateOperations(ops, client.bootstrap()?.membership ?? { role: 'reader' }, () => s ?? undefined);
      if (issue) { error.textContent = issue.message; return; }
      save.disabled = true;
      try {
        await usage.run('central.revision.pantalla.guardar', () => client.commit(ops));
        toast(!navigator.onLine ? 'Pantalla guardada en este dispositivo. Se sincronizará cuando haya red.' : 'Pantalla guardada.');
        guard.dirtyEditor = false;
        await sheet?.close(true);
      } catch (e) { error.textContent = describeError(e); } finally { save.disabled = false; }
    } },
    s ? el('p', { class: 'ctl-rv-where' }, el('span', { class: `chip ctl-st ctl-st-${s.step}` }, el('span', { class: 'ctl-st-dot', 'aria-hidden': 'true' }), stepName(s.step)), ' ', appName(s.app)) : null,
    s?.url ? el('a', { class: 'primary btnlike ctl-rv-go', href: s.url, target: '_blank', rel: 'noopener', 'data-feedback-id': 'central.revision.pantalla.ir', 'data-feedback-label': 'Ir al sitio' }, icon('eye', 18), 'Ir al sitio') : null,
    s ? el('section', { 'data-feedback-id': 'central.revision.pantalla.reportes', 'data-feedback-label': 'Comentarios de la pantalla' },
      el('div', { class: 'sectionlabel' }, `Comentarios${reportsState === 'ok' ? ` · ${reps.length}` : ''}`),
      reportsState !== 'ok' ? el('p', { class: 'hint' }, reportsState === 'offline' ? 'Sin conexión: los comentarios se cargan con red.' : reportsState === 'loading' ? 'Cargando…' : 'No se pudieron cargar los comentarios.')
        : reps.length ? el('ul', { class: 'list' }, ...reps.map((r) => listRow({ id: r.id, title: firstLine(r.message), meta: [r.code, DISPLAY[r.display] ?? r.display], chips: r.blocking ? [el('span', { class: 'chip alert' }, 'Bloquea')] : [], onClick: () => openReport(r) })))
          : el('p', { class: 'hint' }, 'Sin comentarios.')) : null,
    el('div', { class: 'fieldrow' }, el('label', { class: 'field', 'data-feedback-id': 'central.revision.pantalla.campo_app', 'data-feedback-label': 'App' }, el('span', null, 'App'), appSel),
      el('label', { class: 'field', 'data-feedback-id': 'central.revision.pantalla.campo_paso', 'data-feedback-label': 'Paso' }, el('span', null, 'Paso'), step)),
    el('label', { class: 'field', 'data-feedback-id': 'central.revision.pantalla.campo_nombre', 'data-feedback-label': 'Nombre' }, el('span', null, 'Nombre'), name),
    el('label', { class: 'field', 'data-feedback-id': 'central.revision.pantalla.campo_enlace', 'data-feedback-label': 'Enlace' }, el('span', null, 'Enlace («Ir al sitio»)'), url),
    el('div', { class: 'fieldrow' }, el('label', { class: 'field', 'data-feedback-id': 'central.revision.pantalla.campo_ruta', 'data-feedback-label': 'Ruta' }, el('span', null, 'Ruta en la app'), route),
      el('label', { class: 'field', 'data-feedback-id': 'central.revision.pantalla.campo_prefijo', 'data-feedback-label': 'Prefijo de feedback' }, el('span', null, 'Prefijo de feedback'), prefix)),
    el('p', { class: 'hint' }, 'Los comentarios se unen a la pantalla por el prefijo de sus ids («central.cumplimiento») o, si no, por la ruta de donde se mandaron.'),
    el('label', { class: 'field', 'data-feedback-id': 'central.revision.pantalla.campo_traspaso', 'data-feedback-label': 'Traspaso' }, el('span', null, 'Traspaso'), handoff),
    el('label', { class: 'field', 'data-feedback-id': 'central.revision.pantalla.campo_nota', 'data-feedback-label': 'Nota' }, el('span', null, 'Nota'), noteArea),
    error,
    s && !ro ? el('div', { class: 'zone' }, el('button', { class: 'danger', type: 'button', id: 'deleteScreen', 'data-feedback-id': 'central.revision.pantalla.papelera', 'data-feedback-label': 'Enviar a papelera', onclick: async () => {
      if (!(await confirmDialog({ title: '¿Enviar la pantalla a la papelera?', text: 'Sale del tablero; sus comentarios siguen en «Sugerencias y QA».', confirmLabel: 'Enviar a papelera', danger: true }))) return;
      try { await client.commit([{ op: 'delete', table: T.reviewScreens, id: s.id, expectedRevision: s.revision }]); guard.dirtyEditor = false; await sheet?.close(true); toast('Pantalla enviada a la papelera.'); }
      catch (e) { error.textContent = describeError(e); }
    } }, icon('trash', 18), 'Enviar a papelera')) : null) as HTMLFormElement;
    sheet = openSheet({
      title: s ? s.name : 'Nueva pantalla', meta: s ? (s.handoff ?? undefined) : undefined, body: form,
      panelAttrs: { 'data-feedback-id': 'central.revision.pantalla', 'data-feedback-label': 'Pantalla' },
      closeAttrs: { 'data-feedback-id': 'central.revision.pantalla.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
      foot: ro ? undefined : [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, s ? 'Cerrar' : 'Cancelar'), save],
      footHidden: ro || s !== null, initialFocus: ro || s ? undefined : name,
      beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
      onClose: () => { guard.dirtyEditor = false; },
    });
  }

  // ---------------------------------------------------------------------------
  // Importar pantallas (P1 de Core): JSON pegado o subido, upsert por app + nombre
  // ---------------------------------------------------------------------------
  function openImport(): void {
    let sheet: Sheet | null = null;
    let plan: { ops: RowOperation[]; created: number; updated: number; same: number } | null = null;
    const area = el('textarea', { id: 'rs-json', rows: '8', 'data-feedback-ignore': '', placeholder: '[{ "app": "central", "name": "Inicio", "step": "alt", "url": "https://…", "route": "#/" }]' }) as HTMLTextAreaElement;
    const file = el('input', { id: 'rs-file', type: 'file', accept: 'application/json,.json', class: 'visually-hidden' }) as HTMLInputElement;
    const preview = el('div', { id: 'rs-preview', role: 'status', 'data-feedback-id': 'central.revision.importar.vista', 'data-feedback-label': 'Qué se importará' });
    const run = el('button', { class: 'primary', type: 'button', id: 'importScreensRun', disabled: true, 'data-feedback-id': 'central.revision.importar.enviar', 'data-feedback-label': 'Importar' }, 'Importar') as HTMLButtonElement;
    const parse = () => {
      plan = null;
      run.disabled = true;
      const text = area.value.trim();
      if (!text) { replace(preview); return; }
      let data: unknown;
      try { data = JSON.parse(text); } catch { replace(preview, el('p', { class: 'formerror' }, 'No es un JSON válido.')); return; }
      const list = Array.isArray(data) ? data : Array.isArray((data as { screens?: unknown })?.screens) ? (data as { screens: unknown[] }).screens : null;
      if (!list) { replace(preview, el('p', { class: 'formerror' }, 'Se espera una lista de pantallas o { "screens": [...] }.')); return; }
      const ops: RowOperation[] = [];
      const problems: string[] = [];
      let created = 0; let updated = 0; let same = 0;
      const seen = new Set<string>();
      const allowed = ['step', 'url', 'route', 'feedback_prefix', 'handoff', 'note', 'position'] as const;
      list.forEach((raw, i) => {
        const r = raw as Record<string, unknown>;
        const app = String(r.app ?? '').trim();
        const nm = String(r.name ?? '').trim();
        if (!app || !nm) { problems.push(`Fila ${i + 1}: faltan «app» o «name».`); return; }
        const k = `${app}|${nm.toLocaleLowerCase('es')}`;
        if (seen.has(k)) { problems.push(`Fila ${i + 1}: «${nm}» de ${appName(app)} está repetida.`); return; }
        seen.add(k);
        const fields: Record<string, unknown> = {};
        for (const f of allowed) if (f in r) fields[f] = r[f] === '' ? null : r[f];
        const current = screens.find((s) => !s.deleted_at && s.app === app && s.name.toLocaleLowerCase('es') === nm.toLocaleLowerCase('es'));
        if (current) {
          const diff = Object.fromEntries(Object.entries(fields).filter(([f, v]) => (current[f] ?? null) !== (v ?? null)));
          if (!Object.keys(diff).length) { same++; return; }
          ops.push({ op: 'update', table: T.reviewScreens, id: current.id, expectedRevision: current.revision, fields: diff });
          updated++;
        } else {
          ops.push({ op: 'insert', table: T.reviewScreens, id: crypto.randomUUID(), fields: { app, name: nm, ...fields, position: fields.position ?? i } });
          created++;
        }
      });
      if (!problems.length && ops.length) {
        const issue = validateOperations(ops, client.bootstrap()?.membership ?? { role: 'reader' }, (_t, id) => screens.find((s) => s.id === id));
        if (issue) problems.push(issue.message);
      }
      if (problems.length) { replace(preview, el('ul', { class: 'formerror' }, ...problems.slice(0, 8).map((p) => el('li', null, p)))); return; }
      plan = { ops, created, updated, same };
      replace(preview, el('p', null, [created ? plural(created, 'pantalla nueva', 'pantallas nuevas') : '', updated ? plural(updated, 'actualizada', 'actualizadas') : '', same ? plural(same, 'sin cambios', 'sin cambios') : ''].filter(Boolean).join(' · ') || 'Nada que importar.'));
      run.disabled = ops.length === 0;
    };
    area.addEventListener('input', parse);
    file.addEventListener('change', async () => { const f = file.files?.[0]; if (!f) return; area.value = await f.text(); parse(); });
    run.addEventListener('click', async () => {
      if (!plan?.ops.length) return;
      run.disabled = true;
      try {
        await usage.run('central.revision.importar', () => client.commit(plan!.ops));
        toast(`Pantallas importadas: ${[plan.created ? `${plan.created} nuevas` : '', plan.updated ? `${plan.updated} actualizadas` : ''].filter(Boolean).join(', ')}.`);
        await sheet?.close(true);
      } catch (e) { replace(preview, el('p', { class: 'formerror' }, describeError(e))); run.disabled = false; }
    });
    sheet = openSheet({
      title: 'Importar pantallas', panelAttrs: { 'data-feedback-id': 'central.revision.importar.hoja', 'data-feedback-label': 'Importar pantallas' },
      body: el('div', { class: 'ctl-rv-sheet' },
        el('p', { class: 'hint' }, 'Pega el JSON del cuadro de avance o súbelo. Cada pantalla se busca por app y nombre: si existe, se actualiza; si no, se crea. Nada se borra.'),
        el('label', { class: 'field' }, el('span', null, 'JSON'), area),
        el('label', { class: 'ghost btnlike', for: 'rs-file', 'data-feedback-id': 'central.revision.importar.archivo', 'data-feedback-label': 'Subir archivo' }, icon('upload', 18), 'Subir un archivo .json'), file,
        preview),
      foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), run], initialFocus: area,
    });
  }

  // ---------------------------------------------------------------------------
  // Carga
  // ---------------------------------------------------------------------------
  function paintAll(): void {
    paintQueue();
    paintSteps();
    paintBoard();
    paintRoad();
    note.textContent = reportsState === 'offline' ? 'Sin conexión: el avance es el de la última sincronización; los comentarios se cargan con red.'
      : reportsState === 'error' ? 'No se pudieron cargar los comentarios.' : '';
  }
  async function loadScreens(): Promise<void> {
    screens = (await client.list(T.reviewScreens)) as unknown as Screen[];
    paintAll();
  }
  async function loadReports(): Promise<void> {
    if (!navigator.onLine) { reportsState = 'offline'; paintAll(); return; }
    try {
      // Quien administra lee los reportes de todas las apps; los demás, los suyos.
      const [all, review] = await Promise.all([
        client.api<{ items: Report[] }>(isAdmin ? '/feedback?app=all&status=all&limit=200' : '/feedback?app=all&status=all&mine=true&limit=100'),
        isAdmin ? client.api<{ items: Report[] }>('/feedback?review=true&app=all&limit=100') : Promise.resolve({ items: [] as Report[] }),
      ]);
      const byId = new Map((all.items ?? []).map((r) => [r.id, r]));
      for (const r of review.items ?? []) byId.set(r.id, { ...byId.get(r.id), ...r });
      reports = [...byId.values()];
      reportsState = 'ok';
    } catch {
      reportsState = navigator.onLine ? 'error' : 'offline';
    }
    paintAll();
  }
  void loadScreens().then(loadReports);
  const off = client.onTable(T.reviewScreens, () => void loadScreens());
  const offStatus = client.onStatus((s) => { if (s.network !== 'offline' && reportsState === 'offline') void loadReports(); });
  return () => { off(); offStatus(); unbindQueue.forEach((u) => u()); };
};
