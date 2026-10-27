/**
 * Central · Revisor › cobertura de campos por pantalla (decisiones de VG del 27-10). Para Dirección (owner y editor con el
 * ámbito `direccion`). La pinta la pieza del kit (`coverageFromCore` + `renderCoverage`, #1065), con el mismo criterio de
 * clases para todas las apps: por defecto, los **candidatos** por app y pantalla; en cada grupo, «Dejar», «Revisar más tarde»
 * o «Retirar», una vez y con «Deshacer», y «Ajustar utilidad» como excepción por pantalla. «Ver todo», el detalle por clase.
 * Central pone lo que es suyo: lo que da Flow (pasos y reglas, en la forma del kit), la etiqueta de la pantalla si el núcleo
 * no la trae, la utilidad heredada y lo decidido (`central.field_group_reviews`). Necesita red (lo cruza la Edge).
 */
import type { RowOperation } from '@ikisai/sync-client';
import { coverageFromCore, el, openSheet, renderCoverage, replace, toast, type CoverageField, type Sheet } from '@ikisai/ui-kit';
import {
  DECISION_TO_KIT, KIT_TO_DECISION, UTILITY_FREQUENCIES, canDeclareUtility, fieldLinks, flowSteps, inheritedUtility, isCandidate, screenName, validateOperations,
  type CoreCoverageField, type FlowAnchor, type FlowRule, type GroupDecision, type GroupReview,
} from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import { APP_NAMES } from './dashboard.ts';
import type { ViewMount } from './shell.ts';

type Review = GroupReview & { id: string; revision: number };
type Payload = { fields: CoreCoverageField[]; anchors: FlowAnchor[]; rules: FlowRule[]; flowAvailable: boolean };
type KitGroup = { app: string; screen: string | null; fieldIds: string[] };
type KitDecision = keyof typeof KIT_TO_DECISION;

