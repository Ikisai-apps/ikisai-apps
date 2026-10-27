import { expect, test, type Page } from 'playwright/test';
// @ts-expect-error: script de Node sin tipos.
import { extractFeatures } from '../scripts/feature-catalog.mjs';

/** Encargo de Core (27-10): la pieza «Proyección» para Flow (carril que lee de otra app y actúa con capacidades). */
async function mount(page: Page, opts: { failRead?: boolean; confirm?: boolean; offline?: boolean } = {}): Promise<void> {
  await page.goto('/');
  await page.evaluate((opts) => {
    const K = (window as any).ikisaiKit;
    const w = window as any;
    w.calls = []; w.counts = []; w.online = !opts.offline;
    const data = [
      { id: 'r1', name: 'Ana Ruiz', room: 'Hab 2', status: 'expected' },
      { id: 'r2', name: 'Luis Gil', room: 'Hab 4', status: 'expected' },
      { id: 'r3', name: 'Marta Sanz', room: 'Hab 1', status: 'arrived' },
    ];
    const client = { api: async (path: string, init: { json?: any }) => {
      w.calls.push({ path, json: init?.json });
      if (path === '/capabilities/booking.arrivals_today/invoke') {
        if (opts.failRead) throw Object.assign(new Error('x'), { status: 503, code: 'APP_UNAVAILABLE' });
        return { result: { arrivals: data.map((a) => ({ ...a })) } };
      }
      if (path === '/capabilities/booking.check_in/invoke') {
        if (init.json.reservation_id === 'r2') throw Object.assign(new Error('x'), { status: 403, code: 'NEEDS_ACCESS' });
        data.find((a) => a.id === init.json.reservation_id)!.status = 'arrived';
        return { result: { id: init.json.reservation_id } };
      }
      throw new Error('404');
    } };
    w.proj = K.createProjection({ label: 'Llegadas', client, appName: 'Booking', refreshMs: 0, feedbackId: 'flow.recepcion.llegadas', isOnline: () => w.online,
      read: { capability: 'booking.arrivals_today', input: () => ({ day: '2026-10-27' }) },
      rows: (r: any) => [...r.arrivals.map((a: any) => ({ id: a.id, title: a.name, meta: [a.room], chip: a.status === 'arrived' ? 'Ha llegado' : 'Por llegar', href: a.id === 'r1' ? 'javascript:alert(1)' : `#/reservas/${a.id}`, data: { status: a.status } })), { id: 'mal id', title: 'Fila rara' }],
      action: { label: 'Ya ha llegado', capability: 'booking.check_in', input: (row: any) => ({ reservation_id: row.id }), when: (row: any) => row.data.status === 'expected', confirm: opts.confirm },
      onCount: (n: number) => w.counts.push(n), empty: 'No llega nadie más hoy' });
    document.body.replaceChildren(K.el('div', { style: 'padding:16px' }, w.proj.element));
  }, opts);
  await expect(page.locator('.proj-box')).toHaveAttribute('aria-busy', 'false');
}
const calls = (page: Page) => page.evaluate(() => (window as any).calls as { path: string; json: any }[]);

test.describe('ui-kit v0.69 · Proyección', () => {
  test('catálogo: la pieza y sus marcas', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'función pura: una vez basta');
    const ids = extractFeatures("createProjection({ client, read, rows, feedbackId: 'flow.recepcion.llegadas' })").features.map((f: { id: string }) => f.id);
    expect(ids).toEqual(['flow.recepcion.llegadas', 'flow.recepcion.llegadas.abrir', 'flow.recepcion.llegadas.accion']);
  });

  test('@smoke lee de la otra app, actúa por fila y vuelve a leer: manda lo que diga la app dueña', async ({ page }) => {
    await mount(page);
    const rows = page.locator('.proj-row');
    await expect(rows).toHaveCount(3);
    expect(await page.evaluate(() => (window as any).counts)).toEqual([3]);
    // El enlace peligroso no se pinta como enlace; la fila con id raro, fuera.
    await expect(rows.nth(0).locator('a')).toHaveCount(0);
    await expect(rows.nth(1).locator('a.proj-title')).toHaveAttribute('href', '#/reservas/r2');
    // Solo las que cumplen `when` llevan acción.
    await expect(page.locator('.proj-action')).toHaveCount(2);
    await page.getByRole('button', { name: 'Ya ha llegado: Ana Ruiz' }).click();
    await expect(rows.nth(0).locator('.proj-chip')).toHaveText('Ha llegado');
    await expect(page.locator('.proj-action')).toHaveCount(1);
    const c = await calls(page);
    expect(c.map((x) => x.path)).toEqual(['/capabilities/booking.arrivals_today/invoke', '/capabilities/booking.check_in/invoke', '/capabilities/booking.arrivals_today/invoke']);
    expect(c[0]!.json).toEqual({ day: '2026-10-27' });
    expect(c[1]!.json).toEqual({ requestId: 'proj:booking.check_in:r1', reservation_id: 'r1' });
  });

  test('errores en palabras: sin permiso en la app dueña, y la fila sigue como estaba', async ({ page }) => {
    await mount(page);
    await page.getByRole('button', { name: 'Ya ha llegado: Luis Gil' }).click();
    const row = page.locator('.proj-row[data-row="r2"]');
    await expect(row.locator('.proj-error')).toHaveText('Tu cuenta no puede hacer esto en Booking.');
    await expect(row.locator('.proj-chip')).toHaveText('Por llegar');
    await expect(row.locator('.proj-action')).toBeEnabled();
  });

  test('lectura que falla, sin red y confirmar antes', async ({ page }) => {
    await mount(page, { failRead: true });
    await expect(page.locator('.proj-status')).toHaveText('Booking no responde ahora mismo. Prueba en un rato.');
    await mount(page, { offline: true });
    // Sin red al empezar: no hay lectura que enseñar, pero tampoco se fingen acciones.
    await page.evaluate(() => { (window as any).online = false; dispatchEvent(new Event('offline')); });
    await expect(page.locator('.proj-status')).toHaveText('Sin conexión: puede no estar al día.');
    await expect(page.locator('.proj-action').first()).toBeDisabled();
    await mount(page, { confirm: true });
    await page.getByRole('button', { name: 'Ya ha llegado: Ana Ruiz' }).click();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    expect((await calls(page)).filter((c) => c.path.includes('check_in'))).toHaveLength(0);
  });
});
