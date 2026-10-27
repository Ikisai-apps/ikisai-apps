import {
  bindOnline, confirmDialog, el, renderGroups, replace, toast, type Tone,
} from '@ikisai/ui-kit';
import {
  COVERAGE_DECISIONS, COVERAGE_DECISION_LABELS, COVERAGE_STATES, COVERAGE_STATE_LABELS, REVIEW_APPS, REVIEW_APP_LABELS, coverageCounts, coverageRows,
  FLOW_JOURNEYS_READ, inventorySources, journeysByFeature, type CoverageDecision, type CoverageDecisionRow, type CoverageRow, type CoverageSource, type CoverageState, type FieldInventory, type JourneyStepRow,
} from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

/**
 * Revisión › Uso y cobertura (visión V0.2 aprobada por VG, 27-10; API.md §2.17). Solo quien administra.
 * - Por app, cada función o campo con su uso de 30 días (de su audiencia, de otros y personas), su estado de cobertura y, cuando
 *   existan, los recorridos de Flow en los que participa.
 * - El estado informa, no decide: «Sin instrumentar» es desconocido, no inútil.
 * - Las decisiones son de una persona: Mantener, Simplificar, Integrar o Retirar (este, con confirmación). Se guardan en
 *   `central.coverage_decisions` y van por el espejo (también sin red).
 * - El uso y el inventario necesitan red; sin ella, lo dice.
 */
