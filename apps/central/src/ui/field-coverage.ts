/**
 * Central · Revisor › cobertura de campos (análisis en MUELA/equipo/feedback/central/COBERTURA_CAMPOS.md; VG 27-10). Para
 * Dirección (owner y editor con el ámbito `direccion`). Cada campo de cada app con su clase: la del núcleo (capacidad, uso
 * propio o sin datos) y la de Flow (paso de un recorrido o regla), con la pieza del kit `renderCoverage`. Tocar un campo
 * abre su utilidad (audiencia, frecuencia, impacto y si es de un proceso crítico), que se guarda en `central.field_utility`.
 * «Sin datos» no es «inútil»: la pantalla lo dice. Necesita red (lo cruza la Edge).
 */
import { el, openSheet, renderCoverage, replace, toast, type CoverageField, type CoverageRow, type Sheet } from '@ikisai/ui-kit';
import {
  UTILITY_FREQUENCIES, UTILITY_FREQUENCY_LABELS, UTILITY_IMPACTS, UTILITY_IMPACT_LABELS, canDeclareUtility, fieldLinks, utilityText, validateOperations,
  type CoreCoverageField, type FieldUtility, type FlowAnchor, type FlowRule,
} from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

type Utility = FieldUtility & { id: string; revision: number };
type Payload = { fields: CoreCoverageField[]; anchors: FlowAnchor[]; rules: FlowRule[]; flowAvailable: boolean };

