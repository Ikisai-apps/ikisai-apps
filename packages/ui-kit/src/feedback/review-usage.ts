/**
 * Revisor › Uso (USO.md §3 y §6 fase 5; API de Core en RESPUESTAS 7-10-2026 §7):
 * - Lista de funciones de todas las apps (`GET usage/review?app=all`) agrupada por *insight* (se calcula en el servidor).
 * - «Ir al sitio» con la misma navegación que las incidencias: en otra app, `?fbf=<función>&qa=1`; en esta, ruta (si el
 *   servidor la da), espera al `[data-feedback-id]` y lo ilumina. Si no está en la pantalla, se queda vigilando: al
 *   navegar hasta ella se ilumina.
 * - Tarjeta (`GET usage/features/:id`): estado, últimos 30 días, matriz por equipo y por persona, generación e incidencias
 *   asociadas. Acciones: audiencia (equipos y personas), frecuencia esperada, mantener (con fecha de revisión), revisar
 *   más tarde, no evaluar, nueva generación y «Revisar utilidad» (crea un reporte de feedback normal).
 * El detalle por persona solo lo devuelve el servidor al dueño del ecosistema.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { confirmDialog } from '../overlay/dialog.ts';
import { toast } from '../toast.ts';
import type { ReviewHost, ReviewTab } from './review.ts';

export const FBF_PARAM = 'fbf';

export type UsageActivity = 'alta' | 'media' | 'baja' | 'dormida';
export interface UsageNumbers { exposures?: number; activations?: number; successes?: number; errors?: number; people?: number; lastUse?: string | null }
export interface UsageAudience { teams?: string[]; people?: string[] }
/** Forma de `core.usage_feature_stats` (migración 0071). */
export interface UsageReviewItem {
  featureId: string; app: string; label: string; kind?: string; parent?: string | null; insight: string;
  audience?: UsageAudience | null; frequency?: string | null; decision?: string | null; reviewAfter?: string | null;
  generation?: number; generationRelease?: string | null; introducedRelease?: string | null; removedRelease?: string | null;
  activity?: UsageActivity; lastProductiveUse?: string | null;
  last30?: UsageNumbers & { target?: UsageNumbers; others?: UsageNumbers; qaActivations?: number };
  feedback?: { open?: number; pendingVerify?: number };
}
/** `GET usage/features/:id`: lo anterior más la matriz por persona y por equipo. */
export interface UsageFeatureCard extends UsageReviewItem {
  byPerson?: (UsageNumbers & { userId: string; name?: string })[];
  byTeam?: (UsageNumbers & { teamId: string; name?: string })[];
  unattributed?: UsageNumbers;
  byContext?: Record<string, number>;
  /** Todos los equipos de Central (para elegir audiencia); si no llega, los de la matriz y la audiencia actual. */
  teams?: { teamId: string; name: string }[];
  /** Ruta donde está la función, si el servidor la conoce. */
  routeRaw?: string | null;
}

/** Textos de los *insights* de `core.usage_feature_stats`; uno desconocido se muestra tal cual. */
export const USAGE_INSIGHT_LABELS: Record<string, string> = {
  HIGH_ERROR: 'Falla a menudo',
  FRICTION: 'Cuesta terminarla',
  TARGET_CANNOT_REACH_FEATURE: 'Su audiencia no llega a verla',
  TARGET_NOT_ADOPTING: 'Su audiencia la ve pero no la usa',
  USED_BY_WRONG_AUDIENCE: 'La usan sobre todo otros',
  IGNORED: 'Se ve pero no se usa',
  POSSIBLY_INACCESSIBLE: 'Nadie la ve: ¿está accesible?',
  DORMANT: 'Dormida',
  ORPHANED_USAGE_ID: 'Id sin catalogar o retirado',
  NEW: 'Nueva: en observación',
  KEPT: 'Se mantiene (decidido)',
  RARE_AS_EXPECTED: 'Poco uso, como se espera',
  NOT_EVALUATED: 'Sin evaluar (decidido)',
  HIGH_ACTIVITY: 'Muy usada',
  HEALTHY: 'Sana',
};
const INSIGHT_ORDER = Object.keys(USAGE_INSIGHT_LABELS);
/** Lo que pide una decisión (el resto es informativo). */
const NEEDS_ATTENTION = new Set(['HIGH_ERROR', 'FRICTION', 'TARGET_CANNOT_REACH_FEATURE', 'TARGET_NOT_ADOPTING', 'USED_BY_WRONG_AUDIENCE', 'IGNORED', 'POSSIBLY_INACCESSIBLE', 'DORMANT', 'ORPHANED_USAGE_ID']);
export const USAGE_FREQUENCY_LABELS: Record<string, string> = { frequent: 'Frecuente', normal: 'Normal', occasional: 'Ocasional', rare_critical: 'Rara pero crítica', do_not_evaluate: 'No evaluar' };
const DECISION_LABELS: Record<string, string> = { keep: 'mantener', review_later: 'revisar más tarde', do_not_evaluate: 'no evaluar' };
const ACTIVITY_CHIP: Record<string, string> = { alta: 'ok', media: '', baja: 'pending', dormida: 'trash' };

