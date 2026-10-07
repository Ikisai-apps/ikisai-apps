import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from 'playwright/test';
// @ts-expect-error: script de Node sin tipos.
import { extractFeatures, generateCatalog } from '../scripts/feature-catalog.mjs';

async function fresh(page: Page): Promise<void> {
  await page.goto('/#feedback');
  await page.evaluate(async () => {
    const w = window as any;
    w.ikisaiFeedback.fbSave({ reports: [], posts: 0, offline: false, fail: null });
    await w.ikisaiFeedback.usage.clear('demo-user');
    await w.ikisaiFeedback.feedback.clear('demo-user');
    w.ikisaiFeedback.feedback.mode.set(false);
    w.ikisaiFeedback.review.mode.set(false);
    sessionStorage.clear();
    localStorage.removeItem('ikisai-usage-notice:demo-user');
  });
  await page.reload();
  await page.locator('#fbOpen').waitFor();
}
type Item = { featureId: string; context: string; exposures: number; activations: number; successes: number; errors: number; sessionsExposed: number; sessionsActivated: number; sessionsSucceeded: number; repeatedAttempts: number };
const today = (page: Page): Promise<Item[]> => page.evaluate(() => (window as any).ikisaiFeedback.usage.today());
const one = async (page: Page, id: string, context = 'production') => (await today(page)).find((i) => i.featureId === id && i.context === context);
const server = (page: Page) => page.evaluate(() => (window as any).ikisaiFeedback.fbState());

test.describe('ui-kit v0.17 · uso de funcionalidades: recolector', () => {
  test('exposición: ≥ 50 % durante 1 s, una por sesión; nada de lo oculto ni de un <details> cerrado', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbAction').scrollIntoViewIfNeeded();
    await expect.poll(async () => (await one(page, 'demo.reservation.guests.add'))?.exposures ?? 0, { timeout: 5000 }).toBe(1);
    const add = (await one(page, 'demo.reservation.guests.add'))!;
    expect(add.sessionsExposed).toBe(1);
    await page.waitForTimeout(1300);
    expect(await one(page, 'demo.reservation.hidden')).toBeUndefined();
    expect(await one(page, 'demo.reservation.more.export')).toBeUndefined();
    // Misma pestaña tras recargar: misma sesión, no se vuelve a contar.
    await page.reload();
    await page.locator('#fbAction').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    expect((await one(page, 'demo.reservation.guests.add'))!.exposures).toBe(1);
  });

  test('activación por clic y teclado; repetir antes de 2 s cuenta como intento repetido; lo ignorado no cuenta', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbAction').click();
    await page.locator('#fbAction').click();
    await expect.poll(async () => (await one(page, 'demo.reservation.guests.add'))?.activations ?? 0).toBe(2);
    const add = (await one(page, 'demo.reservation.guests.add'))!;
    expect(add.sessionsActivated).toBe(1);
    expect(add.repeatedAttempts).toBe(1);
    // Intro sobre un botón produce un clic: se cuenta una vez.
    await page.locator('#fbAction').focus();
    await page.waitForTimeout(2100);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await one(page, 'demo.reservation.guests.add'))!.activations).toBe(3);
    // Una pestaña con rol: Intro cuenta.
    await page.locator('#usageTab').focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await one(page, 'demo.reservation.tab_payment'))?.activations ?? 0).toBe(1);
    await page.locator('[data-feedback-ignore]').first().click();
    await page.waitForTimeout(300);
    // La sección se ve (exposición), pero tocar su zona ignorada no es una activación.
    expect((await one(page, 'demo.reservation.guests'))?.activations ?? 0).toBe(0);
  });

  test('usage.run cuenta éxito y error; el contexto sigue a los interruptores (el revisor manda)', async ({ page }) => {
    await fresh(page);
    await page.locator('#usageSaveOk').click();
    await page.locator('#usageSaveFail').click();
    await page.locator('#usageSaveOk').click();
    await expect.poll(async () => (await one(page, 'demo.reservation.save'))?.successes ?? 0).toBe(2);
    const save = (await one(page, 'demo.reservation.save'))!;
    expect(save.errors).toBe(1);
    expect(save.sessionsSucceeded).toBe(1);
    await page.evaluate(() => (window as any).ikisaiFeedback.feedback.mode.set(true));
    await page.locator('#usageSaveOk').click();
    await expect.poll(async () => (await one(page, 'demo.reservation.save', 'qa'))?.successes ?? 0).toBe(1);
    await page.evaluate(() => (window as any).ikisaiFeedback.review.mode.set(true));
    await page.evaluate(() => (window as any).ikisaiFeedback.usage.track('demo.reservation.save'));
    await expect.poll(async () => (await one(page, 'demo.reservation.save', 'reviewer'))?.successes ?? 0).toBe(1);
  });

  test('la pulsación larga del feedback no cuenta como activación', async ({ page }) => {
    await fresh(page);
    await page.evaluate(() => (window as any).ikisaiFeedback.feedback.mode.set(true));
    const target = page.locator('#fbAction');
    const box = (await target.boundingBox())!;
    await target.hover({ position: { x: Math.min(box.width / 2, 20), y: box.height / 2 } });
    await page.mouse.down();
    await page.waitForTimeout(750);
    await page.mouse.up();
    await expect(page.locator('.fb-composer')).toHaveCount(1);
    await page.waitForTimeout(300);
    expect((await one(page, 'demo.reservation.guests.add', 'qa'))?.activations ?? 0).toBe(0);
  });

  test('envío idempotente: totales del día, el servidor guarda el máximo; sin red espera', async ({ page }) => {
    await fresh(page);
    await page.locator('#fbAction').click();
    await page.evaluate(() => (window as any).ikisaiFeedback.usage.flush());
    let st = await server(page);
    const key = Object.keys(st.usage).find((k) => k.includes('|demo.reservation.guests.add|production'))!;
    expect(key.split('|')[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(st.usage[key].activations).toBe(1);
    // Reenviar lo mismo no suma.
    await page.evaluate(async () => { const u = (window as any).ikisaiFeedback.usage; await u.flush(); });
    st = await server(page);
    expect(st.usage[key].activations).toBe(1);
    // Sin red: no se pierde; al volver, se envía el total nuevo.
    await page.evaluate(() => { const w = window as any; const s = w.ikisaiFeedback.fbState(); s.offline = true; w.ikisaiFeedback.fbSave(s); });
    await page.waitForTimeout(2100);
    await page.locator('#fbAction').click();
    await page.evaluate(() => (window as any).ikisaiFeedback.usage.flush());
    expect((await server(page)).usage[key].activations).toBe(1);
    await page.evaluate(() => { const w = window as any; const s = w.ikisaiFeedback.fbState(); s.offline = false; w.ikisaiFeedback.fbSave(s); });
    await page.evaluate(() => (window as any).ikisaiFeedback.usage.flush());
    expect((await server(page)).usage[key].activations).toBe(2);
    // Lo enviado no lleva valores ni textos de la página.
    expect(JSON.stringify((await server(page)).usage)).not.toContain('Juan');
  });

  test('aviso al equipo: «Entendido» lo acepta y no vuelve a salir; al cerrar sesión se borran los totales', async ({ page }) => {
    await fresh(page);
    await page.locator('#usageNotice').click();
    await expect(page.locator('.usage-notice')).toContainText('no se usa para evaluar a nadie');
    await page.locator('.usage-ok').click();
    await expect(page.locator('.usage-notice')).toHaveCount(0);
    expect((await server(page)).consentedAt).toBeTruthy();
    await page.locator('#usageNotice').click();
    await page.waitForTimeout(500);
    await expect(page.locator('.usage-notice')).toHaveCount(0);
    await page.locator('#fbAction').click();
    await expect.poll(async () => (await today(page)).length).toBeGreaterThan(0);
    await page.evaluate(() => (window as any).ikisaiFeedback.usage.clear('demo-user'));
    expect(await today(page)).toHaveLength(0);
  });
});

