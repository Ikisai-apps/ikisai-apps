/**
 * Cobertura de campos por flujos, para el Revisor de Central (traspaso de Flow v03, §11.9; diseño en
 * `MUELA/equipo/feedback/ui-kit/COBERTURA_INPUTS_FLUJOS.md`). Solo pinta: el cruce (`campo → dato → capacidad → paso`)
 * llega hecho del núcleo. **Nunca valores de campo**: solo metadatos y recuentos de uso.
 * - Clases: `direct` (el campo es un paso), `indirect` (lo usa una capacidad de un paso), `automatic` (lo usa una regla),
 *   `independent` (se usa en su app, sin Flow) y `unknown` (sin datos suficientes: **no** es «inútil»).
 * - Marcas: «Sin cobertura de Flow», «En N recorridos», «Duplicado» (el mismo `entity.prop` en varios campos, por
 *   recomendación: solo por `entity.prop`, que es exacto) y «Obligatorio en un proceso crítico».
 * - La utilidad declarada (audiencia, impacto, frecuencia) la pone Central, no el código (recomendación del análisis): llega
 *   como `declared` y se enseña tal cual.
 * - **No se decide campo a campo** (decisión de VG, 27-10): la vista por defecto son los candidatos del núcleo (`candidate`)
 *   por app → pantalla, con recuento, usos en el periodo y la utilidad heredada (`estimate`), y una acción por grupo: Dejar ·
 *   Revisar más tarde · Retirar (`onDecide`; Retirar pide un segundo toque). «Ver todo» abre el detalle por clase.
 * Prefijo de clases: `cov-`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';

export type CoverageClass = 'direct' | 'indirect' | 'automatic' | 'independent' | 'unknown';
export const COVERAGE_CLASSES: readonly CoverageClass[] = ['direct', 'indirect', 'automatic', 'independent', 'unknown'];

export interface CoverageField {
  fieldId: string;
  app: string;
  screen?: string | null;
  /** La pantalla en lenguaje de persona («Ficha de la reserva»); si no, se enseña `screen`. */
  screenLabel?: string | null;
  label?: string | null;
  entity?: string | null;
  prop?: string | null;
  /** `always`, `never` o la condición (inventario de campos). */
  required?: string | null;
  /** Lo marca Central: el campo pertenece a un proceso crítico. */
  critical?: boolean;
  /** Utilidad declarada por Dirección en Central («Recepción · diaria · alto impacto»). */
  declared?: string | null;
  /** Estimado de la propia app en su catálogo de uso (decisión de VG, vg-39): va antes de que Dirección declare. */
  estimate?: { audience?: string | null; impact?: string | null; frequency?: string | null } | null;
  /** Del núcleo (`core.field_coverage`, 0111): capacidades que leen o escriben su `entity.prop`. */
  capabilities?: Array<{ id: string; how: 'reads' | 'writes' }>;
  /** Del núcleo: otros campos con el mismo dato (si viene, manda sobre el cálculo por `entity.prop`). */
  duplicates?: string[];
  /** Del núcleo: tiene uso propio (sin recuento). */
  used?: boolean;
  /** Clase parcial del núcleo (`indirect`, `independent`, `unknown`): se usa cuando no hay vínculos con Flow. */
  coreClass?: 'indirect' | 'independent' | 'unknown' | null;
  /** Del núcleo: el campo está en revisión (sale en la vista de candidatos). */
  candidate?: boolean;
  /** Lo ya decidido para el campo (lo guarda Central). */
  decision?: CoverageDecision | null;
}

/** Decisión por grupo (app · pantalla) en la vista de candidatos. */
export type CoverageDecision = 'keep' | 'later' | 'retire';
export const COVERAGE_DECISIONS: readonly CoverageDecision[] = ['keep', 'later', 'retire'];

/** Un grupo de candidatos: los campos de una pantalla de una app. */
export interface CoverageGroup {
  app: string;
  screen: string | null;
  fieldIds: string[];
}

