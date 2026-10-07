import { expect, test, type Page } from 'playwright/test';

async function fresh(page: Page, reviewing = true): Promise<void> {
  await page.goto('/#feedback');
  await page.evaluate(async (on) => {
    const w = window as any;
    w.ikisaiFeedback.fbSave({ reports: [], posts: 0, offline: false, fail: null });
    await w.ikisaiFeedback.feedback.clear('demo-user');
    w.ikisaiFeedback.review.mode.set(on);
    w.ikisaiFeedback.review.tab('usage');
  }, reviewing);
  await page.reload();
  await page.locator('#fbOpen').waitFor();
}
const server = (page: Page) => page.evaluate(() => (window as any).ikisaiFeedback.fbState());
const card = (page: Page) => page.locator('.fb-review-card');

test.describe('ui-kit v0.17 · Revisor › Uso', () => {
  test('pestañas «Incidencias | Uso»; la lista agrupa por insight con lo más grave arriba', async ({ page }) => {
    await fresh(page);
    const panel = page.locator('.fb-review');
    await expect(panel.locator('[data-tab="usage"][aria-selected="true"]')).toBeVisible();
    await expect(panel.locator('.fb-review-list[data-insight]')).toHaveCount(4);
    await expect(panel.locator('.fb-review-list[data-insight]').first()).toHaveAttribute('data-insight', 'HIGH_ERROR');
    await expect(panel.locator('[data-insight="TARGET_NOT_ADOPTING"] .usage-row')).toContainText('Añadir huésped');
    await expect(panel.locator('[data-insight="HIGH_ACTIVITY"]')).toBeVisible();
    await panel.locator('[data-tab="feedback"]').click();
    await expect(panel.locator('.fb-review-body')).toContainText('Por revisar · 0');
    // Se recuerda en el dispositivo.
    await page.reload();
    await expect(page.locator('.fb-review [data-tab="feedback"][aria-selected="true"]')).toBeVisible();
  });

  test('ir al sitio ilumina la función; tarjeta con estado, 30 días, matriz por equipo y persona', async ({ page }) => {
    await fresh(page);
    await page.locator('.usage-row[data-feature="demo.reservation.guests.add"]').click();
    await expect(page.locator('#fbAction')).toHaveClass(/fb-spot/);
    await expect(card(page).locator('.usage-insight')).toHaveText('Su audiencia la ve pero no la usa');
    await expect(card(page).locator('.usage-numbers')).toContainText('52');
    await expect(card(page).locator('.by-team tbody tr')).toHaveCount(2);
    await expect(card(page).locator('.by-team')).toContainText('Recepción');
    await expect(card(page).locator('.usage-numbers')).toContainText('Audiencia');
    await expect(card(page).locator('.usage-unattributed')).toContainText('Sin persona');
    await expect(card(page).locator('.by-person summary')).toContainText('Por persona (1)');
    await expect(card(page)).toContainText('Generación 1 desde v0.17.0');
    await expect(card(page)).toContainText('Incidencias: 1 abiertas');
  });

  test('decisiones y ajustes: audiencia, frecuencia, mantener con fecha, no evaluar y nueva generación', async ({ page }) => {
    await fresh(page);
    await page.locator('.usage-row[data-feature="demo.reservation.guests.add"]').click();
    await card(page).locator('.usage-audience summary').click();
    await card(page).locator('[data-team="0b6f0e0a-0000-4000-8000-000000000003"]').check();
    await card(page).locator('.usage-save-audience').click();
    await expect(page.locator('.toast.show')).toContainText('Audiencia guardada');
    await card(page).locator('.usage-frequency').selectOption('occasional');
    await expect(page.locator('.toast.show')).toContainText('Frecuencia guardada');
    await expect(card(page)).toContainText('Frecuencia: Ocasional');
    await card(page).locator('.usage-review-after').fill('2027-01-15');
    await card(page).locator('.usage-reason').fill('Temporada baja');
    await card(page).locator('.usage-keep').click();
    await expect(card(page).locator('.usage-decision')).toContainText('mantener (revisar el 2027-01-15)');
    await card(page).locator('.usage-not-evaluate').click();
    await expect(card(page).locator('.usage-decision')).toContainText('no evaluar');
    await card(page).locator('.usage-new-generation').click();
    await page.locator('.dialog .primary, [role="alertdialog"] .primary, dialog .primary').first().click();
    await expect(card(page)).toContainText('Generación 2');
    const posts = (await server(page)).usagePosts as { path: string; body: any }[];
    expect(posts.find((p) => p.body.audience)?.body.audience).toEqual({ teams: ['0b6f0e0a-0000-4000-8000-000000000001', '0b6f0e0a-0000-4000-8000-000000000003'], people: [] });
    expect(posts.find((p) => p.body.frequency)?.body.frequency).toBe('occasional');
    expect(posts.find((p) => p.body.decision === 'keep')?.body).toEqual({ decision: 'keep', reviewAfter: '2027-01-15', reason: 'Temporada baja' });
    expect(posts.find((p) => p.body.decision === 'do_not_evaluate')?.body.reviewAfter).toBeUndefined();
    expect(posts.some((p) => p.body.newGeneration === true)).toBe(true);
  });

  test('«Revisar utilidad» crea un reporte de feedback normal con el texto generado', async ({ page }) => {
    await fresh(page);
    await page.locator('.usage-row[data-feature="demo.reservation.more.export"]').click();
    // No está a la vista (dentro de un <details> cerrado): se ancla a su sección y se queda vigilando.
    await expect(card(page).locator('.fb-rv-approx')).toBeVisible();
    await card(page).locator('.usage-review-utility').click();
    await expect(page.locator('.toast.show')).toContainText('Creado FB_2026_0001');
    const report = (await server(page)).reports[0];
    expect(report.intent).toBe('improvement');
    expect(report.node.id).toBe('demo.reservation.more.export');
    expect(report.message).toContain('Revisar la utilidad de «Exportar»');
    // Al abrir el <details>, la función aparece y se ilumina.
    // En móvil la tarjeta es una hoja que tapa la pantalla: se minimiza para llegar a la función.
    if (await card(page).locator('.fb-rv-min').isVisible()) await card(page).locator('.fb-rv-min').click();
    await page.locator('#fbScreen details summary').click();
    await expect(page.locator('#usageInDetails')).toHaveClass(/fb-spot/);
    await expect(card(page).locator('.fb-rv-approx')).toHaveCount(0);
  });

  test('una función de otra app abre su dominio con ?fbf=; al arrancar con ?fbf= se abre su tarjeta', async ({ page }) => {
    await fresh(page);
    await page.locator('.usage-row[data-feature="booking.reservations.import"]').click();
    await expect(page.locator('#fbOpened')).toHaveText('https://booking.ikisai.com/?fbf=booking.reservations.import&qa=1');
    await fresh(page, false);
    await page.goto('/?fbf=demo.reservation.guests.add&qa=1#feedback');
    await expect(card(page).locator('.usage-insight')).toBeVisible();
    await expect(page.locator('#fbAction')).toHaveClass(/fb-spot/);
    expect(new URL(page.url()).search).toBe('');
    expect(await page.evaluate(() => (window as any).ikisaiFeedback.review.tab())).toBe('usage');
  });
});
