import { expect, test } from 'playwright/test';

/** K-06 (VG, 05-11, K-08 b): «Rehacer datos de este dispositivo» envía lo pendiente y enseña lo que quede antes de borrar. */
test('rebuildDeviceData: sin pendientes rehace; con pendientes los enseña y solo borra si se confirma', async ({ page }, info) => {
  test.skip(info.project.name !== 'escritorio', 'una vez basta');
  await page.goto('/');
  await page.evaluate(() => {
    const K = (window as any).ikisaiKit;
    const w = window as any;
    w.make = (pending: number) => {
      const calls: string[] = [];
      const client = {
        status: () => ({ network: 'online', pendingCommands: pending, pendingBlobs: 0, conflicts: 0, rejected: 0, lastSyncAt: null, lastError: null }),
        sync: async () => { calls.push('sync'); },
        resetMirror: async (o: { discardPending?: boolean }) => { calls.push(`reset:${!!o?.discardPending}`); },
      };
      w.calls = calls;
      w.done = K.rebuildDeviceData(client);
    };
  });
  const dialog = page.locator('[role="dialog"], dialog').last();
  // Sin pendientes: confirmar una vez y rehacer.
  await page.evaluate(() => (window as any).make(0));
  await dialog.getByRole('button', { name: 'Rehacer' }).click();
  expect(await page.evaluate(() => (window as any).done)).toBe(true);
  expect(await page.evaluate(() => (window as any).calls)).toEqual(['sync', 'reset:false']);
  // Con 2 cambios que no se pudieron enviar: los enseña; «Cancelar» no borra nada.
  await page.evaluate(() => (window as any).make(2));
  await dialog.getByRole('button', { name: 'Rehacer' }).click();
  await expect(dialog).toContainText('2 cambios sin enviar');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  expect(await page.evaluate(() => (window as any).done)).toBe(false);
  expect(await page.evaluate(() => (window as any).calls)).toEqual(['sync']);
});