/** Un vínculo del cruce del núcleo: el campo llega a estos recorridos por esta vía. */
export interface CoverageLink {
  fieldId: string;
  via: 'direct' | 'indirect' | 'automatic';
  flows: Array<{ id: string; name: string }>;
  capabilities?: string[];
}

/** Uso observado (`createUsage`) por id de campo: activaciones en el periodo. */
export interface CoverageUsage {
  fieldId: string;
  /** Activaciones en el periodo; sin recuento, el campo dice solo si hay uso (`used`). */
  activations: number;
  /** Días con uso en el periodo. */
  days?: number;
}

export interface CoverageRow {
  field: CoverageField;
  cls: CoverageClass;
  flows: Array<{ id: string; name: string }>;
  usage: CoverageUsage | null;
  noFlow: boolean;
  duplicate: boolean;
  /** Los otros campos con el mismo dato. */
  duplicateOf: string[];
  criticalRequired: boolean;
}

/** Clasifica cada campo (función pura). */
export function classifyCoverage(fields: CoverageField[], links: CoverageLink[], usage: CoverageUsage[] = []): CoverageRow[] {
  const linksOf = new Map<string, CoverageLink[]>();
  for (const l of links) linksOf.set(l.fieldId, [...(linksOf.get(l.fieldId) ?? []), l]);
  const usageOf = new Map(usage.map((u) => [u.fieldId, u]));
  const dataKey = (f: CoverageField) => (f.entity && f.prop ? `${f.entity}.${f.prop}` : null);
  const perKey = new Map<string, string[]>();
  for (const f of fields) { const k = dataKey(f); if (k) perKey.set(k, [...(perKey.get(k) ?? []), f.fieldId]); }
  return fields.map((field) => {
    const ls = linksOf.get(field.fieldId) ?? [];
    const use = usageOf.get(field.fieldId) ?? null;
    const via = (v: CoverageLink['via']) => ls.some((l) => l.via === v);
    const usedNow = (use ? use.activations > 0 : false) || field.used === true;
    // Sin vínculos con Flow: la clase parcial del núcleo (una capacidad lo toca aunque ningún paso la use) o la del uso.
    const cls: CoverageClass = via('direct') ? 'direct' : via('indirect') ? 'indirect' : via('automatic') ? 'automatic'
      : field.coreClass ?? (usedNow ? 'independent' : 'unknown');
    const flows = [...new Map(ls.flatMap((l) => l.flows).map((f) => [f.id, f])).values()];
    const key = dataKey(field);
    const duplicateOf = field.duplicates ?? (key ? (perKey.get(key) ?? []).filter((id) => id !== field.fieldId) : []);
    return {
      field, cls, flows, usage: use,
      noFlow: !flows.length,
      duplicate: duplicateOf.length > 0,
      duplicateOf,
      criticalRequired: !!field.critical && field.required === 'always',
    };
  });
}

/** Salida de `core.field_coverage` (0111): lo que hace falta de ella. */
export interface CoreFieldCoverage {
  fields: Array<{ fieldId: string; app: string; screen?: string | null; screenLabel?: string | null; label?: string | null; entity?: string | null; prop?: string | null; required?: string | null;
    capabilities?: Array<{ id: string; how: 'reads' | 'writes' }>; used?: boolean; duplicates?: string[]; class?: 'indirect' | 'independent' | 'unknown';
    candidate?: boolean; estimate?: { frequency?: string | null; audience?: string | null; impact?: string | null } | null; activations30d?: number | null }>;
}

/** Un paso o una regla de Flow (lo da Flow; lo cruza Central): toca un campo por su anclaje o por una capacidad. */
export interface FlowCoverageStep {
  flowId: string;
  flowName: string;
  /** `step`: un paso de un recorrido; `rule`: una regla o un disparador. */
  kind: 'step' | 'rule';
  /** Id del campo (`data-field-id`) que pinta o pide el paso. */
  anchor?: string | null;
  /** Capacidad que invoca. */
  capability?: string | null;
}