test.describe('ui-kit v0.17 · catálogo de funciones al compilar', () => {
  test('saca ids, etiquetas, tipo, padre y operaciones; los ids dinámicos van aparte', async () => {
    const root = mkdtempSync(join(tmpdir(), 'catalog-'));
    mkdirSync(join(root, 'apps', 'booking', 'src'), { recursive: true });
    mkdirSync(join(root, 'apps', 'booking', 'public'), { recursive: true });
    writeFileSync(join(root, 'apps', 'booking', 'src', 'a.ts'), [
      "const s = el('section', { 'data-feedback-id': 'booking.reserva', 'data-feedback-label': 'Reserva' });",
      "const b = el('button', { type: 'button', 'data-feedback-id': 'booking.reserva.huespedes.anadir', 'data-feedback-label': 'Añadir huésped' });",
      "const t = `<div role=\"tab\" data-feedback-id=\"booking.reserva.cobro\" data-feedback-label=\"Cobro\">`;",
      "const r = el('li', { 'data-feedback-id': `booking.reserva.fila.${id}` });",
      "await usage.run('booking.reserva.guardar', async () => save());",
    ].join('\n'));
    writeFileSync(join(root, 'apps', 'booking', 'public', 'sw.js'), "const x = { 'data-feedback-id': 'booking.sw' };");
    const { catalog } = generateCatalog({ app: 'booking', root, release: 'v1.2.3', commit: 'abc1234' });
    const byId = Object.fromEntries(catalog.features.map((f: { id: string }) => [f.id, f]));
    expect(catalog.app).toBe('booking');
    expect(catalog.release).toBe('v1.2.3');
    expect(byId['booking.reserva']).toMatchObject({ label: 'Reserva', kind: 'section', parent: null });
    expect(byId['booking.reserva.huespedes.anadir']).toMatchObject({ label: 'Añadir huésped', kind: 'button', parent: 'booking.reserva' });
    expect(byId['booking.reserva.cobro']).toMatchObject({ label: 'Cobro', kind: 'tab' });
    expect(byId['booking.reserva.guardar']).toMatchObject({ kind: 'operation', parent: 'booking.reserva' });
    expect(byId['booking.sw']).toBeUndefined();
    expect(catalog.dynamic).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(root, 'apps', 'booking', 'dist', 'feature-catalog.json'), 'utf8'));
    expect(written.features).toHaveLength(4);
    expect(extractFeatures("usage.track('booking.import.ok')").features[0].kind).toBe('operation');
  });
});
