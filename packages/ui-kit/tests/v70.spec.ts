import { expect, test, type Page } from 'playwright/test';
import { withGuideLink } from '../src/guide/link.ts';
// @ts-expect-error: script de Node sin tipos.
import { extractFields } from '../scripts/feature-catalog.mjs';

/** Guiado, tanda 1 (decisión de VG del 27-10, `MUELA/equipo/feedback/flow/GUIADO.md`): anclajes semánticos y campo señalado. */
const mountShell = (page: Page) => page.evaluate(() => {
  const root = document.createElement('div');
  root.id = 'guideShell';
  document.body.prepend(root);
  (window as any).ikisaiKit.createAppShell(root, { appName: 'Booking', nav: [{ hash: '#/', label: 'Inicio', icon: 'home' }], navigate: (h: string) => { location.hash = h; }, guide: { feedbackId: 'booking.guia.aviso' } });
});

test.describe('ui-kit v0.66 · Guiado: anclajes y campo señalado', () => {
  test('enlace y catálogo: campo, paso y guía en el enlace; confirm y validator solo si se declaran', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    expect(withGuideLink('https://booking.ikisai.com/#/reservas/123', { field: 'booking.ficha.llegada', step: 'Pon la hora', run: 'ej_42', from: 'flow', title: 'Flow', url: 'https://flow.ikisai.com/#/r' }))
      .toBe('https://booking.ikisai.com/#/reservas/123?desde=flow&volver=https%3A%2F%2Fflow.ikisai.com%2F%23%2Fr&titulo=Flow&campo=booking.ficha.llegada&paso=Pon+la+hora&guia=ej_42');
    // Un campo mal formado o una ejecución rara no pasan.
    expect(withGuideLink('https://x.ikisai.com/', { field: 'div > input', run: '../x', from: 'flow', url: 'https://flow.ikisai.com/' })).not.toMatch(/campo=|guia=/);
    const { fields } = extractFields([
      "el('input', { ...fieldAttrs({ id: 'booking.ficha.llegada', entity: 'booking.stays', prop: 'arrival_time', confirm: 'save', validator: 'hora' }) });",
      "el('input', { ...fieldAttrs({ id: 'booking.ficha.nota' }) });",
      '<input data-field-id="booking.ficha.matricula" data-field-confirm="event">',
    ].join('\n'), 'apps/booking/src/x.ts');
    const by = Object.fromEntries(fields.map((f: { fieldId: string }) => [f.fieldId, f]));
    expect(by['booking.ficha.llegada']).toMatchObject({ confirm: 'save', validator: 'hora' });
    expect(by['booking.ficha.matricula']).toMatchObject({ confirm: 'event' });
    expect('confirm' in by['booking.ficha.nota']).toBe(false);
  });

  test('@smoke al llegar con ?campo=…&paso=…: la línea del paso, el campo con el foco y resaltado, la URL limpia y «Volver a Flow»', async ({ page }) => {
    const volver = encodeURIComponent('/?vuelta=1#/recepcion');
    await page.goto(`/#/?desde=flow&volver=${volver}&titulo=Flow&campo=demo.guia.llegada&paso=${encodeURIComponent('Pon la hora a la que llega')}`);
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    await mountShell(page);
    const callout = page.locator('#guideShell .guia-callout');
    await expect(callout.locator('.guia-text')).toHaveText('Pon la hora a la que llega');
    await expect(callout).toHaveAttribute('data-feedback-id', 'booking.guia.aviso');
    await expect(page.locator('#guideArrival')).toBeFocused();
    await expect(page.locator('#guideArrival')).toHaveClass(/guia-pulse/);
    await expect(callout).toHaveAttribute('data-found', 'true');
    await expect(page.locator('#guideShell .return-link')).toHaveText('Volver a Flow');
    expect(new URL(page.url()).hash).toBe('#/?desde=flow');
    // Recargar no repite el salto, pero el aviso sigue en la pestaña hasta cerrarlo.
    expect(await page.evaluate(() => (window as any).ikisaiKit && sessionStorage.getItem('ikisai-guide-link'))).toContain('demo.guia.llegada');
    await callout.getByRole('button', { name: 'Cerrar el aviso del paso' }).click();
    await expect(callout).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('ikisai-guide-link'))).toBeNull();
  });

  test('escondido: la app lo enseña con registerReveal; si no está, lo dice', async ({ page }) => {
    await page.goto('/');
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    await page.locator('#guiado').scrollIntoViewIfNeeded();
    await page.locator('#guidePointPlate').click();
    await expect.poll(() => page.locator('#guideMore').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    await expect(page.locator('#guidePlate')).toBeFocused();
    await expect(page.locator('#guidePlate')).toHaveAttribute('data-field-confirm', 'event');
    await expect(page.locator('#guidePlate')).toHaveAttribute('data-field-validator', 'matricula');
    await page.locator('#guidePointMissing').click();
    await expect(page.locator('#guideHost .guia-status')).toHaveText('No encuentro el campo de este paso en esta pantalla.', { timeout: 8000 });
    await expect(page.locator('#guideHost .guia-callout')).toHaveAttribute('data-found', 'false');
  });

  test('confirmación: guardar con createSaveState y el id del campo avisa solo; announceSaved para el resto; nunca el valor', async ({ page }) => {
    await page.goto('/');
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    await page.locator('#guiado').scrollIntoViewIfNeeded();
    await page.evaluate(() => { (window as any).details = []; addEventListener('ikisai:field-saved', (e) => (window as any).details.push((e as CustomEvent).detail)); });
    await page.locator('#guideArrival').fill('18:30');
    await page.getByRole('button', { name: 'Guardar hora' }).click();
    await expect(page.locator('#guideSavedOut')).toHaveText('demo.guia.llegada');
    await page.locator('#guideMore summary').click();
    await page.getByRole('button', { name: 'Guardar matrícula' }).click();
    await expect(page.locator('#guideSavedOut')).toHaveText('demo.guia.llegada, demo.guia.matricula');
    expect(await page.evaluate(() => (window as any).details)).toEqual([{ id: 'demo.guia.llegada', pending: false }, { id: 'demo.guia.matricula', pending: false }]);
    // Una clave que no es un id de campo no avisa.
    await page.evaluate(() => (window as any).ikisaiKit.createSaveState().track('nombre', Promise.resolve()));
    expect(await page.evaluate(() => (window as any).details.length)).toBe(2);
  });
});
