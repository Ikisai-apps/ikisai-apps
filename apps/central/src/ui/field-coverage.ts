/**
 * Central · Revisor › cobertura de campos por pantalla (decisiones de VG del 27-10). Para Dirección (owner y editor con el
 * ámbito `direccion`). Por defecto, solo los **candidatos** del núcleo (sin cobertura de Flow, sin uso en 30 días y sin
 * estimado de la app), agrupados por app y pantalla, con un resumen «N campos en M pantallas». En cada grupo, una sola
 * acción: «Dejar», «Revisar más tarde» o «Retirar» (pide confirmación; no borra nada), y, si hace falta, «Declarar» la
 * utilidad de esa pantalla como excepción a la heredada. «Ver todo» enseña todos los campos con la pieza del kit
 * `renderCoverage`. Lo decidido se guarda en `central.field_group_reviews`. Necesita red (lo cruza la Edge).
 */
import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, el, openSheet, renderCoverage, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  GROUP_DECISION_LABELS, UTILITY_FREQUENCIES, candidateGroups, candidatesSummary, canDeclareUtility, fieldLinks, inheritedUtility, validateOperations,
  type CandidateGroup, type CoreCoverageField, type FlowAnchor, type FlowRule, type GroupDecision, type GroupReview,
} from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import { APP_NAMES } from './dashboard.ts';
import type { ViewMount } from './shell.ts';

type Review = GroupReview & { id: string; revision: number };
type Payload = { fields: CoreCoverageField[]; anchors: FlowAnchor[]; rules: FlowRule[]; flowAvailable: boolean };