const STATE_TONE: Partial<Record<CoverageState, Tone>> = { nadie_llega: 'alert', se_ve_sin_uso: 'warn', requerido: 'ok' };
const appName = (app: string) => REVIEW_APP_LABELS[app] ?? app;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const mountCoverage: ViewMount = ({ main, client, usage }) => {
  let sources: CoverageSource[] = [];
  let inventoryLoaded = false;
  let decisions: CoverageDecisionRow[] = [];
  let state: 'loading' | 'ok' | 'offline' | 'error' = 'loading';
  let errorText = '';
  let filter: CoverageState | null = null;
  // Recorridos de Flow por función (vacío mientras Flow no publique la lectura).
  let journeys = new Map<string, string[]>();

  const note = el('p', { class: 'hint', id: 'coverageNote', role: 'status', 'data-feedback-id': 'central.uso.estado', 'data-feedback-label': 'Estado de la carga' });
  const chips = el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'Estado de cobertura', id: 'coverageStates' });
  const host = el('div', { id: 'coverageList', 'data-feedback-id': 'central.uso.lista', 'data-feedback-label': 'Funciones y campos por app' });
  replace(main,
    el('a', { href: '#/revision', class: 'backlink', 'data-feedback-id': 'central.uso.volver', 'data-feedback-label': 'Volver a Revisión' }, '← Revisión'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.uso.cabecera', 'data-feedback-label': 'Cabecera de Uso y cobertura' },
      el('div', null, el('h2', null, 'Uso y cobertura'),
        el('p', null, 'Cada función y campo de las apps: cuánto se usa en 30 días, quién lo usa y en qué recorridos participa. El estado solo informa; decides tú.')),
      el('a', { class: 'linkbtn', href: '#/revision/campos', id: 'openFieldCoverage', 'data-feedback-id': 'central.uso.campos', 'data-feedback-label': 'Cobertura de campos' }, 'Cobertura de campos')),
    note, chips, host);

  const rows = () => coverageRows(sources, (id) => journeys.get(id) ?? [], decisions, REVIEW_APPS as readonly string[]);

  function paintChips(all: CoverageRow[]): void {
    const counts = coverageCounts(all);
    const chip = (s: CoverageState | null, label: string, n: number) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(filter === s), dataset: { state: s ?? 'todos' },
      'data-feedback-id': 'central.uso.filtro', 'data-feedback-label': 'Filtro por estado', onclick: () => { filter = filter === s ? null : s; paint(); } }, `${label} (${n})`);
    replace(chips, chip(null, 'Todos', all.length), ...COVERAGE_STATES.filter((s) => counts[s]).map((s) => chip(s, COVERAGE_STATE_LABELS[s], counts[s])));
  }

  async function decide(r: CoverageRow, decision: CoverageDecision | null): Promise<void> {
    if (decision === 'retirar' && !(await confirmDialog({ title: `¿Retirar «${r.label}»?`, text: 'Queda anotado para quitarla de la app. No se borra nada ahora: lo hace el equipo de la app en su tanda.', confirmLabel: 'Retirar' }))) return;
    const d = r.decision;
    const op = decision === null
      ? (d ? { op: 'delete' as const, table: T.coverageDecisions, id: d.id, expectedRevision: d.revision } : null)
      : d ? { op: 'update' as const, table: T.coverageDecisions, id: d.id, expectedRevision: d.revision, fields: { decision } }
        : { op: 'insert' as const, table: T.coverageDecisions, id: crypto.randomUUID(), fields: { app: r.app, feature_id: r.featureId, decision } };
    if (!op) return;
    try {
      await usage.run('central.uso.decidir', () => client.commit([op]));
      toast(decision ? `«${r.label}»: ${COVERAGE_DECISION_LABELS[decision].toLowerCase()}.` : `«${r.label}»: sin decisión.`);
    } catch (e) { toast(describeError(e)); }
  }

  function row(r: CoverageRow): HTMLElement {
    const numbers = r.state === 'sin_instrumentar' ? 'Sin datos de uso: no está instrumentado.'
      : `30 días: ${plural(r.uses.total, 'uso', 'usos')}${r.uses.target || r.uses.others ? ` (${r.uses.target} de su audiencia · ${r.uses.others} de otros)` : ''} · ${plural(r.uses.people, 'persona', 'personas')}${r.uses.exposures ? ` · se vio ${r.uses.exposures} ${r.uses.exposures === 1 ? 'vez' : 'veces'}` : ''}`;
    const decided = r.decision ? (r.decision.decision as CoverageDecision) : null;
    const choice = (d: CoverageDecision) => el('button', { type: 'button', class: decided === d ? 'on' : '', 'aria-pressed': String(decided === d), dataset: { decision: d },
      'data-feedback-id': 'central.uso.decision', 'data-feedback-label': 'Decisión sobre la función', onclick: () => void decide(r, decided === d ? null : d) }, COVERAGE_DECISION_LABELS[d]);
    return el('div', { class: 'ctl-cov', dataset: { feature: r.featureId, state: r.state } },
      el('div', { class: 'ctl-covhead' },
        el('strong', null, r.label),
        el('span', { class: `chip${STATE_TONE[r.state] ? ` ${STATE_TONE[r.state]}` : ''}`, 'data-state': r.state }, COVERAGE_STATE_LABELS[r.state])),
      el('span', { class: 'muted small' }, [r.screen, r.kind, r.featureId].filter(Boolean).join(' · ')),
      el('span', { class: 'small ctl-covuse' }, numbers),
      r.flows.length ? el('span', { class: 'small' }, `En ${plural(r.flows.length, 'recorrido', 'recorridos')}: ${r.flows.join(', ')}`) : null,
      el('div', { class: 'segmented ctl-covdecide', role: 'group', 'aria-label': `Decisión sobre ${r.label}` }, ...COVERAGE_DECISIONS.map(choice)));
  }

  function paint(): void {
    note.textContent = state === 'loading' ? 'Cargando el uso…' : state === 'offline' ? 'Sin conexión: el uso y el inventario se leen con red.'
      : state === 'error' ? errorText
        : inventoryLoaded ? '' : 'El inventario de campos aún no llega (lo publica UI-kit con cada versión): por ahora, solo lo que mide el uso.';
    const all = rows();
    paintChips(all);
    const shown = filter ? all.filter((r) => r.state === filter) : all;
    if (state !== 'ok' && !all.length) { replace(host); return; }
    const apps = [...new Set(shown.map((r) => r.app))];
    if (!apps.length) { replace(host, el('p', { class: 'empty hint' }, filter ? 'Nada en este estado.' : 'Todavía no hay uso medido.')); return; }
    replace(host, renderGroups<CoverageRow>({
      label: 'Uso y cobertura por app', feedbackId: 'central.uso.grupos',
      toneOf: (r) => STATE_TONE[r.state] ?? null,
      groups: apps.map((a) => {
        const list = shown.filter((r) => r.app === a);
        const c = coverageCounts(list);
        return {
          key: a, title: appName(a), medal: { name: appName(a) }, items: list,
          summary: [plural(list.length, 'función', 'funciones'), c.nadie_llega ? `${c.nadie_llega} sin llegar` : null, c.sin_instrumentar ? `${c.sin_instrumentar} sin instrumentar` : null,
            list.filter((r) => r.decision).length ? `${list.filter((r) => r.decision).length} decididas` : null].filter(Boolean).join(' · '),
        };
      }),
      row,
    }).element);
  }

  async function loadUsage(): Promise<void> {
    if (!navigator.onLine) { state = 'offline'; paint(); return; }
    try {
      const out = await client.api<{ items: CoverageSource[] }>('/usage/review?app=all');
      // El inventario de UI-kit (P15): si la ruta aún no existe, se sigue solo con el uso.
      let inventory: FieldInventory | null = null;
      try { inventory = await client.api<FieldInventory>('/usage/inventory?app=all'); inventoryLoaded = true; } catch { inventoryLoaded = false; }
      // Los recorridos de Flow: si la lectura aún no existe, ninguno.
      try { journeys = journeysByFeature((await client.api<{ rows: JourneyStepRow[] }>(`/read/${FLOW_JOURNEYS_READ}`, { method: 'POST', json: { limit: 5000 } })).rows ?? []); } catch { journeys = new Map(); }
      sources = [...(out.items ?? []), ...inventorySources(inventory)];
      state = 'ok';
    } catch (e) {
      state = navigator.onLine ? 'error' : 'offline';
      errorText = describeError(e);
    }
    paint();
  }
  async function loadDecisions(): Promise<void> {
    decisions = (await client.list(T.coverageDecisions)) as unknown as CoverageDecisionRow[];
    paint();
  }

  void loadDecisions();
  void loadUsage();
  const offTable = client.onTable(T.coverageDecisions, () => void loadDecisions());
  const onOnline = () => { if (state === 'offline') void loadUsage(); };
  window.addEventListener('online', onOnline);
  const refresh = el('button', { class: 'ghost', type: 'button', id: 'coverageReload', 'data-feedback-id': 'central.uso.recargar', 'data-feedback-label': 'Volver a leer el uso', onclick: () => void loadUsage() }, 'Volver a leer');
  const unbind = bindOnline(refresh, { client, reason: 'El uso se lee en el momento: necesita conexión.' });
  main.querySelector('.pagehead')?.append(el('div', { class: 'ctl-headtools' }, refresh));
  return () => { offTable(); window.removeEventListener('online', onOnline); unbind(); };
};
