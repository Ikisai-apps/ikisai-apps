import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'playwright/test';
// @ts-expect-error: script de Node sin tipos.
import { extractFields, fieldReport, generateCatalog } from '../scripts/feature-catalog.mjs';

/** Inventario semántico de campos (visión V0.2, encargo de Core; forma acordada con Central para «Uso y cobertura»). */
test.describe('ui-kit v0.59 · inventario de campos', () => {
  test('@smoke los campos del kit y createStepForm se marcan solos; nunca llevan el valor', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(() => {
      const K = (window as any).ikisaiKit;
      const attrs = (n: Element | null) => Object.fromEntries([...(n?.attributes ?? [])].filter((a) => /^data-(field|feedback)-/.test(a.name)).map((a) => [a.name, a.value]));
      const date = K.createDateField({ label: 'Entrada', name: 'start', value: '2026-11-02', required: true, field: { id: 'booking.reserva.entrada', entity: 'booking.reservations', prop: 'check_in', sensitivity: 'internal', permission: 'booking.edit' } });
      const qty = K.createQuantityField({ label: 'Personas', name: 'people', value: 12, field: { id: 'booking.reserva.personas', required: 'si la reserva es de grupo' } });
      const plain = K.createDateField({ label: 'Sin marcar', name: 'x' });
      const form = K.createStepForm({
        label: 'Tus datos', feedbackId: 'guests.registro',
        questions: [
          { id: 'fullName', question: '¿Cómo te llamas?', kind: 'text', field: { entity: 'guests.travelers', prop: 'full_name', sensitivity: 'personal', required: true } },
          { id: 'diet', question: '¿Alguna dieta?', kind: 'choice', options: [{ value: 'no', label: 'No' }] },
        ],
        onAnswer: () => undefined,
      });
      document.body.append(date.element, qty.element, plain.element, form.element);
      const loose = K.el('input', { type: 'text', ...K.fieldAttrs({ id: 'tasks.ficha.titulo', entity: 'tasks.tasks', prop: 'title' }), 'data-feedback-id': 'tasks.ficha.titulo_campo' });
      const marked = K.markField(K.el('textarea', { 'data-feedback-id': 'tasks.ficha.nota' }), { id: 'tasks.ficha.notas', sensitivity: 'secreto' });
      return {
        date: attrs(date.input), qty: attrs(qty.input), plain: attrs(plain.input),
        step: attrs(form.element.querySelector('.ask-input')), loose: attrs(loose), marked: attrs(marked),
        anyValue: [...document.querySelectorAll('[data-field-id]')].some((n) => [...n.attributes].some((a) => a.name.startsWith('data-field-') && /2026-11-02|12/.test(a.value))),
      };
    });
    expect(out.date).toEqual({
      'data-field-id': 'booking.reserva.entrada', 'data-field-type': 'date', 'data-field-entity': 'booking.reservations', 'data-field-prop': 'check_in',
      'data-field-required': 'always', 'data-field-permission': 'booking.edit', 'data-field-sensitivity': 'internal',
      'data-feedback-id': 'booking.reserva.entrada', 'data-feedback-label': 'Entrada',
    });
    expect(out.qty).toMatchObject({ 'data-field-type': 'number', 'data-field-required': 'si la reserva es de grupo' });
    expect(out.plain).toEqual({});
    expect(out.step).toMatchObject({ 'data-field-id': 'guests.registro.full_name', 'data-field-type': 'text', 'data-field-prop': 'full_name', 'data-field-sensitivity': 'personal', 'data-field-required': 'always', 'data-feedback-label': '¿Cómo te llamas?' });
    // El `data-feedback-id` propio gana; markField no lo pisa y descarta una sensibilidad desconocida.
    expect(out.loose).toMatchObject({ 'data-field-id': 'tasks.ficha.titulo', 'data-feedback-id': 'tasks.ficha.titulo_campo' });
    expect(out.marked).toEqual({ 'data-field-id': 'tasks.ficha.notas', 'data-feedback-id': 'tasks.ficha.nota' });
    expect(out.anyValue).toBe(false);
  });

  test('catálogo: fields declarados (atributos, fieldAttrs, markField, campos del kit y createStepForm)', () => {
    const { fields, dynamic } = extractFields([
      '<input type="email" data-field-id="central.persona.email" data-field-entity="core.people" data-field-prop="email" data-field-sensitivity="personal" data-field-required="always" data-feedback-label="Correo">',
      "const t = el('input', { type: 'text', ...fieldAttrs({ id: 'tasks.ficha.titulo', entity: 'tasks.tasks', prop: 'title', required: true, since: '0.40.0' }) });",
      "markField(el('select', { name: 'kind' }), { id: 'booking.reserva.tipo', type: 'select', permission: 'booking.edit' });",
      "const d = createDateField({ label: 'Entrada', name: 'start', required: true, field: { id: 'booking.reserva.entrada', entity: 'booking.reservations', prop: 'check_in' } });",
      "const f = createStepForm({ label: 'Datos', feedbackId: 'guests.registro', questions: [",
      "  { id: 'checkIn', question: '¿Cuándo llegas?', kind: 'text', inputType: 'date', field: { entity: 'guests.stays', prop: 'check_in', required: true } },",
      "  { id: 'diet', question: '¿Dieta?', kind: 'multi', options: [] },",
      "], onAnswer });",
      "const x = { field: { id: 'no.es.un.campo' } };",
      "el('input', { ...fieldAttrs({ id: `tasks.${k}` }) });",
    ].join('\n'), 'apps/booking/src/ui/form.ts');
    const byId = Object.fromEntries(fields.map((f: { fieldId: string }) => [f.fieldId, f]));
    expect(byId['central.persona.email']).toMatchObject({ app: 'booking', screen: 'persona', type: 'email', entity: 'core.people', prop: 'email', sensitivity: 'personal', required: 'always', label: 'Correo', source: 'attr', line: 1 });
    expect(byId['tasks.ficha.titulo']).toMatchObject({ type: 'text', entity: 'tasks.tasks', required: 'always', since: '0.40.0', anchorId: 'tasks.ficha.titulo' });
    expect(byId['booking.reserva.tipo']).toMatchObject({ type: 'select', permission: 'booking.edit' });
    expect(byId['booking.reserva.entrada']).toMatchObject({ type: 'date', required: 'always', label: 'Entrada', prop: 'check_in', source: 'kit' });
    expect(byId['guests.registro.check_in']).toMatchObject({ type: 'date', entity: 'guests.stays', required: 'always', label: '¿Cuándo llegas?', source: 'kit', line: 6 });
    expect(byId['guests.registro.diet']).toMatchObject({ type: 'multi', entity: null, sensitivity: null });
    expect(byId['no.es.un.campo']).toBeUndefined();
    expect(fields).toHaveLength(6);
    expect(dynamic.map((d: { line: number }) => d.line)).toEqual([10]);
  });

  test('catálogo: sin instrumentar, con su ancla si la tiene; fuera hidden, submit y lo que ya se declara', () => {
    const { uninstrumented } = extractFields([
      "el('input', { type: 'search', 'aria-label': 'Buscar cuenta', 'data-feedback-id': 'central.accesos.buscar' });",
      "el('input', { type: 'hidden', name: 'id' });",
      '<select name="kind"></select> <input type="submit"> <textarea placeholder="Notas"></textarea>',
      "createQuantityField({ label: 'Cantidad', name: 'qty' });",
      "createLevelStar({ levels: 3, labels: [], readonly: true });",
      "createStepForm({ label: 'Sin base', questions: [{ id: 'a', question: '¿A?', kind: 'choice' }], onAnswer });",
      "el('input', { ...fieldAttrs({ id: 'tasks.ficha.titulo' }) });",
    ].join('\n'), 'apps/central/src/ui/x.ts');
    expect(uninstrumented.map((u: { tag: string; type: string; label: string | null; anchorId: string | null; screen: string | null; line: number }) => [u.line, u.tag, u.type, u.label, u.anchorId, u.screen])).toEqual([
      [1, 'input', 'search', 'Buscar cuenta', 'central.accesos.buscar', 'accesos'],
      [3, 'select', 'select', 'kind', null, null],
      [3, 'textarea', 'text', 'Notas', null, null],
      [4, 'createQuantityField', 'number', 'Cantidad', null, null],
      [6, 'createStepForm', 'select', '¿A?', null, null],
    ]);
    expect(uninstrumented.every((u: { app: string }) => u.app === 'central')).toBe(true);
  });

  test('generateCatalog: fields y fieldsUninstrumented en el JSON, el ancla como función `field`, e informe por app', () => {
    const root = mkdtempSync(join(tmpdir(), 'kit-fields-'));
    mkdirSync(join(root, 'apps', 'booking', 'src'), { recursive: true });
    writeFileSync(join(root, 'apps', 'booking', 'src', 'form.ts'), [
      "createDateField({ label: 'Entrada', name: 'start', field: { id: 'booking.reserva.entrada', sensitivity: 'internal' } });",
      "el('input', { type: 'text', name: 'note' });",
    ].join('\n'));
    const { catalog } = generateCatalog({ app: 'booking', root, release: 'v1', commit: 'abc' });
    const written = JSON.parse(readFileSync(join(root, 'apps', 'booking', 'dist', 'feature-catalog.json'), 'utf8'));
    expect(written.fields).toEqual([expect.objectContaining({ fieldId: 'booking.reserva.entrada', app: 'booking', screen: 'reserva', type: 'date', sensitivity: 'internal', file: 'apps/booking/src/form.ts', line: 1 })]);
    expect(written.fieldsUninstrumented).toEqual([expect.objectContaining({ tag: 'input', type: 'text', label: 'note', line: 2 })]);
    expect(written.features).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'booking.reserva.entrada', kind: 'field', label: 'Entrada' })]));
    expect(JSON.stringify(written)).not.toMatch(/"value"/);
    const md = fieldReport([catalog]);
    expect(written.dynamic).toEqual([]);
    expect(written.fieldsDynamic).toEqual([]);
    expect(md).toContain('| booking | 1 | 1 | 0 | 1 | 0 |');
    expect(md).toContain('- `apps/booking/src/form.ts:2` · input (text) · «note»');
  });
});
