import { expect, test } from 'playwright/test';
// @ts-expect-error: script de Node sin tipos.
import { extractFeatures } from '../scripts/feature-catalog.mjs';

/**
 * Guiado mínimo en las apps (27-10): lo que rompía las pruebas de ids de Guests, Central y Food se arregla en el kit.
 * - El id recomendado del aviso es `<app>.cabecera.guia` (raíz de la cáscara que todas reconocen).
 * - El catálogo recoge el aviso y sus botones, y una comparación (`dataset.feedbackId === id`) no es un id dinámico.
 * - `revealAnchor` abre solo los `<details>` cerrados y pasa el nodo a la app, que no tiene que buscarlo por id.
 */
test.describe('ui-kit v0.69.3 · Guiado mínimo sin ids sueltos en las apps', () => {
  test('catálogo: el aviso del Guiado y sus botones; las comparaciones no son ids', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    const shell = extractFeatures("createAppShell(root, { appName: 'Central', returnTo: { feedbackId: 'central.cabecera.volver' }, guide: { feedbackId: 'central.cabecera.guia' } });");
    expect(shell.features.map((f: { id: string; label: string | null }) => [f.id, f.label])).toEqual([
      ['central.cabecera.volver', null],
      ['central.cabecera.guia', 'Paso del recorrido'], ['central.cabecera.guia.ver', 'Ver el campo'], ['central.cabecera.guia.cerrar', 'Cerrar el aviso'],
    ]);
    expect(shell.dynamic).toEqual([]);
    const compare = extractFeatures("registerReveal('central', (id, node) => { const n = [...main.querySelectorAll('[data-feedback-id]')].find((x) => x.dataset.feedbackId === id); if (n?.dataset.feedbackId !== id) return; });");
    expect(compare.dynamic).toEqual([]);
    expect(compare.features).toEqual([]);
  });

  test('revealAnchor abre los <details> cerrados solo y pasa el nodo escondido a la app', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async () => {
      const K = (window as any).ikisaiKit;
      const host = K.el('div', null,
        K.el('details', { id: 'fold' }, K.el('summary', null, 'Más'), K.el('details', { id: 'inner' }, K.el('summary', null, 'Aún más'),
          K.el('input', { 'aria-label': 'Hora', ...K.fieldAttrs({ id: 'demo.prueba.hora' }) }))),
        K.el('div', { id: 'sheet', hidden: true }, K.el('input', { 'aria-label': 'Nota', ...K.fieldAttrs({ id: 'demo.hoja.nota' }) })));
      document.body.append(host);
      const seen: string[] = [];
      const off = K.registerReveal('demo.hoja', (id: string, node: HTMLElement | null) => { seen.push(`${id}:${node?.getAttribute('aria-label') ?? '-'}`); node?.closest<HTMLElement>('#sheet')?.removeAttribute('hidden'); });
      const a = await K.revealAnchor('demo.prueba.hora', { timeoutMs: 1000 });
      const b = await K.revealAnchor('demo.hoja.nota', { timeoutMs: 1000 });
      off();
      return { a: a?.getAttribute('aria-label') ?? null, b: b?.getAttribute('aria-label') ?? null, open: [(document.getElementById('fold') as HTMLDetailsElement).open, (document.getElementById('inner') as HTMLDetailsElement).open], seen };
    });
    expect(out).toEqual({ a: 'Hora', b: 'Nota', open: [true, true], seen: ['demo.hoja.nota:Nota'] });
  });
});