export const mountFieldCoverage: ViewMount = ({ main, client, usage }) => {
  let alive = true;
  const membership = client.bootstrap()?.membership ?? { role: 'reader' };
  const note = el('div', { id: 'fieldCoverageNote', 'data-feedback-id': 'central.campos.aviso', 'data-feedback-label': 'Aviso de la cobertura' });
  const host = el('div', { id: 'fieldCoverage', 'data-feedback-id': 'central.campos.lista', 'data-feedback-label': 'Cobertura de campos' }, el('p', { class: 'muted' }, 'Leyendo la cobertura…'));
  replace(main,
    el('a', { href: '#/revision/uso', class: 'backlink', 'data-feedback-id': 'central.campos.volver', 'data-feedback-label': 'Volver a Uso y cobertura' }, '← Uso y cobertura'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.campos.cabecera', 'data-feedback-label': 'Cabecera de la cobertura de campos' },
      el('div', null, el('h2', null, 'Cobertura de campos'),
        el('p', null, 'Qué campos usan los recorridos de Flow, cuáles se usan solo en su app y de cuáles aún no hay datos. Sin datos no quiere decir que sobre: primero hay que medirlo.'))),
    note, host);
  if (!canDeclareUtility(membership)) {
    replace(host, el('p', { class: 'hint' }, 'La cobertura de campos es para Dirección: quien administra Central y quien tiene el ámbito de Dirección.'));
    return () => { alive = false; };
  }

  let payload: Payload | null = null;
  let utilities: Utility[] = [];
  const coverage = renderCoverage({ label: 'Cobertura de campos', fields: [], links: [], feedbackId: 'central.campos.cobertura', onOpen: (row) => void openUtility(row) });
  replace(host, coverage.element);

  const fieldsOf = (p: Payload): CoverageField[] => p.fields.map((f) => {
    const u = utilities.find((x) => x.field_id === f.fieldId && !x.deleted_at);
    return { fieldId: f.fieldId, app: f.app, screen: f.screen, label: f.label, entity: f.entity, prop: f.prop, required: f.required, critical: !!u?.critical, declared: utilityText(u) };
  });
  // Uso propio (núcleo): el kit lo cuenta como «se usa sin Flow».
  const usageOf = (p: Payload) => p.fields.filter((f) => f.used).map((f) => ({ fieldId: f.fieldId, activations: 1 }));

  function paint(): void {
    if (!payload || !alive) return;
    coverage.setData({ fields: fieldsOf(payload), links: fieldLinks(payload.fields, payload.anchors, payload.rules), usage: usageOf(payload) });
    replace(note, payload.flowAvailable ? null
      : el('p', { class: 'note', id: 'fieldCoverageNoFlow' }, 'Flow no ha respondido: faltan los pasos de los recorridos y las reglas. Lo demás está al día.'));
  }

  async function load(): Promise<void> {
    try {
      const [p, u] = await Promise.all([client.api<Payload>('/coverage/fields'), client.list(T.fieldUtility)]);
      if (!alive) return;
      payload = p;
      utilities = (u as unknown as Utility[]).filter((x) => !x.deleted_at);
      paint();
    } catch (e) {
      if (alive) replace(note, el('p', { class: 'formerror' }, navigator.onLine ? describeError(e) : 'La cobertura se lee con conexión.'));
    }
  }

  async function openUtility(row: CoverageRow): Promise<void> {
    const f = row.field;
    const current = utilities.find((x) => x.field_id === f.fieldId && !x.deleted_at) ?? null;
    let sheet: Sheet | null = null;
    const audience = el('input', { id: 'fu-audience', 'data-field-id': 'central.campos.audience', maxlength: 60, value: current?.audience ?? '', placeholder: 'Recepción, cocina, dirección…' }) as HTMLInputElement;
    const frequency = el('select', { id: 'fu-frequency', 'data-field-id': 'central.campos.frequency' }, el('option', { value: '' }, 'Sin declarar'),
      ...UTILITY_FREQUENCIES.map((v) => el('option', { value: v, selected: current?.frequency === v }, UTILITY_FREQUENCY_LABELS[v]))) as HTMLSelectElement;
    const impact = el('select', { id: 'fu-impact', 'data-field-id': 'central.campos.impact' }, el('option', { value: '' }, 'Sin declarar'),
      ...UTILITY_IMPACTS.map((v) => el('option', { value: v, selected: current?.impact === v }, UTILITY_IMPACT_LABELS[v]))) as HTMLSelectElement;
    const critical = el('input', { id: 'fu-critical', 'data-field-id': 'central.campos.critical', type: 'checkbox', checked: !!current?.critical }) as HTMLInputElement;
    const noteInput = el('textarea', { id: 'fu-note', 'data-field-id': 'central.campos.note', maxlength: 300, rows: 2 }, current?.note ?? '') as HTMLTextAreaElement;
    const error = el('p', { class: 'formerror', role: 'alert', 'data-feedback-id': 'central.campos.utilidad.error', 'data-feedback-label': 'Error de la utilidad' });
    const save = el('button', { class: 'primary', type: 'button', id: 'fuSave', 'data-feedback-id': 'central.campos.utilidad.guardar', 'data-feedback-label': 'Guardar la utilidad', onclick: async () => {
      const fields = { app: f.app, field_id: f.fieldId, audience: audience.value.trim() || null, frequency: frequency.value || null, impact: impact.value || null, critical: critical.checked, note: noteInput.value.trim() || null };
      const operations = current
        ? [{ op: 'update' as const, table: T.fieldUtility, id: current.id, expectedRevision: Number(current.revision), fields: { audience: fields.audience, frequency: fields.frequency, impact: fields.impact, critical: fields.critical, note: fields.note } }]
        : [{ op: 'insert' as const, table: T.fieldUtility, id: crypto.randomUUID(), fields }];
      const issue = validateOperations(operations, membership);
      if (issue) { error.textContent = issue.message; return; }
      try {
        await usage.run('central.campos.utilidad.guardar', () => client.commit(operations));
        toast('Utilidad guardada.');
        await sheet?.close(true);
        utilities = ((await client.list(T.fieldUtility)) as unknown as Utility[]).filter((x) => !x.deleted_at);
        paint();
      } catch (e) { error.textContent = describeError(e); }
    } }, 'Guardar');
    sheet = openSheet({ title: f.label || f.fieldId, meta: f.fieldId,
      body: el('div', { 'data-feedback-id': 'central.campos.utilidad', 'data-feedback-label': 'Utilidad del campo' },
        el('p', { class: 'muted small' }, 'Lo declara Dirección. Sirve para decidir qué se simplifica; un campo sin datos de uso no se retira por eso.'),
        el('label', { class: 'field' }, el('span', null, 'A quién sirve'), audience),
        el('label', { class: 'field' }, el('span', null, 'Con qué frecuencia'), frequency),
        el('label', { class: 'field' }, el('span', null, 'Impacto'), impact),
        el('label', { class: 'check' }, critical, el('span', null, 'Es de un proceso crítico')),
        el('label', { class: 'field' }, el('span', null, 'Nota'), noteInput),
        error),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.campos.utilidad.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save],
      initialFocus: audience });
  }

  void load();
  return () => { alive = false; };
};