export const mountFieldCoverage: ViewMount = ({ main, client, usage }) => {
  let alive = true;
  const membership = client.bootstrap()?.membership ?? { role: 'reader' };
  const note = el('div', { id: 'fieldCoverageNote', 'data-feedback-id': 'central.campos.aviso', 'data-feedback-label': 'Aviso de la cobertura' });
  const host = el('div', { id: 'fieldCoverage', 'data-feedback-id': 'central.campos.lista', 'data-feedback-label': 'Cobertura de campos' }, el('p', { class: 'muted' }, 'Leyendo la cobertura…'));
  replace(main,
    el('a', { href: '#/revision/uso', class: 'backlink', 'data-feedback-id': 'central.campos.volver', 'data-feedback-label': 'Volver a Uso y cobertura' }, '← Uso y cobertura'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.campos.cabecera', 'data-feedback-label': 'Cabecera de la cobertura de campos' },
      el('div', null, el('h2', null, 'Cobertura de campos'),
        el('p', null, 'Los campos que ningún recorrido usa, nadie ha tocado en 30 días y su app no protege, por pantalla. Decide por pantalla, una vez: el resto de la utilidad se hereda de cada app.'))),
    note, host);
  if (!canDeclareUtility(membership)) {
    replace(host, el('p', { class: 'hint' }, 'La cobertura de campos es para Dirección: quien administra Central y quien tiene el ámbito de Dirección.'));
    return () => { alive = false; };
  }

  let payload: Payload | null = null;
  let reviews: Review[] = [];
  const reviewOf = (app: string, screen: string | null | undefined) => reviews.find((r) => r.app === app && r.screen === (screen ?? '') && !r.deleted_at) ?? null;
  const screenOf = (f: CoreCoverageField) => f.screen ?? f.fieldId.split('.').slice(0, 2).join('.');

  // Cada acción con su id de uso literal (el catálogo de la publicación solo recoge literales).
  const send = {
    decidir: (ops: RowOperation[]) => usage.run('central.campos.decidir', () => client.commit(ops)),
    declarar: (ops: RowOperation[]) => usage.run('central.campos.declarar', () => client.commit(ops)),
  };
  async function save(app: string, screen: string, fields: Record<string, unknown>, how: keyof typeof send): Promise<void> {
    const current = reviewOf(app, screen);
    const operations: RowOperation[] = current
      ? [{ op: 'update', table: T.fieldGroupReviews, id: current.id, expectedRevision: Number(current.revision), fields }]
      : [{ op: 'insert', table: T.fieldGroupReviews, id: crypto.randomUUID(), fields: { app, screen, ...fields } }];
    const issue = validateOperations(operations, membership);
    if (issue) throw new Error(issue.message);
    await send[how](operations);
    reviews = ((await client.list(T.fieldGroupReviews)) as unknown as Review[]).filter((x) => !x.deleted_at);
  }

  /** Lo que decide el kit, guardado en Central; `null` («Deshacer») deja la pantalla sin decisión. */
  async function onDecide(decision: KitDecision | null, group: KitGroup): Promise<void> {
    const screen = group.screen ?? '';
    try {
      await save(group.app, screen, { decision: decision ? KIT_TO_DECISION[decision] : null, fields_count: group.fieldIds.length }, 'decidir');
      paint();
    } catch (e) { toast(describeError(e)); throw e; }
  }

  function onDeclare(group: KitGroup): void {
    const screen = group.screen ?? '';
    const current = reviewOf(group.app, screen);
    const label = payload?.fields.find((f) => f.app === group.app && screenOf(f) === screen);
    let sheet: Sheet | null = null;
    const audience = el('input', { id: 'fgAudience', 'data-field-id': 'central.campos.audience', maxlength: 60, value: current?.audience ?? '', placeholder: 'Recepción, cocina, dirección…' }) as HTMLInputElement;
    const frequency = el('select', { id: 'fgFrequency', 'data-field-id': 'central.campos.frequency' }, el('option', { value: '' }, 'La de la app'),
      ...UTILITY_FREQUENCIES.map((v) => el('option', { value: v, selected: current?.frequency === v }, v))) as HTMLSelectElement;
    const text = el('textarea', { id: 'fgNote', 'data-field-id': 'central.campos.note', maxlength: 300, rows: 2 }, current?.note ?? '') as HTMLTextAreaElement;
    const ok = el('button', { class: 'primary', type: 'button', id: 'fgSave', 'data-feedback-id': 'central.campos.declarar.guardar', 'data-feedback-label': 'Guardar la excepción', onclick: async () => {
      try {
        await save(group.app, screen, { audience: audience.value.trim() || null, frequency: frequency.value || null, note: text.value.trim() || null }, 'declarar');
        toast('Utilidad de la pantalla guardada.');
        await sheet?.close(true);
        paint();
      } catch (e) { toast(describeError(e)); }
    } }, 'Guardar');
    sheet = openSheet({ title: `Utilidad de «${label ? screenName(label) : screen}»`, meta: APP_NAMES[group.app] ?? group.app,
      body: el('div', { 'data-feedback-id': 'central.campos.declarar', 'data-feedback-label': 'Declarar la utilidad de la pantalla' },
        el('p', { class: 'muted small' }, 'Solo si lo que estima la app no vale para esta pantalla. Vale para todos sus campos.'),
        el('label', { class: 'field' }, el('span', null, 'A quién sirve'), audience),
        el('label', { class: 'field' }, el('span', null, 'Con qué frecuencia'), frequency),
        el('label', { class: 'field' }, el('span', null, 'Nota'), text)),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.campos.declarar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), ok], initialFocus: audience });
  }

  const coverage = renderCoverage({ label: 'Cobertura de campos', fields: [], links: [], view: 'candidates', feedbackId: 'central.campos.cobertura', onDecide, onDeclare });
  replace(host, coverage.element);

  function paint(): void {
    if (!payload || !alive) return;
    replace(note, payload.flowAvailable ? null
      : el('p', { class: 'note', id: 'fieldCoverageNoFlow' }, 'Flow no ha respondido: faltan los pasos de los recorridos y las reglas. Lo demás está al día.'));
    // Lo de Central por campo: candidato (si el núcleo aún no lo da, la misma regla), pantalla en lenguaje de persona,
    // utilidad heredada y lo ya decidido para su pantalla.
    const linked = new Set(fieldLinks(payload.fields, payload.anchors, payload.rules).map((l) => l.fieldId));
    const extra: Record<string, Partial<CoverageField>> = {};
    for (const f of payload.fields) {
      const review = reviewOf(f.app, screenOf(f));
      extra[f.fieldId] = {
        screen: screenOf(f), screenLabel: screenName(f), candidate: isCandidate(f, linked), declared: inheritedUtility(f, review),
        decision: review?.decision ? DECISION_TO_KIT[review.decision as GroupDecision] : null,
      } as Partial<CoverageField>;
    }
    coverage.setData(coverageFromCore({ fields: payload.fields as never }, flowSteps(payload.fields, payload.anchors, payload.rules), extra));
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
