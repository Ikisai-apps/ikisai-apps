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
  label?: string | null;
  entity?: string | null;
  prop?: string | null;
  /** `always`, `never` o la condición (inventario de campos). */
  required?: string | null;
  /** Lo marca Central: el campo pertenece a un proceso crítico. */
  critical?: boolean;
  /** Utilidad declarada por Central («Recepción · diaria · alto impacto»). */
  declared?: string | null;
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
  criticalRequired: boolean;
}

/** Clasifica cada campo (función pura). */
export function classifyCoverage(fields: CoverageField[], links: CoverageLink[], usage: CoverageUsage[] = []): CoverageRow[] {
  const linksOf = new Map<string, CoverageLink[]>();
  for (const l of links) linksOf.set(l.fieldId, [...(linksOf.get(l.fieldId) ?? []), l]);
  const usageOf = new Map(usage.map((u) => [u.fieldId, u]));
  const dataKey = (f: CoverageField) => (f.entity && f.prop ? `${f.entity}.${f.prop}` : null);
  const perKey = new Map<string, number>();
  for (const f of fields) { const k = dataKey(f); if (k) perKey.set(k, (perKey.get(k) ?? 0) + 1); }
  return fields.map((field) => {
    const ls = linksOf.get(field.fieldId) ?? [];
    const use = usageOf.get(field.fieldId) ?? null;
    const via = (v: CoverageLink['via']) => ls.some((l) => l.via === v);
    const cls: CoverageClass = via('direct') ? 'direct' : via('indirect') ? 'indirect' : via('automatic') ? 'automatic'
      : use && use.activations > 0 ? 'independent' : 'unknown';
    const flows = [...new Map(ls.flatMap((l) => l.flows).map((f) => [f.id, f])).values()];
    const key = dataKey(field);
    return {
      field, cls, flows, usage: use,
      noFlow: !ls.length,
      duplicate: !!key && (perKey.get(key) ?? 0) > 1,
      criticalRequired: !!field.critical && field.required === 'always',
    };
  });
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
  feedbackId?: string;
}

export interface Coverage {
  element: HTMLElement;
  setData(data: { fields: CoverageField[]; links: CoverageLink[]; usage?: CoverageUsage[] }): void;
  summary(): Record<CoverageClass, number>;
  rows(): CoverageRow[];
}

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

  const summaryBox = el('div', { class: 'scrollrow cov-summary', role: 'group', 'aria-label': kt('Filtrar por clase') });
  const groupSwitch = el('div', { class: 'segmented cov-group', role: 'group', 'aria-label': kt('Agrupar por') });
  const body = el('div', { class: 'cov-body' });
  const live = el('p', { class: 'vh', role: 'status', 'aria-live': 'polite' });
  const element = el('section', { class: 'cov-box', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) },
    summaryBox, groupSwitch, body, live);

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
    const use = r.usage ? (r.usage.activations === 1 ? kt('1 uso en {d} días', { d: String(days) }) : kt('{n} usos en {d} días', { n: String(r.usage.activations), d: String(days) })) : kt('Sin datos de uso');
    const flows = r.flows.length ? (r.flows.length === 1 ? kt('En el recorrido «{name}»', { name: r.flows[0]!.name }) : kt('En {n} recorridos: {names}', { n: String(r.flows.length), names: r.flows.map((x) => x.name).join(', ') })) : null;
    const flags = [
      r.noFlow && r.cls !== 'unknown' ? el('span', { class: 'chip warn cov-flag', dataset: { flag: 'sin-flow' } }, kt('Sin cobertura de Flow')) : null,
      r.flows.length > 1 ? el('span', { class: 'chip cov-flag', dataset: { flag: 'comun' } }, kt('Común a varios recorridos')) : null,
      r.duplicate ? el('span', { class: 'chip warn cov-flag', dataset: { flag: 'duplicado' } }, kt('Duplicado: {key}', { key: `${f.entity}.${f.prop}` })) : null,
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
        el('span', { class: 'cov-line cov-use' }, use),
        f.declared ? el('span', { class: 'cov-line' }, kt('Utilidad declarada: {text}', { text: f.declared })) : null,
        flags.length ? el('div', { class: 'cov-flags' }, ...flags) : null));
  }

  function paint(): void {
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

  paint();
  return {
    element,
    setData(data) { all = classifyCoverage(data.fields, data.links, data.usage); paint(); },
    summary: counts,
    rows: () => all.slice(),
  };
}
