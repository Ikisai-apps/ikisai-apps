import { expect, test, type Page } from 'playwright/test';
import { safeRoute, sanitizeGuideRun } from '../src/guide/flow-source.ts';

/** Guiado, tanda 3 (contrato con Core del 27-10): el shell monta la guía completa leyendo la ejecución de Flow. */
async function arrive(page: Page, opts: { fail?: boolean } = {}): Promise<void> {
  const volver = encodeURIComponent('/?vuelta=1#/recepcion');
  await page.goto(`/#/?desde=flow&volver=${volver}&titulo=Flow&guia=ej_7`);
  await page.addStyleTag({ content: '.demo-head{position:static!important}' });
  await page.evaluate((opts) => {
    const w = window as any;
    w.calls = [];
    const done = new Set<string>();
    // Cliente falso con la forma de SyncClient.api y de `POST capabilities/<id>/invoke`.
    const client = {
      api: async (path: string, init: { method?: string; json?: any }) => {
        w.calls.push({ path, json: init?.json });
        if (path === '/capabilities/flow.guide_read/invoke') {
          if (opts.fail) throw new Error('503');
          return { capability: 'flow.guide_read', version: 1, result: { id: 'ej_7', title: 'Alojar a alguien', mode: 'run', steps: [
            { id: 'hora', title: 'Pon la hora de llegada', explain: 'Así recepción sabe cuándo esperarle.', anchor: 'demo.guia.llegada', confirm: 'save', done: done.has('hora') },
            { id: 'mala', title: 'Paso con ruta rara', anchor: 'no vale', route: 'javascript:alert(1)', confirm: 'manual', done: done.has('mala') },
          ] } };
        }
        if (path === '/capabilities/flow.guide_confirm/invoke') { done.add(init.json.step_id === 'hora' ? 'hora' : init.json.step_id); return { result: { ok: true } }; }
        throw new Error('404');
      },
    };
    const root = document.createElement('div');
    root.id = 'guideShell';
    document.body.prepend(root);
    w.shell = w.ikisaiKit.createAppShell(root, { appName: 'Booking', nav: [{ hash: '#/', label: 'Inicio', icon: 'home' }], navigate: (h: string) => { location.hash = h; }, guide: { client, app: 'booking', feedbackId: 'booking.guia' } });
  }, opts);
}
const calls = (page: Page) => page.evaluate(() => (window as any).calls as { path: string; json: any }[]);

test.describe('ui-kit v0.68 · Guiado desde Flow en el shell', () => {
  test('lo que llega de Flow se valida: anclajes, rutas, textos e ids', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    expect(safeRoute('#/reservas/1')).toBe('#/reservas/1');
    expect(safeRoute('/a?b=1')).toBe('/a?b=1');
    for (const bad of ['//evil.com', 'javascript:alert(1)', 'https://x.com', '#/a b']) expect(safeRoute(bad)).toBeNull();
    const run = sanitizeGuideRun({ id: 'x', title: 'T', mode: 'raro', steps: [
      { id: 'a', title: 'A', anchor: 'booking.ficha.llegada', confirm: 'save', done: 'sí' },
      { id: 'a', title: 'repetido' }, { id: 'b c', title: 'id malo' }, { id: 'c', title: '' },
      { id: 'd', title: 'D', anchor: 'div > input', confirm: 'borrar', essential: false, explain: 'x'.repeat(900) },
    ] });
    expect(run.mode).toBe('run');
    expect(run.steps.map((s) => s.id)).toEqual(['a', 'd']);
    expect(run.steps[0]).toMatchObject({ anchor: 'booking.ficha.llegada', confirm: 'save', done: false, essential: true });
    expect(run.steps[1]).toMatchObject({ anchor: null, confirm: undefined, essential: false });
    expect(run.steps[1]!.explain).toHaveLength(600);
    expect(() => sanitizeGuideRun({ steps: 'no' })).toThrow();
  });

  test('@smoke con ?guia=…: lee la ejecución de Flow, guía sobre la app y confirma en Flow sin valores', async ({ page }) => {
    await arrive(page);
    const bubble = page.locator('.guia-bubble');
    await expect(bubble.locator('.guia-title')).toHaveText('Pon la hora de llegada');
    await expect(bubble).toHaveAttribute('data-feedback-id', 'booking.guia');
    expect(new URL(page.url()).hash).toBe('#/?desde=flow');
    expect((await calls(page))[0]).toEqual({ path: '/capabilities/flow.guide_read/invoke', json: { execution_id: 'ej_7', app: 'booking' } });
    // Sin la línea del nivel mínimo: con ejecución va la guía completa.
    await expect(page.locator('.guia-callout')).toHaveCount(0);
    await page.locator('#guideArrival').fill('18:30');
    await page.getByRole('button', { name: 'Guardar hora' }).click();
    await expect(bubble.locator('.guia-title')).toHaveText('Paso con ruta rara');
    const confirm = (await calls(page)).find((c) => c.path === '/capabilities/flow.guide_confirm/invoke')!;
    expect(confirm.json).toEqual({ requestId: 'guide:ej_7:hora:save', execution_id: 'ej_7', step_id: 'hora', how: 'save', pending: false });
    expect(JSON.stringify(await calls(page))).not.toContain('18:30');
    // La ruta peligrosa no llega: sin «Ir allí».
    await expect(bubble.getByRole('button', { name: 'Ir allí' })).toHaveCount(0);
    await bubble.getByRole('button', { name: 'Hecho', exact: true }).click();
    await expect(bubble.locator('.guia-title')).toContainText('Todo hecho');
    await expect(bubble.getByRole('link', { name: 'Volver a Flow' })).toHaveAttribute('href', '/?vuelta=1#/recepcion');
  });

  test('si Flow no responde, lo dice con «Reintentar» y «Volver a Flow»', async ({ page }) => {
    await arrive(page, { fail: true });
    const bubble = page.locator('.guia-bubble');
    await expect(bubble).toContainText('No se pudo cargar la guía.');
    await expect(bubble.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(bubble.getByRole('link', { name: 'Volver a Flow' })).toBeVisible();
  });
});
