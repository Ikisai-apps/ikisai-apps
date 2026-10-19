import { expect, test, type Page } from 'playwright/test';

/** Toque real por CDP (como en v39 y v48). */
async function touchSwipe(page: Page, from: { x: number; y: number }, dx: number, dy = 0): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / 10, y: from.y + (dy * i) / 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Tanda 27, lote B2 (MUELA-075): paso a paso, una cosa cada vez, votar deslizando y pregunta a pregunta. */
test.describe('ui-kit v0.44 · piezas compuestas B2', () => {
  test('@smoke paso a paso: lo siguiente en grande con su verbo y minutos, el resto con su estado y lo hecho', async ({ page }) => {
    await page.goto('/#piecesb2');
    const steps = page.locator('#stepsHost .step-box').first();
    await expect(steps.getByRole('heading')).toHaveText('Te quedan 3 cosas');
    await expect(steps.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    await expect(steps.locator('.step-count')).toHaveText('1 de 4 listas');
    const next = steps.locator('.step-next');
    await expect(next).toHaveAttribute('aria-label', 'Revisar la alimentación. Falta decir si tienes alergias · Unos 2 minutos');
    expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await next.click();
    await expect(page.locator('#stepsOpened')).toHaveText('dieta');
    await expect(steps.locator('.step-row')).toHaveCount(2);
    await expect(steps.locator('a.step-row')).toHaveAttribute('href', '#piecesb2');
    await steps.getByRole('button', { name: 'Tus datos' }).click();
    await expect(page.locator('#stepsOpened')).toHaveText('datos');
    const ready = page.locator('#stepsReady');
    await expect(ready).toContainText('¡Todo listo!');
    await expect(ready).toContainText('Nos vemos el 20 de octubre.');
    await expect(ready).toContainText('Hecho: Tus datos · Firma');
  });

  test('@smoke una cosa cada vez: barra por gravedad, acción y siguiente, saltar, deshacer y el final', async ({ page }) => {
    await page.goto('/#piecesb2');
    const q = page.locator('#queueHost');
    await expect(q.locator('.queue-progress strong')).toHaveText('1 de 3');
    await expect(q.locator('.queue-bar span')).toHaveCount(3);
    await expect(q.locator('.queue-card')).toHaveAttribute('data-tone', 'alert');
    await expect(q.locator('.queue-tone')).toHaveText('Vence hoy');
    const main = q.getByRole('button', { name: 'Confirmar y siguiente' });
    expect((await main.boundingBox())!.height).toBeGreaterThanOrEqual(54);
    expect((await q.getByRole('button', { name: 'Saltar' }).boundingBox())!.height).toBeGreaterThanOrEqual(46);
    await expect(q.locator('.queue-more')).toContainText('2 más');
    await main.click();
    await expect(q.locator('.queue-title')).toHaveText('Maderas del Valle');
    await expect(q.locator('.queue-progress strong')).toHaveText('2 de 3');
    await expect(q.locator('.queue-bar span[data-state="done"]')).toHaveCount(1);
    await expect(q.locator('[aria-live="polite"]')).toHaveText('2 de 3: Maderas del Valle');
    await page.locator('.toast.show').getByRole('button', { name: 'Deshacer' }).click();
    await expect(q.locator('.queue-title')).toHaveText('Ferretería Sierra');
    await expect(q.locator('.queue-progress strong')).toHaveText('1 de 3');
    await q.getByRole('button', { name: 'Saltar' }).click();
    await expect(q.locator('.queue-title')).toHaveText('Maderas del Valle');
    await expect(q.getByRole('button', { name: 'Ver el desglose' })).toBeVisible();
    await q.getByRole('button', { name: 'Abrir la ficha' }).click();
    await expect(page.locator('#queueOpened')).toHaveText('f2');
    await q.getByRole('button', { name: 'Ver todo' }).click();
    await expect(page.locator('#queueOpened')).toHaveText('todo');
    for (let i = 0; i < 3; i += 1) await q.getByRole('button', { name: 'Confirmar y siguiente' }).click();
    await expect(q.locator('.queue-done')).toContainText('Has pasado por todo');
    await expect(q.locator('.queue-done')).toContainText('No queda nada por resolver.');
  });

  test('@smoke votar: botones, flechas y deslizar; sellos; al acabar, «Volver a empezar»', async ({ page }, info) => {
    await page.goto('/#piecesb2');
    await page.addStyleTag({ content: '.demo-head{position:static!important}' });
    const v = page.locator('#voteHost');
    await expect(v.locator('.vote-progress')).toHaveText('1 de 3');
    await expect(v.locator('.vote-card:not(.vote-behind)')).toContainText('Silencio después de las 23:00');
    await expect(v.locator('.vote-behind')).toHaveCount(2);
    await v.getByRole('button', { name: 'Se mantiene: votar para que siga' }).click();
    await expect(page.locator('#votesOut')).toHaveText('d1:keep');
    await expect(v.locator('[aria-live="polite"]')).toHaveText('Silencio después de las 23:00: Se mantiene');
    await v.locator('.vote-stack').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#votesOut')).toHaveText('d1:keep, d2:drop');
    await expect(v.locator('.vote-stack')).toBeFocused();
    // Un gesto corto no vota; uno largo a la derecha, sí.
    const stack = v.locator('.vote-stack');
    await stack.scrollIntoViewIfNeeded();
    const box = (await stack.boundingBox())!;
    const y = box.y + box.height / 2;
    const swipe = async (x: number, dx: number) => {
      if (info.project.name === 'movil') { await touchSwipe(page, { x, y }, dx, 4); return; }
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + 4, { steps: 6 }); await page.mouse.up();
    };
    await swipe(box.x + 60, 50);
    await page.waitForTimeout(300);
    await expect(page.locator('#votesOut')).toHaveText('d1:keep, d2:drop');
    await swipe(box.x + 40, 160);
    await expect(page.locator('#votesOut')).toHaveText('d1:keep, d2:drop, d3:keep');
    await expect(v.locator('.vote-empty')).toContainText('Has revisado todas las vigentes');
    await v.getByRole('button', { name: 'Volver a empezar' }).click();
    await expect(v.locator('.vote-card:not(.vote-behind)')).toContainText('Silencio después de las 23:00');
    expect((await v.getByRole('button', { name: /Retirar/ }).boundingBox())!.height).toBeGreaterThanOrEqual(46);
  });

  test('@smoke pregunta a pregunta: solo lo que falta, opción guarda y pasa, texto con Intro, error y Atrás', async ({ page }) => {
    await page.goto('/#piecesb2');
    const a = page.locator('#askHost');
    await expect(a.locator('.ask-meta')).toHaveText('Pregunta 1 de 3');
    await expect(a.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    await expect(a.locator('.ask-question')).toHaveText('¿Qué documento tienes?');
    await a.getByRole('button', { name: /NIE/ }).click();
    await expect(a.locator('.ask-meta')).toHaveText('Pregunta 2 de 3');
    await expect(page.locator('#askOut')).toHaveText('doc=nie');
    const input = a.getByRole('textbox', { name: '¿Cuándo naciste?' });
    await expect(input).toBeFocused();
    await input.fill('1990-01-01');
    await input.press('Enter');
    await expect(a.getByRole('alert')).toHaveText('Revisa la fecha: dd/mm/aaaa.');
    await expect(a.locator('.ask-meta')).toHaveText('Pregunta 2 de 3');
    await a.getByRole('button', { name: 'Atrás' }).click();
    await expect(a.getByRole('button', { name: /NIE/ })).toHaveAttribute('aria-pressed', 'true');
    await a.getByRole('button', { name: /NIE/ }).click();
    await a.getByRole('textbox').fill('01/01/1990');
    await a.getByRole('button', { name: 'Aceptar' }).click();
    await expect(a.locator('.ask-meta')).toHaveText('Pregunta 3 de 3');
    await a.getByRole('button', { name: /Sin gluten/ }).click();
    await a.getByRole('button', { name: /Sin lactosa/ }).click();
    await expect(page.locator('#askOut')).not.toContainText('diet=');
    await a.getByRole('button', { name: 'Aceptar' }).click();
    await expect(a.locator('.ask-done')).toContainText('¡Listo! Ya está todo');
    await expect(page.locator('#askOut')).toContainText('diet=gluten+lact');
    expect((await page.locator('#askOut').textContent())!.startsWith('doc=nie, doc=nie, birth=01/01/1990')).toBe(true);
  });

  test('la página no se sale de lado en el móvil', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'solo en móvil');
    await page.goto('/#piecesb2');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
});
