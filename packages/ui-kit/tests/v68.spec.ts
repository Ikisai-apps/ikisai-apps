import { expect, test, type Page } from 'playwright/test';
import { freeFormProblems } from '../src/pieces/free-form.ts';
import { checklistSummary } from '../src/pieces/checklist.ts';
// @ts-expect-error: script de Node sin tipos.
import { extractFeatures } from '../scripts/feature-catalog.mjs';

/** Encargo de Core (27-10) para el catálogo de piezas de Flow: formulario libre y lista de comprobación. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAr7ZmrEAAAAASUVORK5CYII=', 'base64');

test.describe('ui-kit v0.64 · formulario libre y lista de comprobación', () => {
  test('esquema y resumen: problemas del esquema, hechas y obligatorias; catálogo', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    expect(freeFormProblems({ questions: [] })).toEqual(['sin preguntas']);
    expect(freeFormProblems({ questions: [{ id: 'a', label: 'A', kind: 'text' }, { id: 'a', label: 'B', kind: 'choice' }, { id: 'Mal', label: 'C', kind: 'text' }] }))
      .toEqual(['id repetido: a', 'a: sin opciones', 'id no válido: Mal']);
    const items = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C', required: false }];
    expect(checklistSummary(items, { c: { by: 'Ana', at: '' } })).toEqual({ done: 1, total: 3, requiredDone: 0, requiredTotal: 2, complete: false });
    expect(checklistSummary(items, { a: { by: 'Ana', at: '' }, b: { by: 'Luis', at: '' } }).complete).toBe(true);
    const ids = (code: string) => extractFeatures(code).features.map((f: { id: string }) => f.id.split('.').slice(3).join('.') || 'raíz');
    expect(ids("createFreeForm({ schema, onSubmit, feedbackId: 'flow.piscina.revision' })")).toEqual(['raíz', 'preguntas', 'foto', 'cambiar', 'registrar', 'nuevo']);
    expect(ids("createChecklist({ items, who, onToggle, feedbackId: 'flow.apertura.lista' })")).toEqual(['raíz', 'item']);
    // «Saltar» solo se cataloga si alguna pregunta lo lleva.
    expect(ids("createStepForm({ questions: [], onAnswer, feedbackId: 'guests.datos.preguntas' })")).not.toContain('saltar');
    expect(ids("createStepForm({ questions: [{ id: 'x', skip: true }], onAnswer, feedbackId: 'guests.datos.preguntas' })")).toContain('saltar');
  });

  async function setupForm(page: Page, opts: { failPhoto?: boolean; failSubmit?: boolean; value?: Record<string, unknown> } = {}): Promise<void> {
    await page.goto('/');
    await page.evaluate((opts) => {
      const K = (window as any).ikisaiKit;
      const w = window as any;
      w.sent = []; w.photos = [];
      w.form = K.createFreeForm({
        label: 'Revisión de la piscina', feedbackId: 'flow.piscina.revision', value: opts.value,
        schema: { version: 1, questions: [
          { id: 'cloro', label: '¿Cuánto cloro marca?', kind: 'number', unit: 'ppm', min: 0, max: 10, required: true },
          { id: 'limpia', label: '¿Está limpia el agua?', kind: 'yesno', required: true },
          { id: 'estado', label: '¿Cómo está la depuradora?', kind: 'choice', required: true, options: [{ value: 'bien', label: 'Bien' }, { value: 'ruido', label: 'Hace ruido' }] },
          { id: 'foto', label: 'Foto del agua', kind: 'photo' },
          { id: 'nota', label: '¿Algo más?', kind: 'text', multiline: true },
        ] },
        onPhoto: async (blob: Blob, name: string) => { if (opts.failPhoto) throw new Error('x'); w.photos.push(name); return `ref-${w.photos.length}`; },
        onSubmit: async (a: unknown) => { if (opts.failSubmit && !w.failed) { w.failed = true; throw new Error('500'); } w.sent.push(a); },
      });
      document.body.replaceChildren(K.el('div', { style: 'padding:16px' }, w.form.element));
    }, opts);
  }
  const question = (page: Page) => page.locator('.ask-question');

  test('@smoke pregunta a pregunta: número con coma y límites, sí/no, opción, foto, texto; revisión, «Cambiar» y «Registrar»', async ({ page }) => {
    await setupForm(page);
    await expect(page.locator('.ask-meta')).toHaveText('Pregunta 1 de 5');
    await expect(question(page)).toHaveText('¿Cuánto cloro marca?');
    const input = page.locator('.ask-input');
    expect(await input.getAttribute('inputmode')).toBe('decimal');
    expect(await input.getAttribute('data-field-id')).toBe('flow.piscina.revision.preguntas.cloro');
    await input.press('Enter');
    await expect(page.locator('.ask-error')).toHaveText('Esta pregunta es obligatoria.');
    await input.fill('mucho');
    await input.press('Enter');
    await expect(page.locator('.ask-error')).toHaveText('Escribe un número.');
    await input.fill('12');
    await input.press('Enter');
    await expect(page.locator('.ask-error')).toHaveText('Tiene que ser 10 o menos.');
    await input.fill('1,5');
    await input.press('Enter');
    await expect(question(page)).toHaveText('¿Está limpia el agua?');
    // Obligatoria: sin «Saltar».
    await expect(page.locator('.ask-skip')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sí' }).click();
    await expect(question(page)).toHaveText('¿Cómo está la depuradora?');
    await page.getByRole('button', { name: 'Hace ruido' }).click();
    await expect(question(page)).toHaveText('Foto del agua');
    await expect(page.locator('.ask-hint')).toHaveText('Opcional');
    await page.locator('.fform-photofield input[type=file]').setInputFiles({ name: 'agua.png', mimeType: 'image/png', buffer: PNG });
    await expect(question(page)).toHaveText('¿Algo más?');
    await page.locator('textarea.ask-input').fill('Hojas en el skimmer');
    await page.getByRole('button', { name: 'Aceptar' }).click();
    // Revisión.
    await expect(page.locator('.fform-title')).toBeFocused();
    const answers = page.locator('.fform-answer');
    await expect(answers).toHaveText(['1,5 ppm', 'Sí', 'Hace ruido', 'Foto añadida', 'Hojas en el skimmer']);
    await expect(page.locator('.fform-thumb')).toHaveCount(1);
    await page.getByRole('button', { name: 'Cambiar «¿Cuánto cloro marca?»' }).click();
    await expect(page.locator('.ask-meta')).toHaveText('Pregunta 1 de 1');
    await expect(page.locator('.ask-input')).toHaveValue('1,5');
    await page.locator('.ask-input').fill('2');
    await page.locator('.ask-input').press('Enter');
    await expect(answers.first()).toHaveText('2 ppm');
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.locator('.ask-donetitle')).toContainText('Registrado');
    expect(await page.evaluate(() => (window as any).sent)).toEqual([{ cloro: 2, limpia: true, estado: 'ruido', foto: 'ref-1', nota: 'Hojas en el skimmer' }]);
    await page.getByRole('button', { name: 'Nuevo registro' }).click();
    await expect(page.locator('.ask-meta')).toHaveText('Pregunta 1 de 5');
  });

  test('opcionales con «Saltar» (null), borrador que no se repregunta y foto que no sube', async ({ page }) => {
    await setupForm(page, { value: { cloro: 1, limpia: false, estado: 'bien' }, failPhoto: true, failSubmit: true });
    await expect(page.locator('.ask-meta')).toHaveText('Pregunta 1 de 2');
    await page.locator('.fform-photofield input[type=file]').setInputFiles({ name: 'agua.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.locator('.fform-photostatus')).toHaveText('No se pudo subir la foto. Prueba otra vez.');
    await expect(question(page)).toHaveText('Foto del agua');
    await page.getByRole('button', { name: 'Saltar' }).click();
    await page.getByRole('button', { name: 'Saltar' }).click();
    await expect(page.locator('.fform-answer')).toHaveText(['1 ppm', 'No', 'Bien', 'Sin respuesta', 'Sin respuesta']);
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.locator('.fform-error')).toHaveText('No se pudo registrar. Prueba otra vez.');
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.locator('.ask-donetitle')).toContainText('Registrado');
    expect(await page.evaluate(() => (window as any).sent)).toEqual([{ cloro: 1, limpia: false, estado: 'bien', foto: null, nota: null }]);
  });

  async function setupList(page: Page, opts: { fail?: string } = {}): Promise<void> {
    await page.goto('/');
    await page.evaluate((opts) => {
      const K = (window as any).ikisaiKit;
      const w = window as any;
      w.toggles = []; w.completed = 0;
      w.list = K.createChecklist({
        label: 'Apertura', feedbackId: 'flow.apertura.lista', who: () => 'Ana', now: () => new Date(2026, 9, 27, 10, 42),
        items: [{ id: 'luces', text: 'Encender las luces' }, { id: 'agua', text: 'Abrir el agua', hint: 'En el cuarto de calderas' }, { id: 'flores', text: 'Flores', required: false }],
        checked: { luces: { by: 'Luis', at: new Date(2026, 9, 26, 8, 5).toISOString() } },
        onToggle: async (id: string, on: boolean, mark: { by: string } | null) => { if (id === opts.fail) throw new Error('500'); w.toggles.push(`${id}:${on}:${mark?.by ?? '-'}`); },
        onComplete: () => { w.completed += 1; },
      });
      document.body.replaceChildren(K.el('div', { style: 'padding:16px' }, w.list.element));
    }, opts);
  }

  test('@smoke lista: resumen, marcar con quién y cuándo, desmarcar y completar las obligatorias', async ({ page }) => {
    await setupList(page);
    const summary = page.locator('.clist-summary');
    await expect(summary).toHaveText('1 de 3 hechas · falta 1 obligatoria');
    await expect(page.locator('.clist-item[data-item="luces"] .clist-who')).toHaveText('Hecho por Luis · 26 oct, 08:05');
    await expect(page.locator('.clist-tag')).toHaveText(['Obligatoria', 'Obligatoria', 'Opcional']);
    await page.getByLabel('Flores').check();
    await expect(summary).toHaveText('2 de 3 hechas · falta 1 obligatoria');
    await expect(page.locator('.clist-item[data-item="flores"] .clist-who')).toHaveText('Hecho por Ana · 10:42');
    await expect(page.getByLabel('Flores')).toBeFocused();
    await page.getByLabel(/Abrir el agua/).press('Space');
    await expect(summary).toHaveText('3 de 3 hechas · todas las obligatorias hechas');
    expect(await page.evaluate(() => (window as any).completed)).toBe(1);
    await page.getByLabel('Encender las luces').uncheck();
    await expect(summary).toHaveText('2 de 3 hechas · falta 1 obligatoria');
    expect(await page.evaluate(() => (window as any).toggles)).toEqual(['flores:true:Ana', 'agua:true:Ana', 'luces:false:-']);
    expect(await page.evaluate(() => (window as any).list.summary())).toEqual({ done: 2, total: 3, requiredDone: 1, requiredTotal: 2, complete: false });
    const bar = page.locator('.clist-bar');
    expect(await bar.getAttribute('aria-valuenow')).toBe('2');
  });

  test('lista: si no se guarda, la marca vuelve atrás', async ({ page }) => {
    await setupList(page, { fail: 'agua' });
    await page.getByLabel(/Abrir el agua/).click();
    await expect(page.getByLabel(/Abrir el agua/)).not.toBeChecked();
    await expect(page.locator('.clist-summary')).toHaveText('1 de 3 hechas · falta 1 obligatoria');
    await expect(page.locator('.clist-error')).toHaveText('No se guardó «Abrir el agua». Prueba otra vez.');
    await expect(page.locator('.clist-foot')).not.toContainText('Hay cambios sin guardar');
    expect(await page.evaluate(() => (window as any).completed)).toBe(0);
  });
});