export const mountFieldCoverage: ViewMount = ({ main, client, usage }) => {
  let alive = true;
  const membership = client.bootstrap()?.membership ?? { role: 'reader' };
  const note = el('div', { id: 'fieldCoverageNote', 'data-feedback-id': 'central.campos.aviso', 'data-feedback-label': 'Aviso de la cobertura' });
  const summary = el('p', { class: 'ctl-covsummary', id: 'fieldCoverageSummary', 'data-feedback-id': 'central.campos.resumen', 'data-feedback-label': 'Resumen de candidatos' });
  const host = el('div', { id: 'fieldCoverage', 'data-feedback-id': 'central.campos.lista', 'data-feedback-label': 'Cobertura de campos' }, el('p', { class: 'muted' }, 'Leyendo la cobertura…'));
  let showAll = false;
  const toggle = el('button', { class: 'linkbtn', type: 'button', id: 'fieldCoverageAll', 'data-feedback-id': 'central.campos.ver_todo', 'data-feedback-label': 'Ver todo', onclick: () => { showAll = !showAll; paint(); } }, 'Ver todo');
  replace(main,
    el('a', { href: '#/revision/uso', class: 'backlink', 'data-feedback-id': 'central.campos.volver', 'data-feedback-label': 'Volver a Uso y cobertura' }, '← Uso y cobertura'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.campos.cabecera', 'data-feedback-label': 'Cabecera de la cobertura de campos' },
      el('div', null, el('h2', null, 'Cobertura de campos'),
        el('p', null, 'Los campos que ningún recorrido usa, nadie ha tocado en 30 días y su app no protege, por pantalla. Decide por pantalla, una vez: el resto de la utilidad se hereda de cada app.'))),
    note, el('div', { class: 'ctl-covhead' }, summary, toggle), host);
  if (!canDeclareUtility(membership)) {
    replace(host, el('p', { class: 'hint' }, 'La cobertura de campos es para Dirección: quien administra Central y quien tiene el ámbito de Dirección.'));
    replace(summary); toggle.hidden = true;
    return () => { alive = false; };
  }

  let payload: Payload | null = null;
  let reviews: Review[] = [];
  const reviewOf = (app: string, screen: string) => reviews.find((r) => r.app === app && r.screen === screen && !r.deleted_at) ?? null;

  // Cada acción con su id de uso literal (el catálogo de la publicación solo recoge literales).
  const send = {
    decidir: (ops: RowOperation[]) => usage.run('central.campos.decidir', () => client.commit(ops)),
    declarar: (ops: RowOperation[]) => usage.run('central.campos.declarar', () => client.commit(ops)),
  };
  async function save(g: CandidateGroup, fields: Record<string, unknown>, how: keyof typeof send, done: string): Promise<boolean> {
    const current = reviewOf(g.app, g.screen);
    const operations: RowOperation[] = current
      ? [{ op: 'update', table: T.fieldGroupReviews, id: current.id, expectedRevision: Number(current.revision), fields }]
      : [{ op: 'insert', table: T.fieldGroupReviews, id: crypto.randomUUID(), fields: { app: g.app, screen: g.screen, ...fields } }];
    const issue = validateOperations(operations, membership);
    if (issue) { toast(issue.message); return false; }
    try {
      await send[how](operations);
      toast(done);
      reviews = ((await client.list(T.fieldGroupReviews)) as unknown as Review[]).filter((x) => !x.deleted_at);
      paint();
      return true;
    } catch (e) { toast(describeError(e)); return false; }
  }

  async function decide(g: CandidateGroup, decision: GroupDecision): Promise<void> {
    if (decision === 'retirar' && !(await confirmDialog({ title: `¿Retirar los ${g.fields.length} campos de «${g.label}»?`, text: 'No se borra nada: queda anotado para el equipo de la app, que decidirá cómo quitarlos.', confirmLabel: 'Retirar' }))) return;
    await save(g, { decision, fields_count: g.fields.length }, 'decidir', `${GROUP_DECISION_LABELS[decision]}: ${g.label}.`);
  }

  function declare(g: CandidateGroup): void {
    const current = reviewOf(g.app, g.screen);
    let sheet: Sheet | null = null;
    const audience = el('input', { id: 'fgAudience', 'data-field-id': 'central.campos.audience', maxlength: 60, value: current?.audience ?? '', placeholder: 'Recepción, cocina, dirección…' }) as HTMLInputElement;
    const frequency = el('select', { id: 'fgFrequency', 'data-field-id': 'central.campos.frequency' }, el('option', { value: '' }, 'La de la app'),
      ...UTILITY_FREQUENCIES.map((v) => el('option', { value: v, selected: current?.frequency === v }, v))) as HTMLSelectElement;
    const text = el('textarea', { id: 'fgNote', 'data-field-id': 'central.campos.note', maxlength: 300, rows: 2 }, current?.note ?? '') as HTMLTextAreaElement;
    const ok = el('button', { class: 'primary', type: 'button', id: 'fgSave', 'data-feedback-id': 'central.campos.declarar.guardar', 'data-feedback-label': 'Guardar la excepción', onclick: async () => {
      if (await save(g, { audience: audience.value.trim() || null, frequency: frequency.value || null, note: text.value.trim() || null }, 'declarar', 'Utilidad de la pantalla guardada.')) await sheet?.close(true);
    } }, 'Guardar');
    sheet = openSheet({ title: `Utilidad de «${g.label}»`, meta: APP_NAMES[g.app] ?? g.app,
      body: el('div', { 'data-feedback-id': 'central.campos.declarar', 'data-feedback-label': 'Declarar la utilidad de la pantalla' },
        el('p', { class: 'muted small' }, 'Solo si lo que estima la app no vale para esta pantalla. Vale para todos sus campos.'),
        el('label', { class: 'field' }, el('span', null, 'A quién sirve'), audience),
        el('label', { class: 'field' }, el('span', null, 'Con qué frecuencia'), frequency),
        el('label', { class: 'field' }, el('span', null, 'Nota'), text)),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.campos.declarar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), ok], initialFocus: audience });
  }

  function groupCard(g: CandidateGroup): HTMLElement {
    const review = reviewOf(g.app, g.screen);
    const decided = review?.decision as GroupDecision | null | undefined;
    const uses = g.fields.reduce((n, f) => n + (f.activations30d ?? 0), 0);
    const button = (d: GroupDecision) => el('button', { class: `small ${d === 'retirar' ? 'danger' : 'ghost'}`, type: 'button', 'aria-label': `${GROUP_DECISION_LABELS[d]}: ${g.label}`,
      'data-feedback-id': 'central.campos.decision', 'data-feedback-label': 'Decidir el grupo', dataset: { decision: d }, onclick: () => void decide(g, d) }, GROUP_DECISION_LABELS[d]);
    return el('li', { class: 'ctl-covgroup', 'data-app': g.app, 'data-screen': g.screen },
      el('div', null,
        el('strong', null, g.label), el('span', { class: 'muted small' }, ` · ${g.fields.length} ${g.fields.length === 1 ? 'campo' : 'campos'} · ${uses === 1 ? '1 uso' : `${uses} usos`} en 30 días`), ' ',
        decided ? el('span', { class: `chip ${decided === 'retirar' ? 'alert' : decided === 'dejar' ? 'ok' : 'warn'}`, 'data-decided': decided }, GROUP_DECISION_LABELS[decided]) : null,
        review?.audience || review?.frequency ? el('div', { class: 'muted small' }, `Utilidad declarada: ${[review.audience, review.frequency].filter(Boolean).join(' · ')}`) : null,
        el('details', { class: 'ctl-covfields' }, el('summary', null, 'Ver los campos'),
          el('ul', { class: 'list' }, ...g.fields.map((f) => el('li', { class: 'small' }, f.label || f.fieldId, el('span', { class: 'muted' }, ` · ${inheritedUtility(f, review) ?? 'sin estimado ni uso'}`)))))),
      el('div', { class: 'toolbar' }, button('dejar'), button('revisar_mas_tarde'), button('retirar'),
        el('button', { class: 'linkbtn small', type: 'button', 'aria-label': `Declarar la utilidad: ${g.label}`, 'data-feedback-id': 'central.campos.declarar_abrir', 'data-feedback-label': 'Declarar la utilidad', onclick: () => declare(g) }, 'Declarar')));
  }

  const coverage = renderCoverage({ label: 'Todos los campos', fields: [], links: [], feedbackId: 'central.campos.cobertura' });

  function paint(): void {
    if (!payload || !alive) return;
    const links = fieldLinks(payload.fields, payload.anchors, payload.rules);
    replace(note, payload.flowAvailable ? null
      : el('p', { class: 'note', id: 'fieldCoverageNoFlow' }, 'Flow no ha respondido: faltan los pasos de los recorridos y las reglas. Lo demás está al día.'));
    toggle.textContent = showAll ? 'Solo los candidatos' : 'Ver todo';
    if (showAll) {
      replace(summary, `${payload.fields.length} campos en total.`);
      coverage.setData({
        fields: payload.fields.map((f) => ({ fieldId: f.fieldId, app: f.app, screen: f.screen, label: f.label, entity: f.entity, prop: f.prop, required: f.required, declared: inheritedUtility(f, reviewOf(f.app, f.screen ?? '')) })),
        links, usage: payload.fields.filter((f) => (f.activations30d ?? 0) > 0 || f.used).map((f) => ({ fieldId: f.fieldId, activations: f.activations30d ?? 1 })),
      });
      replace(host, coverage.element);
      return;
    }
    const groups = candidateGroups(payload.fields, links);
    const pending = groups.filter((g) => !reviewOf(g.app, g.screen)?.decision);
    replace(summary, groups.length ? `${candidatesSummary(groups)}${pending.length < groups.length ? ` · ${pending.length} por decidir` : ''}` : 'Ningún campo candidato.');
    const apps = [...new Set(groups.map((g) => g.app))];
    replace(host, groups.length
      ? el('div', null, ...apps.map((app) => el('section', { class: 'ctl-covapp', 'data-app': app },
        el('h3', null, APP_NAMES[app] ?? app),
        el('ul', { class: 'list' }, ...groups.filter((g) => g.app === app).map(groupCard)))))
      : el('p', { class: 'hint' }, 'Todos los campos tienen recorrido, uso o estimado de su app. No hay nada que decidir.'));
  }

  async function load(): Promise<void> {
    try {
      const [p, r] = await Promise.all([client.api<Payload>('/coverage/fields'), client.list(T.fieldGroupReviews)]);
      if (!alive) return;
      payload = p;
      reviews = (r as unknown as Review[]).filter((x) => !x.deleted_at);
      paint();
    } catch (e) {
      if (alive) replace(note, el('p', { class: 'formerror' }, navigator.onLine ? describeError(e) : 'La cobertura se lee con conexión.'));
    }
  }

  void load();
  return () => { alive = false; };
};