const n = (v: number | undefined | null) => (typeof v === 'number' ? v.toLocaleString('es-ES') : '–');

export function createUsageReviewTab(host: ReviewHost): ReviewTab & { goTo(item: Pick<UsageReviewItem, 'featureId' | 'app'>): Promise<void>; show(featureId: string): Promise<void> } {
  let items: UsageReviewItem[] = [];
  let current: string | null = null;
  const groups = () => {
    const by = new Map<string, UsageReviewItem[]>();
    for (const i of items) by.set(i.insight, [...(by.get(i.insight) ?? []), i]);
    return [...by.entries()].sort(([a], [b]) => (INSIGHT_ORDER.indexOf(a) + 1 || 99) - (INSIGHT_ORDER.indexOf(b) + 1 || 99));
  };
  const queue = () => groups().flatMap(([, list]) => list);

  function row(i: UsageReviewItem): HTMLElement {
    return el('li', null, el('button', {
      type: 'button', class: `fb-review-row usage-row${i.featureId === current ? ' on' : ''}`, dataset: { feature: i.featureId, app: i.app },
      'aria-current': i.featureId === current ? 'true' : null, onclick: () => void goTo(i),
    },
      el('span', { class: 'fb-card-head' },
        el('span', { class: 'chip small', dataset: { app: i.app } }, el('span', null, i.app)),
        el('strong', null, i.label),
        i.activity ? el('span', { class: `chip small ${ACTIVITY_CHIP[i.activity] ?? ''}`.trim(), dataset: { activity: i.activity } }, el('span', null, i.activity)) : null),
      el('span', { class: 'fb-card-meta' },
        el('span', null, `${n(i.last30?.activations)} usos · 30 días`),
        i.last30?.target && (i.audience?.teams?.length || i.audience?.people?.length) ? el('span', null, `audiencia ${n(i.last30.target.activations)}`) : null,
        i.feedback?.open ? el('span', null, `${i.feedback.open} incidencias`) : null)));
  }

  async function goTo(i: Pick<UsageReviewItem, 'featureId' | 'app'>): Promise<void> {
    if (i.app && i.app !== host.app) { host.openApp(i.app, { [FBF_PARAM]: i.featureId }); return; }
    await show(i.featureId);
  }

  async function show(featureId: string): Promise<void> {
    current = featureId;
    host.repaint();
    let card: UsageFeatureCard;
    try { card = await host.api<UsageFeatureCard>(`/usage/features/${encodeURIComponent(featureId)}`); }
    catch { toast('No se pudo abrir esa función.'); current = null; return; }
    const { element, exact } = await host.goToNode(card.routeRaw, featureId, { watch: true });
    paintCard(card, element, exact);
  }

  function matrix(title: string, rows: (UsageNumbers & { label: string })[], cls: string): HTMLElement | null {
    if (!rows.length) return null;
    return el('details', { class: `usage-matrix ${cls}`, open: cls === 'by-team' },
      el('summary', null, `${title} (${rows.length})`),
      el('div', { class: 'usage-table-wrap' }, el('table', { class: 'usage-table' },
        el('thead', null, el('tr', null, ...['', 'Visto', 'Usado', 'Bien', 'Fallos', 'Último día'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', null, ...rows.map((r) => el('tr', null,
          el('th', { scope: 'row' }, r.label), el('td', null, n(r.exposures)), el('td', null, n(r.activations)), el('td', null, n(r.successes)),
          el('td', { class: r.errors ? 'bad' : '' }, n(r.errors)), el('td', null, r.lastUse ?? '–')))))));
  }

  function paintCard(c: UsageFeatureCard, anchor: Element | null, exact: boolean): void {
    const status = el('p', { class: 'fb-status', role: 'status' });
    const id = encodeURIComponent(c.featureId);
    /** Guarda; `repaint` vuelve a pedir la tarjeta (decisiones y generación cambian lo que se ve; audiencia y frecuencia no,
     *  y así no se pierde lo que se esté escribiendo en otro campo). */
    const post = async (path: string, json: unknown, done: string, repaint = false) => {
      try { await host.api(`/usage/features/${id}/${path}`, { method: 'POST', json }); toast(done); void host.refresh(); if (repaint) void show(c.featureId); }
      catch { status.className = 'fb-status error'; status.textContent = 'No se pudo guardar. Prueba otra vez con conexión.'; }
    };

    // Audiencia: equipos y, solo si es muy individual, personas.
    const teamMap = new Map<string, string>();
    for (const t of c.teams ?? []) teamMap.set(t.teamId, t.name);
    for (const t of c.byTeam ?? []) if (!teamMap.has(t.teamId)) teamMap.set(t.teamId, t.name ?? t.teamId);
    for (const t of c.audience?.teams ?? []) if (!teamMap.has(t)) teamMap.set(t, t);
    const teams = [...teamMap].map(([id, name]) => ({ id, name }));
    const people = (c.byPerson ?? []).map((p) => ({ id: p.userId, name: p.name ?? p.userId }));
    for (const p of c.audience?.people ?? []) if (!people.some((x) => x.id === p)) people.push({ id: p, name: p });
    const chosenTeams = new Set(c.audience?.teams ?? []);
    const chosenPeople = new Set(c.audience?.people ?? []);
    const checks = (list: { id: string; name: string }[], chosen: Set<string>, kind: string) => list.map((o) => {
      const input = el('input', { type: 'checkbox', value: o.id, dataset: { [kind]: o.id } }) as HTMLInputElement;
      input.checked = chosen.has(o.id);
      input.addEventListener('change', () => { if (input.checked) chosen.add(o.id); else chosen.delete(o.id); });
      return el('label', { class: 'field check usage-check' }, input, el('span', null, o.name));
    });
    const audience = el('details', { class: 'usage-audience' },
      el('summary', null, `Audiencia: ${chosenTeams.size || chosenPeople.size ? [...chosenTeams].map((t) => teams.find((x) => x.id === t)?.name ?? t).concat([...chosenPeople].map((p) => people.find((x) => x.id === p)?.name ?? p)).join(', ') : 'sin definir'}`),
      teams.length ? el('fieldset', { class: 'usage-fieldset' }, el('legend', null, 'Equipos'), ...checks(teams, chosenTeams, 'team')) : el('p', { class: 'hint' }, 'Aún no hay equipos en Central.'),
      people.length ? el('fieldset', { class: 'usage-fieldset' }, el('legend', null, 'Personas (solo si es algo muy individual)'), ...checks(people, chosenPeople, 'person')) : null,
      el('button', { type: 'button', class: 'ghost small usage-save-audience', onclick: () => void post('settings', { audience: { teams: [...chosenTeams], people: [...chosenPeople] } }, 'Audiencia guardada.') }, 'Guardar audiencia'));

    const frequency = el('select', { class: 'usage-frequency', 'aria-label': 'Frecuencia esperada' },
      ...Object.entries(USAGE_FREQUENCY_LABELS).map(([v, l]) => el('option', { value: v, selected: (c.frequency ?? 'normal') === v }, l))) as HTMLSelectElement;
    frequency.addEventListener('change', () => void post('settings', { frequency: frequency.value }, 'Frecuencia guardada.', true));

    const reviewAfter = el('input', { type: 'date', class: 'usage-review-after', 'aria-label': 'Revisar de nuevo el' }) as HTMLInputElement;
    reviewAfter.value = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const reason = el('input', { type: 'text', class: 'usage-reason', maxlength: '300', placeholder: 'Motivo (opcional)', 'aria-label': 'Motivo de la decisión' }) as HTMLInputElement;
    const decide = (decision: string, done: string) => void post('decision', { decision, reviewAfter: decision === 'do_not_evaluate' ? undefined : reviewAfter.value || undefined, reason: reason.value.trim() || undefined }, done, true);

    const generated = () => [
      `Revisar la utilidad de «${c.label}» (${c.featureId}).`,
      `Estado: ${USAGE_INSIGHT_LABELS[c.insight] ?? c.insight}${c.activity ? `, actividad ${c.activity}` : ''}.`,
      `Últimos 30 días: ${n(c.last30?.exposures)} veces vista, ${n(c.last30?.activations)} usos, ${n(c.last30?.successes)} con éxito, ${n(c.last30?.errors)} errores${c.last30?.target ? ` (audiencia: ${n(c.last30.target.activations)} usos; otros: ${n(c.last30.others?.activations)})` : ''}.`,
      c.frequency ? `Frecuencia esperada: ${USAGE_FREQUENCY_LABELS[c.frequency] ?? c.frequency}.` : 'Sin frecuencia esperada.',
      '¿Se simplifica, se mueve a otro sitio, se explica mejor o se retira?',
    ].join('\n');
    const reviewUtility = async () => {
      try {
        const reportId = crypto.randomUUID();
        const { report } = await host.api<{ report: { code: string } }>('/feedback', { method: 'POST', json: {
          id: reportId, requestId: reportId, subject: 'application', intent: 'improvement', message: generated(),
          node: { id: c.featureId, path: [c.label] }, blocking: false, category: 'usage', context: {},
        } });
        toast(`Creado ${report.code}: está en «Incidencias».`);
        void host.refresh();
      } catch { status.className = 'fb-status error'; status.textContent = 'No se pudo crear el reporte.'; }
    };
    const following = (() => { const q = queue(); const at = q.findIndex((x) => x.featureId === c.featureId); return q[at + 1] ?? null; })();

    replace(host.card,
      el('header', { class: 'fb-head' },
        el('div', { class: 'fb-where' },
          el('small', null, `${c.app} · ${c.featureId}`),
          el('strong', null, c.label, ' ',
            c.activity ? el('span', { class: `chip small ${ACTIVITY_CHIP[c.activity] ?? ''}`.trim() }, el('span', null, `actividad ${c.activity}`)) : null)),
        el('button', { type: 'button', class: 'iconbtn small fb-close', 'aria-label': 'Cerrar', onclick: () => host.closeCard() }, icon('close', 18))),
      exact ? null : el('p', { class: 'banner info fb-rv-approx' }, icon('info', 16), el('span', null, anchor ? 'No está a la vista: se muestra su sección.' : 'No está en esta pantalla: ve a donde aparece y se iluminará.')),
      el('p', { class: 'usage-insight', dataset: { insight: c.insight } }, USAGE_INSIGHT_LABELS[c.insight] ?? c.insight),
      el('dl', { class: 'usage-numbers' },
        ...([['Vista', c.last30?.exposures], ['Usada', c.last30?.activations], ['Bien', c.last30?.successes], ['Fallos', c.last30?.errors],
          ['Audiencia', c.last30?.target?.activations], ['Otros', c.last30?.others?.activations], ['En QA', c.last30?.qaActivations]] as [string, number | undefined][])
          .filter(([, v]) => v !== undefined).map(([k, v]) => el('div', null, el('dt', null, k), el('dd', null, n(v))))),
      el('p', { class: 'fb-card-meta' },
        el('span', null, `Generación ${c.generation ?? 1}${c.generationRelease ? ` desde ${c.generationRelease}` : ''}`),
        c.lastProductiveUse ? el('span', null, `Último uso: ${c.lastProductiveUse}`) : null,
        c.frequency ? el('span', null, `Frecuencia: ${USAGE_FREQUENCY_LABELS[c.frequency] ?? c.frequency}`) : null,
        c.feedback ? el('span', null, `Incidencias: ${c.feedback.open ?? 0} abiertas, ${c.feedback.pendingVerify ?? 0} por comprobar`) : null,
        c.decision ? el('span', { class: 'usage-decision' }, `Decisión: ${DECISION_LABELS[c.decision] ?? c.decision}${c.reviewAfter ? ` (revisar el ${c.reviewAfter})` : ''}`) : null),
      matrix('Por equipo', (c.byTeam ?? []).map((t) => ({ ...t, label: t.name ?? t.teamId })), 'by-team'),
      matrix('Por persona', (c.byPerson ?? []).map((p) => ({ ...p, label: p.name ?? p.userId })), 'by-person'),
      c.unattributed && (c.unattributed.activations || c.unattributed.exposures) ? el('p', { class: 'hint usage-unattributed' }, `Sin persona (antes de aceptar el aviso): ${n(c.unattributed.exposures)} vista, ${n(c.unattributed.activations)} usos.`) : null,
      audience,
      el('label', { class: 'field usage-freq-field' }, el('span', null, 'Frecuencia esperada'), frequency),
      el('div', { class: 'usage-decide' }, el('label', { class: 'field' }, el('span', null, 'Revisar de nuevo el'), reviewAfter), reason),
      status,
      el('div', { class: 'fb-foot fb-rv-actions' },
        el('button', { type: 'button', class: 'ghost usage-not-evaluate', onclick: () => decide('do_not_evaluate', 'No se evaluará.') }, 'No evaluar'),
        el('button', { type: 'button', class: 'ghost usage-later', onclick: () => decide('review_later', 'Se revisará más tarde.') }, 'Revisar más tarde'),
        el('button', { type: 'button', class: 'primary usage-keep', onclick: () => decide('keep', 'Se mantiene.') }, 'Mantener')),
      el('div', { class: 'fb-foot fb-rv-actions' },
        el('button', { type: 'button', class: 'linkbtn usage-new-generation', onclick: async () => {
          if (await confirmDialog({ title: 'Nueva generación', text: `A partir de ahora, «${c.label}» se mide como una función nueva (generación ${(c.generation ?? 1) + 1}). Lo anterior se conserva aparte.`, confirmLabel: 'Empezar generación nueva', container: host.container() })) void post('settings', { newGeneration: true }, 'Generación nueva.', true);
        } }, 'Nueva generación desde esta versión'),
        el('button', { type: 'button', class: 'ghost usage-review-utility', onclick: () => void reviewUtility() }, 'Revisar utilidad')),
      el('div', { class: 'fb-rv-nav' },
        following ? el('button', { type: 'button', class: 'linkbtn fb-rv-next', onclick: () => void goTo(following) }, 'Siguiente', icon('chevronRight', 16)) : el('small', { class: 'hint' }, 'Es la última de la lista.')));
    host.showCard(anchor);
  }

  return {
    id: 'usage',
    label: 'Uso',
    count: () => items.filter((i) => NEEDS_ATTENTION.has(i.insight)).length,
    async load() { items = (await host.api<{ items: UsageReviewItem[] }>('/usage/review?app=all')).items ?? []; },
    list(state) {
      const g = groups();
      return [
        state === 'loading' && !items.length ? el('p', { class: 'hint' }, 'Cargando…') : null,
        state === 'error' ? el('p', { class: 'fb-status error' }, 'No se pudo cargar el uso. Comprueba la conexión.') : null,
        state !== 'loading' && !g.length && state !== 'error' ? el('p', { class: 'hint fb-empty' }, 'Todavía no hay datos de uso.') : null,
        ...g.flatMap(([insight, list]) => [
          el('h3', { class: 'launcher-group' }, `${USAGE_INSIGHT_LABELS[insight] ?? insight} · ${list.length}`),
          el('ul', { class: 'fb-review-list', 'aria-label': USAGE_INSIGHT_LABELS[insight] ?? insight, dataset: { insight } }, ...list.map(row)),
        ]),
      ];
    },
    boot(params) { const f = params.get(FBF_PARAM); if (!f) return false; params.delete(FBF_PARAM); void show(f); return true; },
    closed() { current = null; },
    goTo,
    show,
  };
}
