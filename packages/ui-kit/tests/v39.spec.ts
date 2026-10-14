import { expect, test, type Page } from 'playwright/test';

const host = (page: Page) => page.locator('#personCalHost');
/** Día `n` (1, 2…) del mes visible. */
const day = (page: Page, n: number) => host(page).locator('.cal-day:not(.outside)').nth(n - 1);
const bar = (page: Page) => host(page).locator('.cal-selectbar');

test.describe('ui-kit v0.33 · calendario de persona (O2 y O4)', () => {
  test('@smoke el calendario de Booking sigue igual y el nombre corto sale solo en el primer día de cada tramo', async ({ page }) => {
    await page.goto('/#calendar');
    const cal = page.locator('#calendarHost .calendar');
    await expect(cal.locator('.cal-day.today')).toHaveCount(1);
    await expect(cal.locator('.cal-legend, .cal-agenda, .cal-selectbar, .cal-note-mark, .cal-day.shaded')).toHaveCount(0);
    const spans = await cal.locator('.cal-event[data-event-id="r1"]').evaluateAll((nodes) => nodes.map((n) => ({
      starts: n.classList.contains('starts'),
      weekStart: n.closest('.cal-day') === n.closest('.cal-week')?.firstElementChild,
      abbr: n.querySelector<HTMLElement>('.cal-event-text')!.dataset.abbr,
      bar: (n as HTMLElement).dataset.abbr,
    })));
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) {
      expect(s.bar).toBe('Ortega');
      expect(s.abbr).toBe(s.starts || s.weekStart ? 'Ortega' : '');
    }
  });

  test('capas con leyenda: apagar «Mis estancias» las quita del mes y del panel', async ({ page }) => {
    await page.goto('/#personcal');
    const legend = host(page).locator('.cal-legend');
    await expect(legend.locator('.cal-layer')).toHaveCount(3);
    await expect(legend.locator('.cal-legend-shade')).toHaveText('Hay alguien');
    await expect(host(page).locator('.cal-event[data-event-id="est-1"]').first()).toBeVisible();
    await expect(legend.locator('.cal-layer[data-layer="abierto"] .cal-swatch')).toHaveClass(/outline/);
    const stays = legend.locator('.cal-layer[data-layer="estancia"]');
    await stays.click();
    await expect(stays).toHaveAttribute('aria-pressed', 'false');
    await expect(host(page).locator('.cal-event[data-event-id="est-1"]')).toHaveCount(0);
    await expect(host(page).locator('.cal-agenda')).not.toContainText('Mi estancia');
    await stays.click();
    await expect(host(page).locator('.cal-event[data-event-id="est-1"]').first()).toBeVisible();
  });

  test('sombreado y notas: se leen en la etiqueta del día y en el panel del día', async ({ page }) => {
    await page.goto('/#personcal');
    const today = host(page).locator('.cal-day.today');
    await expect(today).toHaveClass(/shaded/);
    await expect(today).toHaveClass(/noted/);
    await expect(today).toHaveAttribute('aria-label', /hay alguien del staff|Hay alguien del staff/);
    await expect(today).toHaveAttribute('aria-label', /1 nota/);
    const agenda = host(page).locator('.cal-agenda');
    await expect(agenda.locator('.cal-agenda-title')).not.toBeEmpty();
    await expect(agenda).toContainText('Mi estancia');
    await expect(agenda).toContainText('Hay alguien del staff');
    await expect(agenda.locator('.cal-agenda-note')).toContainText('18:00');
    await expect(agenda.locator('.cal-agenda-note')).toContainText('Llego en el tren');
    // Otro día: el panel cambia y la app pone sus botones.
    await day(page, 15).click();
    await expect(day(page, 15)).toHaveClass(/picked/);
    await expect(agenda.getByRole('button', { name: 'Añadir nota' })).toBeVisible();
  });

  test('@smoke nueva estancia con dos toques: primer día, último día y guardar', async ({ page }) => {
    await page.goto('/#personcal');
    await page.locator('#newStay').click();
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).toContainText('Toca el primer día');
    await expect(bar(page).getByRole('button', { name: 'Guardar estancia' })).toBeDisabled();
    await day(page, 10).click();
    await expect(bar(page)).toContainText('ahora toca el último día');
    await day(page, 12).click();
    await expect(bar(page)).toContainText('Del ');
    await expect(bar(page)).toContainText('3 días · Hab 3, cama 1');
    await expect(day(page, 11)).toHaveClass(/in-range/);
    await expect(day(page, 10)).toHaveClass(/range-start/);
    await expect(day(page, 12)).toHaveClass(/range-end/);
    await bar(page).getByRole('button', { name: 'Guardar estancia' }).click();
    await expect(page.locator('.toast.show')).toContainText('Estancia guardada');
    await expect(bar(page)).toBeHidden();
    await expect(day(page, 11).locator('.cal-event[data-layer="estancia"]:not([data-event-id="est-1"])')).toHaveCount(1);
    await expect(host(page).locator('.cal-day.in-range')).toHaveCount(0);
  });

  test('con teclado: Intro en el primero, flechas e Intro en el último; Esc cancela', async ({ page }) => {
    await page.goto('/#personcal');
    await page.locator('#newStay').click();
    await day(page, 10).focus();
    await page.keyboard.press('Enter');
    await expect(bar(page)).toContainText('ahora toca el último día');
    await expect(host(page).locator('.cal-live')).toContainText('Primer día');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(day(page, 11)).toHaveClass(/in-range/);
    await page.keyboard.press('Enter');
    await expect(bar(page)).toContainText('3 días');
    await expect(host(page).locator('.cal-live')).toContainText('Guardar estancia');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect(host(page).locator('.cal-live')).toContainText('cancelada');
  });

  test('«Cambiar fechas» entra con el rango marcado y guarda el nuevo', async ({ page }) => {
    await page.goto('/#personcal');
    await host(page).locator('.cal-agenda').getByRole('button', { name: 'Cambiar fechas' }).click();
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).toContainText('4 días');
    await expect(bar(page).getByRole('button', { name: 'Guardar estancia' })).toBeEnabled();
    await day(page, 20).click();
    await day(page, 21).click();
    await expect(bar(page)).toContainText('2 días');
    await bar(page).getByRole('button', { name: 'Guardar estancia' }).click();
    await expect(page.locator('.toast.show')).toContainText('Estancia cambiada');
    await expect(day(page, 20).locator('.cal-event[data-event-id="est-1"]')).toHaveCount(1);
  });

  test('en escritorio también se arrastra de un día a otro', async ({ page }, info) => {
    test.skip(info.project.name !== 'escritorio', 'arrastre con ratón');
    await page.goto('/#personcal');
    await page.locator('#newStay').click();
    await day(page, 13).scrollIntoViewIfNeeded();
    await day(page, 10).scrollIntoViewIfNeeded();
    const a = (await day(page, 10).boundingBox())!;
    const b = (await day(page, 13).boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width, a.y + a.height / 2, { steps: 4 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(bar(page)).toContainText('4 días');
    await expect(day(page, 12)).toHaveClass(/in-range/);
  });

  test('en el móvil se cambia de mes deslizando a los lados', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'gesto táctil');
    await page.goto('/#personcal');
    const title = host(page).locator('.cal-title');
    const before = await title.innerText();
    await host(page).locator('.cal-grid').evaluate((grid) => {
      const r = grid.getBoundingClientRect();
      const y = r.top + r.height / 2;
      grid.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: r.right - 20, clientY: y, bubbles: true }));
      document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', clientX: r.left + 20, clientY: y + 5, bubbles: true }));
    });
    await expect(title).not.toHaveText(before);
  });
});