/**
 * Del núcleo y de Flow a `renderCoverage`. Un paso con el anclaje del campo es `direct` y una regla con él, `automatic`. Un paso
 * que invoca una capacidad que lee o escribe el dato del campo es `indirect` (o `automatic`, si es una regla). Lo demás se queda
 * con la clase parcial del núcleo. `extra` añade por campo lo que pone Central (crítico, estimado, utilidad declarada).
 */
export function coverageFromCore(core: CoreFieldCoverage, steps: FlowCoverageStep[] = [], extra: Record<string, Partial<CoverageField>> = {}): { fields: CoverageField[]; links: CoverageLink[]; usage: CoverageUsage[] } {
  const fields: CoverageField[] = core.fields.map((f) => ({
    fieldId: f.fieldId, app: f.app, screen: f.screen ?? null, screenLabel: f.screenLabel ?? null, label: f.label ?? null, entity: f.entity ?? null, prop: f.prop ?? null, required: f.required ?? null,
    capabilities: f.capabilities ?? [], duplicates: f.duplicates ?? [], used: !!f.used, coreClass: f.class ?? null,
    candidate: f.candidate === true, estimate: f.estimate ?? null, ...extra[f.fieldId],
  }));
  // Usos en 30 días que da el núcleo por campo (`activations30d`).
  const usage: CoverageUsage[] = core.fields.filter((f) => typeof f.activations30d === 'number' && f.activations30d >= 0)
    .map((f) => ({ fieldId: f.fieldId, activations: f.activations30d! }));
  const links: CoverageLink[] = [];
  for (const f of fields) {
    const caps = new Set((f.capabilities ?? []).map((c) => c.id));
    for (const s of steps) {
      const flow = { id: s.flowId, name: s.flowName };
      if (s.anchor === f.fieldId) links.push({ fieldId: f.fieldId, via: s.kind === 'rule' ? 'automatic' : 'direct', flows: [flow] });
      else if (s.capability && caps.has(s.capability)) links.push({ fieldId: f.fieldId, via: s.kind === 'rule' ? 'automatic' : 'indirect', flows: [flow], capabilities: [s.capability] });
    }
  }
  return { fields, links, usage };
}

export interface CoverageOptions {
  label: string;
  fields: CoverageField[];
  links: CoverageLink[];
  usage?: CoverageUsage[];
  /** Agrupar por app, pantalla o clase; por defecto, clase. */
  groupBy?: 'app' | 'screen' | 'class';
  /** «Ir al campo» o abrir su ficha. */
  onOpen?: (row: CoverageRow) => void;
  /** Días del periodo de uso, para el texto («en 30 días»). */
  periodDays?: number;
  /** Vista inicial: los candidatos por app → pantalla (por defecto) o todo el detalle. */
  view?: 'candidates' | 'all';
  /** Decisión de un grupo (`null` = deshacer). Si devuelve una promesa, el grupo espera; si falla, no cambia. */
  onDecide?: (decision: CoverageDecision | null, group: CoverageGroup) => Promise<unknown> | void;
  /** «Ajustar utilidad» del grupo: una excepción a la utilidad heredada para esa pantalla (la hoja la abre quien usa la pieza). */
  onDeclare?: (group: CoverageGroup) => void;
  feedbackId?: string;
}

export interface Coverage {
  element: HTMLElement;
  setData(data: { fields: CoverageField[]; links: CoverageLink[]; usage?: CoverageUsage[] }): void;
  summary(): Record<CoverageClass, number>;
  rows(): CoverageRow[];
  view(): 'candidates' | 'all';
  setView(view: 'candidates' | 'all'): void;
}

