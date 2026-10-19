import { expect, test, type Page } from 'playwright/test';
import { initialsOf } from '../src/pieces/medal.ts';
import { stageStates } from '../src/pieces/stages.ts';
import { worstOf } from '../src/pieces/groups.ts';
import { deadlineInfo, deadlineText } from '../src/fields/deadline.ts';

/** Tanda 27, lote A (MUELA-075): piezas pequeñas sin estado. */
test.describe('ui-kit v0.42 · funciones de las piezas', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta'); });

  test('@smoke iniciales, estados del recorrido y lo peor', () => {
    expect(initialsOf('Ana López')).toBe('AL');
    expect(initialsOf('Casa de la Muela')).toBe('CM');
    expect(initialsOf('Hab 3')).toBe('H3');
    expect(initialsOf('  élite  ')).toBe('É');
    expect(initialsOf('')).toBe('');
    expect(stageStates([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }], 'b')).toEqual(['done', 'here', 'later']);
    expect(stageStates([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], -1)).toEqual(['stop', 'stop']);
    expect(stageStates([{ key: 'a', label: 'A' }], null)).toEqual(['stop']);
    expect(worstOf(['ok', null, 'warn', 'ok'])).toBe('warn');
    expect(worstOf(['warn', 'alert'])).toBe('alert');
    expect(worstOf([null, undefined])).toBeNull();
  });

  test('@smoke plazo: con hora, sin hora, otro año y pasado, en la hora de la casa', () => {
    const now = new Date('2026-10-14T12:20:00+02:00');
    expect(deadlineText('2026-10-14T19:20:00+02:00', { now })).toBe('Antes del mié, 14 oct, 19:20 (quedan 7 h)');
    expect(deadlineText('2026-10-14T13:00:00+02:00', { now })).toBe('Antes del mié, 14 oct, 13:00 (quedan 40 min)');
    expect(deadlineText('2026-10-14T13:30:00+02:00', { now })).toBe('Antes del mié, 14 oct, 13:30 (queda 1 h)');
    expect(deadlineText('2026-10-14', { now })).toBe('Antes del mié, 14 oct (vence hoy)');
    expect(deadlineText('2026-10-15', { now })).toBe('Antes del jue, 15 oct (queda 1 día)');
    expect(deadlineText('2027-01-08', { now })).toBe('Antes del vie, 8 ene 2027 (quedan 86 días)');
    expect(deadlineText('2026-10-13', { now })).toBe('Antes del mar, 13 oct (venció ayer)');
    expect(deadlineText('2026-10-12T09:00:00+02:00', { now })).toBe('Antes del lun, 12 oct, 09:00 (venció hace 2 días)');
    expect(deadlineText('2026-10-14T19:20:00+02:00', { now, prefix: '', noLeft: true })).toBe('mié, 14 oct, 19:20');
    // A las 23:30 en Madrid ya es «mañana» en UTC: cuenta el día de la casa.
    const late = new Date('2026-10-14T23:30:00+02:00');
    expect(deadlineInfo('2026-10-14', { now: late }).left).toBe('vence hoy');
    expect(deadlineInfo('2026-10-14T19:20:00+02:00', { now }).overdue).toBe(false);
  });
});

const pieces = (page: Page) => page.locator('#pieces');

