import { expect, test, type Page } from 'playwright/test';
import { flowGuideSource } from '../src/guide/flow-source.ts';

/** Guiado listo para un recorrido real en el móvil (Guests y Booking, 27-10) y encajado con `flow.guide_read/confirm` (0940). */
async function start(page: Page): Promise<void> {
  await page.goto('/');
  await page.addStyleTag({ content: '.demo-head{position:static!important}' });
  await page.locator('#guiado').scrollIntoViewIfNeeded();
  await page.locator('#guideStart').click();
  await expect(page.locator('.guia-bubble .guia-title')).toHaveText('Pon la hora de llegada');
}
const bubble = (page: Page) => page.locator('.guia-bubble');
const log = (page: Page) => page.locator('#guideLogOut');

test.describe('ui-kit · Guiado en el móvil y con Flow', () => {
  test('móvil: al escribir, la burbuja sube a una tira que no tapa el campo ni «Guardar»; al llegar se ve la explicación', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'la tira es del móvil');
    await start(page);
    // El foco que pone la guía al llegar no la pliega: la explicación se lee.
    await expect(page.locator('#guideArrival')).toBeFocused();
    await expect(bubble(page)).not.toHaveClass(/guia-compact/);
    await expect(bubble(page).locator('.guia-explain')).toBeVisible();
    // La persona toca el campo y escribe: tira arriba.
    await page.locator('#guideArrival').tap();
    await page.locator('#guideArrival').fill('18:30');
    await expect(bubble(page)).toHaveClass(/guia-compact/);
    await expect(bubble(page).locator('.guia-explain')).toBeHidden();
    const strip = (await bubble(page).boundingBox())!;
    const field = (await page.locator('#guideArrival').boundingBox())!;
    const save = page.getByRole('button', { name: 'Guardar hora' });
    const button = (await save.boundingBox())!;
    expect(strip.height).toBeLessThan(70);
    expect(strip.y + strip.height).toBeLessThanOrEqual(field.y + 1);
    expect(strip.y + strip.height).toBeLessThanOrEqual(button.y + 1);
    // «Guardar» se puede tocar (nada encima) y, al soltar, la guía avanza.
    const hit = await page.evaluate(([x, y]) => (document.elementFromPoint(x!, y!) as HTMLElement | null)?.textContent ?? '', [button.x + button.width / 2, button.y + button.height / 2]);
    expect(hit).toBe('Guardar hora');
    await save.tap();
    await expect(bubble(page).locator('.guia-title')).toHaveText('Apunta la matrícula');
    await expect(bubble(page)).not.toHaveClass(/guia-compact/);
    await expect(log(page)).toHaveText('llegada:save');
  });

  test('guardado sin red: avanza con «pendiente» y se vuelve a confirmar cuando se guarda de verdad', async ({ page }) => {
    await start(page);
    await page.evaluate(() => (window as any).ikisaiKit.announceSaved('demo.guia.llegada', { pending: true }));
    await expect(bubble(page).locator('.guia-title')).toHaveText('Apunta la matrícula');
    await expect(log(page)).toHaveText('llegada:save (pendiente)');
    await page.evaluate(() => (window as any).ikisaiKit.announceSaved('demo.guia.llegada'));
    await expect(log(page)).toHaveText('llegada:save (pendiente), llegada:save');
    // Una sola vez: otro guardado del mismo campo ya no reconfirma.
    await page.evaluate(() => (window as any).ikisaiKit.announceSaved('demo.guia.llegada'));
    await page.waitForTimeout(200);
    await expect(log(page)).toHaveText('llegada:save (pendiente), llegada:save');
  });

  test('con Flow (0940): «Saltar» va como none, pendiente y enviado con recibos distintos, nada en modo learn', async ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
    const calls: { path: string; json: any }[] = [];
    let mode = 'run';
    const client = {
      api: async <T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> => {
        calls.push({ path, json: init?.json });
        if (path.endsWith('flow.guide_read/invoke')) return { result: { id: 'r1', title: 'T', mode, steps: [{ id: 's1', title: 'Uno', anchor: 'booking.x', confirm: 'save' }] } } as T;
        return { result: { ok: true } } as T;
      },
    };
    const source = flowGuideSource(client, { app: 'booking' });
    const run = await source.load('r1');
    const step = run.steps[0]!;
    await source.confirm('r1', step, { how: 'save', pending: true });
    await source.confirm('r1', step, { how: 'save', pending: false });
    await source.skip!('r1', step);
    const sent = calls.filter((c) => c.path.endsWith('guide_confirm/invoke')).map((c) => c.json);
    expect(sent.map((j) => j.requestId)).toEqual(['guide:r1:s1:save:p', 'guide:r1:s1:save', 'guide:r1:s1:skip']);
    expect(sent.map((j) => j.how)).toEqual(['save', 'save', 'none']);
    for (const j of sent) expect(['save', 'event', 'manual', 'none']).toContain(j.how);
    expect(calls[0]!.json).toEqual({ execution_id: 'r1', app: 'booking' });
    // Ensayo: Flow rechaza confirmar fuera de Flow, así que no se envía.
    mode = 'learn';
    await source.load('r1');
    calls.length = 0;
    await source.confirm('r1', step, { how: 'save', pending: false });
    await source.skip!('r1', step);
    expect(calls).toEqual([]);
  });
});
