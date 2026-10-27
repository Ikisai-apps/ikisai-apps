import { expect, test } from 'playwright/test';
import { coverageFromCore } from '../src/pieces/coverage.ts';
// @ts-expect-error: script de Node sin tipos.
import { extractFeatures } from '../scripts/feature-catalog.mjs';

/** Revisor › cobertura por candidatos (decisión de VG, 27-10): no se decide campo a campo, sino por app → pantalla. */
test.describe('ui-kit · renderCoverage por candidatos', () => {
  test('del núcleo: candidate, estimate y activations30d; el catálogo da «decidir», «deshacer» y «utilidad» solo con sus opciones', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    const out = coverageFromCore({ fields: [
      { fieldId: 'tasks.ficha.nota', app: 'tasks', screen: 'ficha', screenLabel: 'Ficha de la tarea', candidate: true, estimate: { frequency: 'diaria', audience: 'Equipo' }, activations30d: 57 },
      { fieldId: 'tasks.ficha.cuna', app: 'tasks', screen: 'ficha', activations30d: 0 },
      { fieldId: 'tasks.ficha.otra', app: 'tasks', screen: 'ficha' },
    ] });
    expect(out.fields.map((f) => [f.candidate, f.screenLabel, f.estimate?.frequency ?? null])).toEqual([[true, 'Ficha de la tarea', 'diaria'], [false, null, null], [false, null, null]]);
    expect(out.usage).toEqual([{ fieldId: 'tasks.ficha.nota', activations: 57 }, { fieldId: 'tasks.ficha.cuna', activations: 0 }]);
    const ids = (code: string) => extractFeatures(code).features.map((x: { id: string }) => x.id.split('.').pop());
    expect(ids("renderCoverage({ fields, links, onDecide, onDeclare, feedbackId: 'central.revisor.cobertura' })")).toEqual(expect.arrayContaining(['decidir', 'deshacer', 'utilidad']));
    expect(ids("renderCoverage({ fields, links, feedbackId: 'central.revisor.cobertura' })")).not.toContain('decidir');
  });

  test('@smoke en la muestra: candidatos por app y pantalla, decisión por grupo con deshacer, retirar con segundo toque y «Ver todo»', async ({ page }, info) => {
    await page.goto('/');
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    const host = page.locator('#coverageHost');
    const out = page.locator('#coverageOut');
    await host.scrollIntoViewIfNeeded();
    await expect(host.locator('.cov-lead')).toHaveText('3 campos candidatos en 3 apps');
    await expect(host.locator('.cov-filter')).toHaveCount(0);
    await expect(host.locator('.cov-cand')).toHaveCount(3);
    // Etiqueta de persona para la pantalla; recuento y usos del grupo; utilidad heredada por campo.
    await expect(host.locator('.cov-app[data-app="Guests"] .cov-screen')).toHaveText('Mis datos de estancia');
    const tasks = host.locator('.cov-app[data-app="Tasks"] .cov-cand');
    await expect(tasks.locator('.cov-meta')).toHaveText('1 campo · 57 usos en 30 días');
    await expect(host.locator('.cov-app[data-app="Food"] .cov-meta')).toHaveText('1 campo · Sin datos de uso');
    await tasks.locator('.cov-fields > summary').click();
    await expect(tasks.locator('.cov-row')).toContainText('Utilidad heredada: diaria · Equipo');
    // Dejar → decidido, con «Deshacer» enfocado; deshacer lo devuelve.
    await tasks.getByRole('button', { name: 'Dejar' }).click();
    await expect(tasks.locator('.cov-decision')).toHaveText('Decidido: Dejar');
    await expect(out).toHaveText('keep:Tasks·Ficha:1');
    await expect(tasks.locator('.cov-undo')).toBeFocused();
    await tasks.locator('.cov-undo').click();
    await expect(out).toHaveText('deshacer:Tasks·Ficha:1');
    await expect(tasks.locator('.cov-act')).toHaveCount(3);
    // Retirar pide un segundo toque.
    const food = host.locator('.cov-app[data-app="Food"] .cov-cand');
    await food.locator('.cov-act[data-decision="retire"]').click();
    await expect(food.locator('.cov-act[data-decision="retire"]')).toHaveText('Confirmar: retirar 1');
    await expect(out).toHaveText('deshacer:Tasks·Ficha:1');
    await food.locator('.cov-act[data-decision="retire"]').click();
    await expect(food.locator('.cov-decision')).toHaveText('Decidido: Retirar');
    await expect(out).toHaveText('retire:Food·Receta:1');
    // Excepción de utilidad por pantalla: la hoja la abre Central.
    await host.locator('.cov-app[data-app="Guests"] .cov-declare').click();
    await expect(out).toHaveText('utilidad:Guests·Mis datos');
    if (info.project.name === 'movil') expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // «Ver todo» y vuelta.
    await host.locator('.cov-viewall').click();
    await expect(host.locator('.cov-filter').first()).toContainText('Todas 5');
    await expect(host.locator('.cov-viewcand')).toBeFocused();
    await host.locator('.cov-viewcand').click();
    await expect(host.locator('.cov-cand')).toHaveCount(3);
    await expect(food.locator('.cov-decision')).toHaveText('Decidido: Retirar');
  });
});