test.describe('ui-kit v0.42 · piezas en la demo', () => {
  test('@smoke medallón: iniciales, color, imagen con nombre y sin cargar vuelve a las iniciales', async ({ page }) => {
    await page.goto('/#pieces');
    const medals = page.locator('#medalsHost .medal-disc');
    await expect(medals).toHaveCount(5);
    await expect(medals.nth(0)).toHaveText('AL');
    await expect(medals.nth(0)).toHaveAttribute('aria-hidden', 'true');
    await expect(medals.nth(1)).toHaveClass(/medal-colored/);
    await expect(page.getByRole('img', { name: 'Foto de la casa' })).toBeVisible();
    expect((await medals.nth(3).boundingBox())!.width).toBe(72);
    await expect(medals.nth(4)).toHaveText('LP');
  });

  test('@smoke recorrido: etapa n de N, aria-current, avisos, tocable, parado y mini', async ({ page }) => {
    await page.goto('/#pieces');
    const journey = page.locator('#stagesHost > .stage-box').first().locator('ol');
    await expect(journey).toHaveAttribute('aria-label', 'Recorrido de la reserva: etapa 3 de 5, Preparación');
    await expect(journey.locator('[aria-current="step"]')).toHaveAttribute('data-stage', 'preparacion');
    await expect(journey.locator('li[data-state="done"]')).toHaveCount(2);
    const step = journey.getByRole('button', { name: 'Preparación: ahora, con avisos' });
    expect((await step.boundingBox())!.height).toBeGreaterThanOrEqual(64);
    await journey.getByRole('button', { name: 'Señal: hecho' }).click();
    await expect(page.locator('#stagePicked')).toHaveText('senal');
    // Sin onPick no hay botones; el estado se lee igual.
    await expect(page.locator('#stagesStatic button')).toHaveCount(0);
    await expect(page.locator('#stagesStatic li[aria-current="step"]')).toContainText('Señal: ahora');
    await expect(page.locator('#stagesStopped ol')).toHaveAttribute('aria-label', 'Recorrido de la reserva: parado');
    await expect(page.locator('#stagesStopped')).toContainText('Cancelada: el recorrido se paró.');
    await expect(page.locator('#stagesMini .stage-label').first()).toHaveClass(/vh/);
  });

  test('@smoke grupos: lo peor primero, resumen escrito, abiertos los que piden algo y chips', async ({ page }) => {
    await page.goto('/#pieces');
    const groups = page.locator('#groupsHost .worst-group');
    await expect(groups.nth(0)).toHaveAttribute('data-group', 'fiscal');
    await expect(groups.nth(0)).toHaveAttribute('data-tone', 'alert');
    await expect(groups.nth(0).locator('.worst-summary')).toHaveText('1 vencida · 1 vence pronto');
    await expect(groups.nth(0).locator('details')).toHaveAttribute('open', '');
    await expect(groups.nth(1).locator('.worst-summary')).toHaveText('Todo en orden');
    await expect(groups.nth(1).locator('details')).not.toHaveAttribute('open', '');
    await expect(groups.nth(0)).toContainText('Antes del mar, 20 oct (queda 1 día)');
    await page.locator('#groupsHost').getByRole('button', { name: 'Con alerta (1)' }).click();
    await expect(page.locator('#groupsHost .worst-group:visible')).toHaveCount(1);
    await page.locator('#groupsHost').getByRole('button', { name: 'Todos (3)' }).click();
    await expect(page.locator('#groupsHost .worst-group:visible')).toHaveCount(3);
  });

  test('cifras con su etiqueta, comprobaciones con veredicto y baldosas con el nivel escrito', async ({ page }) => {
    await page.goto('/#pieces');
    await expect(page.locator('#statsHost .stat-item')).toHaveCount(4);
    await expect(page.locator('#statsHost .stat-item[data-tone="alert"]')).toContainText('Vencidas');
    const overdue = page.locator('#statsHost').getByRole('button', { name: /Vencidas/ });
    expect((await overdue.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    const checks = page.locator('#checksHost .check-box').first();
    await expect(checks.getByRole('status')).toHaveText(/2 cosas por resolver/);
    await expect(checks.locator('.check-item[data-ok="false"]').first()).toContainText('Falta: Falta la fecha');
    expect((await checks.getByRole('button', { name: 'Completar' }).boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await expect(page.locator('#checksHost .check-box').nth(1).getByRole('status')).toHaveText(/Todo en regla/);
    const harina = page.locator('#tilesHost').getByRole('button', { name: /Harina/ });
    await expect(harina).toContainText('Queda poco');
    await expect(harina).toHaveAttribute('data-tone', 'alert');
    await expect(harina.locator('.tile-fill')).toHaveAttribute('style', 'height:18%');
    await expect(page.locator('#tilesHost .tile-box').nth(2)).not.toHaveAttribute('type', 'button');
  });

  test('@smoke sin red: el botón se apaga con su motivo y «Reintentar»; lo que va con la cola, no', async ({ page }) => {
    await page.goto('/#pieces');
    const send = page.locator('#onlineSend');
    await expect(send).not.toHaveAttribute('aria-disabled', 'true');
    await page.locator('#onlineToggle').click();
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    const why = page.locator('#onlineHost .offline-why');
    await expect(why).toBeVisible();
    await expect(why).toContainText('Enviar a la gestoría necesita conexión.');
    await expect(send).toHaveAttribute('aria-describedby', (await why.getAttribute('id'))!);
    await send.click({ force: true });
    await expect(page.locator('.toast.show')).toHaveCount(0);
    await why.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.locator('.toast.show')).toHaveText('Reintentando…');
    await expect(page.locator('#onlineLocal')).not.toHaveAttribute('aria-disabled', 'true');
    await page.locator('#onlineToggle').click();
    await expect(send).not.toHaveAttribute('aria-disabled', 'true');
    await expect(why).toBeHidden();
    await expect(send).not.toHaveAttribute('aria-describedby', /.+/);
  });

  test('etapas con su cifra: tira en el móvil, columnas con lo que cuenta en escritorio', async ({ page }, info) => {
    await page.goto('/#pieces');
    const strip = page.locator('#areaColumns .tabstrip');
    await expect(strip).toHaveClass(/columns/);
    await expect(strip.getByRole('button', { name: /Señal/ }).locator('.tabcount')).toHaveAttribute('aria-label', '2 por cobrar');
    const text = strip.locator('.tabcount-text').first();
    if (info.project.name === 'escritorio') {
      await expect(text).toBeVisible();
      const boxes = await strip.locator('.tabpill').evaluateAll((n) => n.map((x) => x.getBoundingClientRect().width));
      expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(2);
    } else {
      await expect(text).toBeHidden();
      expect(await strip.evaluate((n) => getComputedStyle(n).display)).toBe('flex');
    }
  });

  test('la sección no se sale de lado en el móvil', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'solo en móvil');
    await page.goto('/#pieces');
    expect(await pieces(page).evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    // La página entera tampoco: una tira ancha desplazaba los toques de toda la demo.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});
