import { expect, test, type Page, type TestInfo } from 'playwright/test';
import { normalizeProposal } from '../src/proposals/list.ts';
import { changesFromPreview, createSuggestionSource, suggestionErrorMessage } from '../src/proposals/suggestion-source.ts';
import type { SyncClient } from '@ikisai/sync-client';

type Item = { id: string; status: string; comment?: string | null };
const store = (page: Page) => page.evaluate(() => (window as unknown as { proposalStore: Item[] }).proposalStore.map((i) => ({ id: i.id, status: i.status, comment: i.comment ?? null })));
const list = (page: Page) => page.locator('#proposalPanes .proposals');
const card = (page: Page, id: string) => list(page).locator(`.pl-card[data-id="${id}"]`);

/** Pulsa «Aprobar» o «Descartar»: en la tarjeta (móvil) o en el detalle (escritorio). */
async function press(page: Page, info: TestInfo, id: string, name: 'Aprobar' | 'Descartar'): Promise<void> {
  if (info.project.name === 'escritorio') {
    await card(page, id).locator('.pl-open').click();
    await list(page).locator(`.pl-detail .pl-detail-body[data-id="${id}"]`).getByRole('button', { name: new RegExp(`^${name}:`) }).click();
  } else {
    await card(page, id).getByRole('button', { name: new RegExp(`^${name}:`) }).click();
  }
}

