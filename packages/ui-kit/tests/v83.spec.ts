import { expect, test } from 'playwright/test';
import { classifyCoverage, coverageFromCore } from '../src/pieces/coverage.ts';
// @ts-expect-error: script de Node sin tipos.
import { extractFeatures } from '../scripts/feature-catalog.mjs';

/** Revisor › cobertura de campos por flujos (encargo de Core, 27-10; COBERTURA_INPUTS_FLUJOS.md). Solo metadatos, nunca valores. */
const f = (fieldId: string, extra: object = {}) => ({ fieldId, app: 'Booking', screen: 'Ficha', ...extra });

test.describe('ui-kit v0.69.11 · renderCoverage', () => {
  test('clasifica: directo antes que indirecto y automático; sin vínculos, independiente si se usa y «sin datos» si no', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    const rows = classifyCoverage(
      [f('b.f.llegada', { entity: 'booking.stays', prop: 'arrival_time' }), f('b.f.hora', { entity: 'booking.stays', prop: 'arrival_time' }), f('b.f.nota'), f('b.f.matricula', { required: 'always', critical: true }), f('b.f.cuna')],
      [{ fieldId: 'b.f.llegada', via: 'direct', flows: [{ id: 'f1', name: 'Alojar' }] }, { fieldId: 'b.f.llegada', via: 'indirect', flows: [{ id: 'f2', name: 'Compra' }, { id: 'f1', name: 'Alojar' }] }, { fieldId: 'b.f.hora', via: 'automatic', flows: [{ id: 'f3', name: 'Avisos' }] }],
      [{ fieldId: 'b.f.nota', activations: 12 }, { fieldId: 'b.f.cuna', activations: 0 }],
    );
    expect(rows.map((r) => [r.cls, r.flows.length, r.noFlow, r.duplicate, r.criticalRequired])).toEqual([
      ['direct', 2, false, true, false],
      ['automatic', 1, false, true, false],
      ['independent', 0, true, false, false],
      ['unknown', 0, true, false, true],
      ['unknown', 0, true, false, false],
    ]);
    // Catálogo: «abrir» solo si la llamada tiene onOpen.
    const ids = (code: string) => extractFeatures(code).features.map((x: { id: string }) => x.id.split('.').pop());
    expect(ids("renderCoverage({ fields, links, feedbackId: 'central.revisor.cobertura' })")).toEqual(['cobertura', 'ver-todo', 'ver-candidatos', 'filtro', 'agrupar']);
    expect(ids("renderCoverage({ fields, links, onOpen, feedbackId: 'central.revisor.cobertura' })")).toContain('abrir');
  });

  test('del núcleo (core.field_coverage, 0111) y los pasos de Flow: directo por anclaje, automático por regla, clase parcial sin pasos', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    const core = { fields: [
      { fieldId: 'booking.reserva.notas', app: 'booking', entity: 'booking.reservations', prop: 'notes', capabilities: [{ id: 'booking.test_notes', how: 'writes' as const }], used: true, duplicates: [], class: 'indirect' as const },
      { fieldId: 'booking.ficha.llegada', app: 'booking', entity: 'booking.stays', prop: 'arrival_time', capabilities: [], used: true, duplicates: ['guests.datos.llegada'], class: 'independent' as const },
      { fieldId: 'booking.ficha.cuna', app: 'booking', capabilities: [], used: false, duplicates: [], class: 'unknown' as const },
    ] };
    const steps = [{ flowId: 'alojar', flowName: 'Alojar a alguien', kind: 'step' as const, anchor: 'booking.ficha.llegada' }, { flowId: 'notas', flowName: 'Notas', kind: 'rule' as const, capability: 'booking.test_notes' }];
    const { fields, links } = coverageFromCore(core, steps, { 'booking.ficha.llegada': { critical: true, required: 'always' } });
    expect(classifyCoverage(fields, links).map((r) => [r.cls, r.flows.map((f) => f.name), r.noFlow, r.duplicateOf, r.criticalRequired])).toEqual([
      ['automatic', ['Notas'], false, [], false],
      ['direct', ['Alojar a alguien'], false, ['guests.datos.llegada'], true],
      ['unknown', [], true, [], false],
    ]);
    // Sin pasos de Flow: la clase parcial del núcleo, y todos sin cobertura de Flow.
    const bare = coverageFromCore(core);
    expect(classifyCoverage(bare.fields, bare.links).map((r) => [r.cls, r.noFlow])).toEqual([['indirect', true], ['independent', true], ['unknown', true]]);
  });

  test('@smoke en la muestra: recuentos por clase, filtro, agrupar por app, marcas y «abrir»', async ({ page }) => {
    await page.goto('/');
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    const host = page.locator('#coverageHost');
    await host.scrollIntoViewIfNeeded();
    // Se abre en los candidatos (decisión de VG, 27-10); el detalle está en «Ver todo».
    await host.locator('.cov-viewall').click();
    await expect(host.locator('.cov-filter').first()).toContainText('Todas 5');
    await expect(host.locator('.cov-filter[data-cls="direct"]')).toContainText('2');
    await expect(host.locator('.cov-filter[data-cls="automatic"]')).toBeDisabled();
    // Hora de llegada: obligatoria en un proceso crítico y duplicada (mismo booking.stays.arrival_time que en Guests).
    const llegada = host.locator('.cov-row[data-field="booking.ficha.llegada"]');
    await expect(llegada.locator('[data-flag="critico"]')).toBeVisible();
    await expect(llegada.locator('[data-flag="duplicado"]')).toContainText('booking.stays.arrival_time');
    await expect(llegada).toContainText('214 usos en 30 días');
    await expect(host.locator('.cov-row[data-field="guests.datos.llegada"] [data-flag="comun"]')).toBeVisible();
    await expect(host.locator('.cov-row[data-field="tasks.ficha.nota"] [data-flag="sin-flow"]')).toBeVisible();
    // «Sin datos suficientes» no es «sin cobertura»: no lleva esa marca.
    await expect(host.locator('.cov-row[data-field="food.receta.tiempo"] [data-flag="sin-flow"]')).toHaveCount(0);
    await host.locator('.cov-filter[data-cls="independent"]').click();
    await expect(host.locator('.cov-row')).toHaveCount(1);
    await host.locator('.cov-filter[data-cls="independent"]').click();
    await host.locator('.cov-group [data-group="app"]').click();
    await expect(host.locator('.cov-groupbox')).toHaveCount(5);
    await llegada.locator('.cov-title').click();
    await expect(page.locator('#coverageOut')).toHaveText('booking.ficha.llegada');
  });
});
