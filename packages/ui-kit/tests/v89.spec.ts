import { expect, test } from 'playwright/test';

/** K-07 (VG, 05-11): sin red, además de la pastilla, una franja arriba con lo que queda por enviar. */
test('statusBanners: sin red sale la franja «Sin conexión» con los pendientes; hideOffline la quita', async ({ page }, info) => {
  test.skip(info.project.name !== 'escritorio', 'una vez basta');
  await page.goto('/');
  const out = await page.evaluate(() => {
    const K = (window as any).ikisaiKit;
    const base = { network: 'offline', pendingCommands: 3, pendingBlobs: 0, conflicts: 0, rejected: 0, lastSyncAt: null, lastError: null };
    const text = (s: object, o: object = {}) => K.statusBanners(s, o).filter((b: HTMLElement) => b.dataset.banner === 'offline').map((b: HTMLElement) => b.textContent);
    return { pending: text(base), none: text({ ...base, pendingCommands: 0 }), hidden: text(base, { hideOffline: true }), online: text({ ...base, network: 'online' }) };
  });
  expect(out.pending).toEqual(['Sin conexión: 3 cambios pendientes, se enviarán al volver la red.']);
  expect(out.none).toEqual(['Sin conexión: lo que guardes se enviará al volver la red.']);
  expect(out.hidden).toEqual([]);
  expect(out.online).toEqual([]);
});