test.describe('ui-kit v0.33 · cola de propuestas (O1)', () => {
  test('@smoke aprobar confirma siempre, con comentario opcional, y pasa a «Aprobadas»', async ({ page }, info) => {
    await page.goto('/#proposals');
    await expect(list(page).locator('.pl-card')).toHaveCount(3);
    await expect(list(page).locator('.pl-tabs .pl-count')).toHaveText('3');
    await press(page, info, 'sg-3', 'Aprobar');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('¿Aprobar esta propuesta?');
    await expect(dialog).toContainText('Yoga y huerto');
    await expect(page.locator('#proposalComment')).toBeFocused();
    await page.locator('#proposalComment').fill('Te damos plaza en la Hab 3.');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta aprobada.');
    await expect(card(page, 'sg-3')).toHaveCount(0);
    await expect(list(page).locator('.pl-tabs .pl-count')).toHaveText('2');
    expect((await store(page)).find((i) => i.id === 'sg-3')).toEqual({ id: 'sg-3', status: 'approved', comment: 'Te damos plaza en la Hab 3.' });
    await list(page).locator('.pl-tabs button[data-status="approved"]').click();
    await expect(card(page, 'sg-3').locator('.pl-quote')).toContainText('«Te damos plaza en la Hab 3.» · Staff');
    await expect(card(page, 'sg-3').locator('.chip.status')).toHaveText('Aprobada');
  });

  test('cancelar el diálogo no cambia nada; descartar es rojo y sin comentario guarda null', async ({ page }, info) => {
    await page.goto('/#proposals');
    await press(page, info, 'sg-2', 'Aprobar');
    await page.locator('#dialogCancel').click();
    await expect(card(page, 'sg-2')).toBeVisible();
    expect((await store(page)).find((i) => i.id === 'sg-2')!.status).toBe('pending');
    await press(page, info, 'sg-2', 'Descartar');
    await expect(page.locator('#dialogConfirm')).toHaveClass(/danger/);
    await expect(page.locator('#dialogConfirm')).toHaveText('Descartar');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta descartada.');
    expect((await store(page)).find((i) => i.id === 'sg-2')).toEqual({ id: 'sg-2', status: 'rejected', comment: null });
  });

  test('si el servidor lo rechaza, se avisa y la propuesta sigue pendiente', async ({ page }, info) => {
    await page.goto('/#proposals');
    await press(page, info, 'sg-1', 'Aprobar');
    await page.locator('#proposalComment').fill('fallo');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('No se ha guardado: El lote ya no encaja: la fila ya no existe.');
    await expect(card(page, 'sg-1')).toBeVisible();
    expect((await store(page)).find((i) => i.id === 'sg-1')!.status).toBe('pending');
  });

  test('filtro por tipo', async ({ page }) => {
    await page.goto('/#proposals');
    await list(page).locator('.pl-kinds .filterchip[data-kind="dish"]').click();
    await expect(list(page).locator('.pl-card')).toHaveCount(1);
    await expect(card(page, 'sg-2')).toBeVisible();
    await list(page).locator('.pl-kinds .filterchip', { hasText: 'Todas' }).click();
    await expect(list(page).locator('.pl-card')).toHaveCount(3);
  });

  test('«Mis propuestas»: pendientes y resueltas con el comentario; «Retirar» confirma', async ({ page }) => {
    await page.goto('/#proposals');
    await page.locator('#showMine').click();
    await expect(list(page)).toHaveClass(/mine/);
    await expect(list(page).locator('.pl-group')).toHaveText(['Pendientes', 'Resueltas']);
    await expect(card(page, 'sg-4').locator('.pl-quote')).toContainText('«Este mes no se puede hacer fuego.» · Dirección');
    await expect(card(page, 'sg-1').getByRole('button', { name: /Aprobar|Descartar/ })).toHaveCount(0);
    await card(page, 'sg-1').getByRole('button', { name: /^Retirar/ }).click();
    await expect(page.getByRole('alertdialog')).toContainText('¿Retirar esta propuesta?');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta retirada.');
    await expect(card(page, 'sg-1').locator('.chip.status')).toHaveText('Retirada');
    await expect(list(page).locator('.pl-group')).toHaveText(['Resueltas']);
    await page.locator('#showReview').click();
    await expect(card(page, 'sg-1')).toHaveCount(0);
  });

  test('escritorio: detalle a la derecha, ↑ ↓ cambian de propuesta y al decidir pasa a la siguiente', async ({ page }, info) => {
    test.skip(info.project.name !== 'escritorio', 'lista y detalle lado a lado');
    await page.goto('/#proposals');
    const detail = list(page).locator('.pl-detail');
    await expect(detail).toBeVisible();
    await expect(card(page, 'sg-3').locator('.pl-actions')).toBeHidden();
    await card(page, 'sg-3').locator('.pl-open').focus();
    await page.keyboard.press('ArrowDown');
    await expect(card(page, 'sg-2')).toHaveClass(/on/);
    await expect(detail.locator('.pl-detail-title')).toHaveText('Lentejas con verduras');
    await page.keyboard.press('ArrowDown');
    await expect(detail.locator('.pl-detail-app')).toContainText('Mantenimiento');
    await page.keyboard.press('ArrowUp');
    await detail.getByRole('button', { name: /^Aprobar:/ }).click();
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta aprobada.');
    await expect(detail.locator('.pl-detail-title')).toHaveText('Pintar la barandilla del porche');
  });

  test('móvil: tocar la tarjeta abre el detalle en una hoja con sus botones', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'hoja del móvil');
    await page.goto('/#proposals');
    await expect(list(page).locator('.pl-detail')).toBeHidden();
    await card(page, 'sg-1').locator('.pl-open').click();
    const sheet = page.locator('.sheetback.show .sheet');
    await expect(sheet).toContainText('Mantenimiento');
    await sheet.getByRole('button', { name: /^Descartar/ }).click();
    await expect(page.locator('.sheetback.show')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toContainText('¿Descartar esta propuesta?');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Propuesta descartada.');
  });

  test('la API va en camelCase y la forma de la 0.33.0 se sigue aceptando', () => {
    const camel = { id: 'a', kind: 'task', summary: 'X', author: { id: 'u', name: 'U' }, createdAt: '2026-10-14T10:00:00Z', status: 'approved' as const, decidedBy: { name: 'S' }, decidedAt: '2026-10-14T11:00:00Z' };
    expect(normalizeProposal(camel)).toBe(camel);
    const legacy = normalizeProposal({ id: 'b', kind: 'dish', summary: 'Y', author: { id: 'u', name: 'U' }, created_at: '2026-10-13T10:00:00Z', status: 'rejected', decided_by: { name: 'D' }, decided_at: '2026-10-13T12:00:00Z' });
    expect(legacy).toMatchObject({ createdAt: '2026-10-13T10:00:00Z', decidedBy: { name: 'D' }, decidedAt: '2026-10-13T12:00:00Z' });
    expect(legacy).not.toHaveProperty('created_at');
  });

  test('adaptador de sugerencias: lista, recuento, decisiones con comentario y errores del contrato con texto claro', async () => {
    const calls: unknown[][] = [];
    const client = {
      async suggestions(o: unknown) { calls.push(['list', o]); return { pendingCount: 7, items: [{ id: 's1', app: 'tasks', kind: 'task', label: 'Tarea', summary: 'Pintar', detail: null, operations: [{ op: 'insert' }], status: 'pending', comment: null, author: { id: 'u', name: 'U' }, decidedBy: null, decidedAt: null, appliedCursor: null, result: null, createdAt: '2026-10-14T10:00:00Z', updatedAt: '2026-10-14T10:00:00Z' }] }; },
      async decideSuggestion(...a: unknown[]) { calls.push(['decide', ...a]); if (a[0] === 'gone') throw Object.assign(new Error('x'), { code: 'SUGGESTION_UNAVAILABLE' }); return {}; },
      async withdrawSuggestion(...a: unknown[]) { calls.push(['withdraw', ...a]); return {}; },
    } as unknown as SyncClient;
    const source = createSuggestionSource(client, { scope: 'pending', app: 'tasks' });
    const items = await source.list();
    expect(calls[0]).toEqual(['list', { scope: 'pending', app: 'tasks' }]);
    expect(items[0]).toMatchObject({ id: 's1', label: 'Tarea', createdAt: '2026-10-14T10:00:00Z' });
    expect(items[0]).not.toHaveProperty('operations');
    expect(source.pendingCount()).toBe(7);
    await source.approve(items[0]!, 'Hecho');
    await source.reject(items[0]!, null);
    await source.withdraw(items[0]!);
    expect(calls.slice(1)).toEqual([['decide', 's1', 'approve', { comment: 'Hecho' }], ['decide', 's1', 'reject', {}], ['withdraw', 's1', { app: 'tasks' }]]);
    await expect(source.approve({ ...items[0]!, id: 'gone' }, null)).rejects.toThrow('Esta propuesta ya no está pendiente.');
    expect(suggestionErrorMessage({ code: 'SUGGESTION_NOT_ALLOWED' })).toBe('No tienes permiso para hacer esto con esta propuesta.');
    expect(suggestionErrorMessage({ code: 'TOO_MANY_SUGGESTIONS' })).toContain('demasiadas propuestas');
    expect(suggestionErrorMessage({ code: 'NETWORK', message: 'fetch' })).toBe('Sin conexión: las propuestas necesitan red.');
    expect(suggestionErrorMessage(Object.assign(new Error('VERSION_CONFLICT en tasks.tasks'), { code: 'VERSION_CONFLICT' }))).toBe('VERSION_CONFLICT en tasks.tasks');
  });

  test('vista previa: cambios del lote con nombres de tabla y campo, sin ids ni metadatos', () => {
    const changes = changesFromPreview([
      { table: 'food.menu_items', id: 'm1', op: 'insert', before: null, after: { id: 'm1', name: 'Lentejas', quick: true, notes: null, revision: 1 } },
      { table: 'tasks.tasks', id: 't1', op: 'update', before: { title: 'Pintar', priority: 1, updated_at: 'a' }, after: { title: 'Pintar', priority: 3, updated_at: 'b' } },
      { table: 'tasks.tasks', id: 't2', op: 'delete', before: { id: 't2' }, after: null },
    ], { tables: { 'food.menu_items': { one: 'plato', many: 'platos' } }, fields: { name: 'Nombre', quick: 'Plato rápido', priority: 'Prioridad' } });
    expect(changes[0]).toEqual({ op: 'insert', table: 'plato', tablePlural: 'platos', title: 'Lentejas', id: 'm1', fields: [{ label: 'Nombre', after: 'Lentejas' }, { label: 'Plato rápido', after: 'Sí' }] });
    expect(changes[1]).toEqual({ op: 'update', table: 'tasks', title: 'Pintar', id: 't1', fields: [{ label: 'Prioridad', before: '1', after: '3' }] });
    expect(changes[2]).toEqual({ op: 'delete', table: 'tasks', title: 'Un registro de tasks', id: 't2' });
  });

  test('sin detalle propio, se ve el antes y después del lote; si otra persona ya decidió, se avisa y desaparece', async ({ page }, info) => {
    await page.goto('/#proposals');
    if (info.project.name === 'escritorio') {
      await card(page, 'sg-2').locator('.pl-open').click();
      await expect(list(page).locator('.pl-detail .changelist')).toContainText('Lentejas con verduras');
      await expect(list(page).locator('.pl-detail .changelist')).toContainText('Plato rápido');
    } else {
      await card(page, 'sg-2').locator('.pl-open').click();
      await expect(page.locator('.sheetback.show .changelist')).toContainText('Plato rápido');
      await page.keyboard.press('Escape');
      await expect(page.locator('.sheetback.show')).toHaveCount(0);
    }
    // Otra persona la aprueba mientras tanto.
    await page.evaluate(() => { const s = (window as unknown as { proposalStore: { id: string; status: string }[] }).proposalStore.find((x) => x.id === 'sg-2')!; s.status = 'approved'; });
    await press(page, info, 'sg-2', 'Aprobar');
    await page.locator('#dialogConfirm').click();
    await expect(page.locator('.toast.show')).toContainText('Esta propuesta ya no está pendiente.');
    await expect(card(page, 'sg-2')).toHaveCount(0);
  });
});
