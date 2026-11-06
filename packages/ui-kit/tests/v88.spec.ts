import { expect, test } from 'playwright/test';

/** K-05: con `files` (el cliente de la app), el mapa pide él el enlace firmado del dibujo; `planUrl` sigue mandando si se da. */
test('createSpaceMap({ files }) pinta el dibujo con el enlace de fileUrl; planUrl manda', async ({ page }) => {
  await page.goto('/');
  const hrefs = await page.evaluate(async () => {
    const K = (window as any).ikisaiKit;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const rows = [{ id: 'finca', parentId: null, kind: 'exterior', name: 'Finca', publicName: null, code: null, position: 0, active: true, notes: null, attributes: {}, planId: null, planShape: null },
      { id: 'sala', parentId: 'finca', kind: 'sala', name: 'Sala', publicName: null, code: null, position: 1, active: true, notes: null, attributes: {}, planId: 'p1', planShape: { points: [[0.1, 0.1], [0.6, 0.1], [0.6, 0.6], [0.1, 0.6]] } }];
    const plans = [{ id: 'p1', buildingId: 'finca', floor: null, position: 0, fileId: 'f1', width: 100, height: 100 }];
    const asked: string[] = [];
    const draw = async (opts: object) => {
      const map = K.createSpaceMap({ source: K.createMemorySpaceSource(rows), plans, plan: 'p1', ...opts });
      document.body.replaceChildren(map.element);
      await new Promise((r) => setTimeout(r, 50));
      return document.querySelector('.map-bg')?.getAttribute('href') ?? null;
    };
    const a = await draw({ files: { fileUrl: async (id: string) => { asked.push(id); return png; } } });
    const b = await draw({ files: { fileUrl: async () => 'blob:mal' }, planUrl: () => png });
    return { a: a === png, b: b === png, asked };
  });
  expect(hrefs).toEqual({ a: true, b: true, asked: ['f1'] });
});