const DECISION_LABEL = (d: CoverageDecision): string => ({ keep: kt('Dejar'), later: kt('Revisar más tarde'), retire: kt('Retirar') }[d]);
const DECISION_TONE: Record<CoverageDecision, string> = { keep: 'ok', later: 'warn', retire: 'alert' };

const CLASS_LABEL = (c: CoverageClass): string => ({
  direct: kt('Paso de un recorrido'), indirect: kt('Lo usa una capacidad'), automatic: kt('Lo usa una regla'),
  independent: kt('Se usa sin Flow'), unknown: kt('Sin datos suficientes'),
}[c]);
const CLASS_TONE: Record<CoverageClass, string> = { direct: 'ok', indirect: 'ok', automatic: 'ok', independent: 'warn', unknown: '' };

export function renderCoverage(options: CoverageOptions): Coverage {
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  let all: CoverageRow[] = classifyCoverage(options.fields, options.links, options.usage);
  let only: CoverageClass | null = null;
  let groupBy = options.groupBy ?? 'class';
  let view: 'candidates' | 'all' = options.view ?? 'candidates';
  /** Decisión por campo: la que llega y la que se toma aquí. */
  let decided = new Map<string, CoverageDecision>();
  const fromFields = () => { decided = new Map(all.flatMap((r) => (r.field.decision ? [[r.field.fieldId, r.field.decision] as const] : []))); };
  fromFields();
  /** Grupos esperando a `onDecide`, y el que pide confirmar «Retirar». */
  const busy = new Set<string>();
  let arming: string | null = null;

  const viewBar = el('div', { class: 'cov-viewbar' });
  const summaryBox = el('div', { class: 'scrollrow cov-summary', role: 'group', 'aria-label': kt('Filtrar por clase') });
  const groupSwitch = el('div', { class: 'segmented cov-group', role: 'group', 'aria-label': kt('Agrupar por') });
  const body = el('div', { class: 'cov-body' });
  const live = el('p', { class: 'vh', role: 'status', 'aria-live': 'polite' });
  const element = el('section', { class: 'cov-box', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) },
    viewBar, summaryBox, groupSwitch, body, live);

  const counts = (): Record<CoverageClass, number> => Object.fromEntries(COVERAGE_CLASSES.map((c) => [c, all.filter((r) => r.cls === c).length])) as Record<CoverageClass, number>;

  function paintSummary(): void {
    const n = counts();
    replace(summaryBox,
      el('button', { type: 'button', class: 'chip cov-filter', 'aria-pressed': String(only === null), ...mark('filtro', 'Filtrar por clase'), onclick: () => { only = null; paint(); } },
        kt('Todas'), ' ', el('span', { class: 'cov-n' }, String(all.length))),
      ...COVERAGE_CLASSES.map((c) => el('button', { type: 'button', class: `chip cov-filter ${CLASS_TONE[c]}`, dataset: { cls: c }, 'aria-pressed': String(only === c), disabled: !n[c],
        ...mark('filtro', 'Filtrar por clase'), onclick: () => { only = only === c ? null : c; paint(); } }, CLASS_LABEL(c), ' ', el('span', { class: 'cov-n' }, String(n[c])))));
  }

  function paintSwitch(): void {
    replace(groupSwitch, ...(['class', 'app', 'screen'] as const).map((g) => el('button', { type: 'button', class: groupBy === g ? 'on' : '', 'aria-pressed': String(groupBy === g), dataset: { group: g },
      ...mark('agrupar', 'Agrupar por'), onclick: () => { groupBy = g; paint(); } }, { class: kt('Clase'), app: kt('App'), screen: kt('Pantalla') }[g])));
  }

  function rowEl(r: CoverageRow): HTMLElement {
    const f = r.field;
    const days = options.periodDays ?? 30;
    const use = r.usage ? (r.usage.activations === 1 ? kt('1 uso en {d} días', { d: String(days) }) : kt('{n} usos en {d} días', { n: String(r.usage.activations), d: String(days) }))
      : f.used ? kt('Con uso propio') : kt('Sin datos de uso');
    const caps = f.capabilities?.length ? kt('Lo usan: {list}', { list: f.capabilities.map((c) => `${c.id} (${c.how === 'writes' ? kt('escribe') : kt('lee')})`).join(', ') }) : null;
    const estimate = f.estimate ? [f.estimate.audience, f.estimate.impact, f.estimate.frequency].filter(Boolean).join(' · ') : '';
    const flows = r.flows.length ? (r.flows.length === 1 ? kt('En el recorrido «{name}»', { name: r.flows[0]!.name }) : kt('En {n} recorridos: {names}', { n: String(r.flows.length), names: r.flows.map((x) => x.name).join(', ') })) : null;
    const flags = [
      r.noFlow && r.cls !== 'unknown' ? el('span', { class: 'chip warn cov-flag', dataset: { flag: 'sin-flow' } }, kt('Sin cobertura de Flow')) : null,
      r.flows.length > 1 ? el('span', { class: 'chip cov-flag', dataset: { flag: 'comun' } }, kt('Común a varios recorridos')) : null,
      r.duplicate ? el('span', { class: 'chip warn cov-flag', dataset: { flag: 'duplicado' } }, f.entity && f.prop ? kt('Duplicado: {key}', { key: `${f.entity}.${f.prop}` }) : kt('Duplicado de {list}', { list: r.duplicateOf.join(', ') })) : null,
      r.criticalRequired ? el('span', { class: 'chip alert cov-flag', dataset: { flag: 'critico' } }, kt('Obligatorio en un proceso crítico')) : null,
    ].filter(Boolean) as HTMLElement[];
    const title = f.label || f.fieldId;
    return el('li', { class: 'cov-row', dataset: { field: f.fieldId, cls: r.cls } },
      el('div', { class: 'cov-main' },
        options.onOpen
          ? el('button', { type: 'button', class: 'linkbtn cov-title', ...mark('abrir', 'Abrir el campo'), onclick: () => options.onOpen!(r) }, title)
          : el('span', { class: 'cov-title' }, title),
        el('span', { class: 'cov-id' }, f.fieldId),
        el('span', { class: `chip cov-cls ${CLASS_TONE[r.cls]}` }, CLASS_LABEL(r.cls)),
        flows ? el('span', { class: 'cov-line' }, flows) : null,
        caps ? el('span', { class: 'cov-line cov-caps' }, caps) : null,
        el('span', { class: 'cov-line cov-use' }, use),
        estimate ? el('span', { class: 'cov-line' }, kt('Estimado de la app: {text}', { text: estimate })) : null,
        f.declared ? el('span', { class: 'cov-line' }, kt('Utilidad declarada: {text}', { text: f.declared })) : null,
        flags.length ? el('div', { class: 'cov-flags' }, ...flags) : null));
  }

  const groupKey = (app: string, screen: string | null) => `${app}|${screen ?? ''}`;
  const usesText = (n: number | null) => {
    const days = options.periodDays ?? 30;
    return n === null ? kt('Sin datos de uso') : n === 1 ? kt('1 uso en {d} días', { d: String(days) }) : kt('{n} usos en {d} días', { n: String(n), d: String(days) });
  };

  async function decide(group: CoverageGroup, decision: CoverageDecision | null): Promise<void> {
    const key = groupKey(group.app, group.screen);
    if (busy.has(key)) return;
    if (decision === 'retire' && arming !== key) { arming = key; paint(); focusGroup(key, '.cov-act[data-decision="retire"]'); return; }
    arming = null;
    busy.add(key);
    paint();
    try {
      await options.onDecide?.(decision, group);
      for (const id of group.fieldIds) { if (decision) decided.set(id, decision); else decided.delete(id); }
      live.textContent = decision ? kt('Decidido: {d}', { d: DECISION_LABEL(decision) }) : kt('Decisión deshecha');
    } catch {
      live.textContent = kt('No se pudo guardar la decisión.');
    } finally {
      busy.delete(key);
      paint();
      focusGroup(key, decided.has(group.fieldIds[0]!) ? '.cov-undo' : '.cov-act');
    }
  }

  function focusGroup(key: string, selector: string): void {
    const box = [...body.querySelectorAll<HTMLElement>('.cov-cand')].find((b) => b.dataset.key === key);
    box?.querySelector<HTMLElement>(selector)?.focus();
  }

  function paintCandidates(): void {
    const cands = all.filter((r) => r.field.candidate);
    const apps = [...new Set(cands.map((r) => r.field.app))].sort((a, b) => a.localeCompare(b));
    replace(viewBar,
      el('p', { class: 'cov-lead' }, cands.length
        ? `${cands.length === 1 ? kt('1 campo candidato') : kt('{n} campos candidatos', { n: String(cands.length) })} ${apps.length === 1 ? kt('en 1 app') : kt('en {m} apps', { m: String(apps.length) })}`
        : kt('No hay campos candidatos.')),
      el('button', { type: 'button', class: 'ghost small cov-viewall', ...mark('ver-todo', 'Ver todo'), onclick: () => api.setView('all') }, kt('Ver todo ({n})', { n: String(all.length) })));
    summaryBox.hidden = true;
    groupSwitch.hidden = true;
    replace(body, ...apps.map((app) => {
      const inApp = cands.filter((r) => r.field.app === app);
      const screens = [...new Set(inApp.map((r) => r.field.screen ?? null))].sort((a, b) => (a ?? '\uffff').localeCompare(b ?? '\uffff'));
      return el('section', { class: 'cov-app', dataset: { app } },
        el('h3', { class: 'cov-apptitle' }, el('span', null, app), el('span', { class: 'cov-n' }, String(inApp.length))),
        ...screens.map((screen) => groupEl(app, screen, inApp.filter((r) => (r.field.screen ?? null) === screen))));
    }));
  }

  function groupEl(app: string, screen: string | null, rows: CoverageRow[]): HTMLElement {
    const key = groupKey(app, screen);
    const group: CoverageGroup = { app, screen, fieldIds: rows.map((r) => r.field.fieldId) };
    const name = rows.find((r) => r.field.screenLabel)?.field.screenLabel ?? screen ?? kt('sin pantalla');
    const counted = rows.filter((r) => r.usage);
    const uses = counted.length ? counted.reduce((n, r) => n + r.usage!.activations, 0) : null;
    const ds = rows.map((r) => decided.get(r.field.fieldId) ?? null);
    const dec = ds.every((d) => d && d === ds[0]) ? ds[0] : null;
    const waiting = busy.has(key);
    const actions = dec
      ? el('div', { class: 'cov-actions' },
        el('span', { class: `chip cov-decision ${DECISION_TONE[dec]}`, dataset: { decision: dec } }, kt('Decidido: {d}', { d: DECISION_LABEL(dec) })),
        options.onDecide ? el('button', { type: 'button', class: 'ghost small cov-undo', disabled: waiting, ...mark('deshacer', 'Deshacer la decisión'), onclick: () => void decide(group, null) }, kt('Deshacer')) : null)
      : el('div', { class: 'cov-actions', role: 'group', 'aria-label': kt('Decisión para {group}', { group: `${app} · ${name}` }), 'aria-busy': waiting ? 'true' : null },
        ...COVERAGE_DECISIONS.map((d) => el('button', { type: 'button', class: `${d === 'retire' && arming === key ? 'danger' : 'ghost'} small cov-act`, dataset: { decision: d }, disabled: waiting || !options.onDecide,
          ...mark('decidir', 'Decidir el grupo'), onclick: () => void decide(group, d) },
          d === 'retire' && arming === key ? kt('Confirmar: retirar {n}', { n: String(rows.length) }) : DECISION_LABEL(d))));
    return el('div', { class: 'cov-cand', dataset: { key, screen: screen ?? '', decision: dec ?? '' } },
      el('div', { class: 'cov-candhead' },
        el('strong', { class: 'cov-screen' }, name),
        el('span', { class: 'cov-meta' }, rows.length === 1 ? kt('1 campo') : kt('{n} campos', { n: String(rows.length) }), ' · ', usesText(uses))),
      actions,
      options.onDeclare ? el('button', { type: 'button', class: 'linkbtn cov-declare', ...mark('utilidad', 'Ajustar la utilidad de la pantalla'), onclick: () => options.onDeclare!(group) }, kt('Ajustar utilidad')) : null,
      el('details', { class: 'cov-fields' },
        el('summary', null, kt('Ver los campos')),
        el('ul', { class: 'cov-list' }, ...rows.map((r) => {
          const e = r.field.estimate;
          const util = e ? [e.frequency, e.audience].filter(Boolean).join(' · ') : '';
          return el('li', { class: 'cov-row', dataset: { field: r.field.fieldId } },
            el('div', { class: 'cov-main' },
              options.onOpen ? el('button', { type: 'button', class: 'linkbtn cov-title', ...mark('abrir', 'Abrir el campo'), onclick: () => options.onOpen!(r) }, r.field.label || r.field.fieldId)
                : el('span', { class: 'cov-title' }, r.field.label || r.field.fieldId),
              el('span', { class: 'cov-id' }, r.field.fieldId),
              el('span', { class: 'cov-line' }, util ? kt('Utilidad heredada: {text}', { text: util }) : kt('Sin utilidad estimada')),
              el('span', { class: 'cov-line cov-use' }, usesText(r.usage ? r.usage.activations : null))));
        }))));
  }

  function paint(): void {
    if (view === 'candidates') { paintCandidates(); return; }
    replace(viewBar, el('button', { type: 'button', class: 'ghost small cov-viewcand', ...mark('ver-candidatos', 'Ver los candidatos'), onclick: () => api.setView('candidates') }, kt('Ver los candidatos')));
    summaryBox.hidden = false;
    groupSwitch.hidden = false;
    paintSummary();
    paintSwitch();
    const shown = all.filter((r) => !only || r.cls === only);
    if (!shown.length) { replace(body, el('p', { class: 'hint cov-empty' }, kt('No hay campos con este filtro.'))); live.textContent = ''; return; }
    const keyOf = (r: CoverageRow) => groupBy === 'class' ? r.cls : groupBy === 'app' ? r.field.app : `${r.field.app} · ${r.field.screen ?? kt('sin pantalla')}`;
    const titleOf = (k: string) => (groupBy === 'class' ? CLASS_LABEL(k as CoverageClass) : k);
    const order = groupBy === 'class' ? COVERAGE_CLASSES.filter((c) => shown.some((r) => r.cls === c)) : [...new Set(shown.map(keyOf))].sort((a, b) => a.localeCompare(b));
    replace(body, ...order.map((k) => {
      const rows = shown.filter((r) => keyOf(r) === k);
      return el('details', { class: 'cov-groupbox', open: true, dataset: { group: k } },
        el('summary', null, el('span', null, titleOf(k)), el('span', { class: 'cov-n' }, String(rows.length))),
        el('ul', { class: 'cov-list' }, ...rows.map(rowEl)));
    }));
    live.textContent = kt('{n} campos', { n: String(shown.length) });
  }

  const api: Coverage = {
    element,
    setData(data) { all = classifyCoverage(data.fields, data.links, data.usage); fromFields(); arming = null; paint(); },
    summary: counts,
    rows: () => all.slice(),
    view: () => view,
    setView(next) {
      if (next === view) return;
      view = next;
      arming = null;
      paint();
      viewBar.querySelector<HTMLElement>('button')?.focus();
    },
  };
  paint();
  return api;
}
