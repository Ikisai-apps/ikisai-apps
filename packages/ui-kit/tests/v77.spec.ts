import { expect, test } from 'playwright/test';
import { formatFindings, mobileAudit } from '../testing/mobile-audit.ts';

/** `testing/mobile-audit.ts`: la revisión móvil del 27-10 como ayuda de pruebas para todas las apps. */
test.describe('ui-kit v0.69.5 · mobileAudit (revisión móvil en las pruebas de las apps)', () => {
  test('encuentra desborde, toques pequeños, texto cortado y poco contraste en oscuro; no cuenta lo del lector', async ({ page }, info) => {
    test.skip(info.project.name !== 'movil', 'es la revisión del móvil');
    await page.goto('/');
    await page.evaluate(() => {
      document.head.insertAdjacentHTML('beforeend', `<style>
        body{margin:0;background:#fff;color:#111}
        .big{min-height:44px;min-width:44px}
        .wide{width:600px;height:10px;background:#ccc}
        .cut{width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .scroller{overflow-x:auto;width:200px}.scroller div{width:600px}
        .vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
        @media (prefers-color-scheme:dark){body{background:#1a1915;color:#eee}a{color:#9cc3ff}.dim{color:#2a2925}}
      </style>`);
      document.body.innerHTML = `
        <button class="big">Bien</button>
        <button id="tiny" style="height:30px">Pequeño</button>
        <label style="display:block;min-height:44px"><input type="checkbox"> Casilla con etiqueta grande</label>
        <p>Un <a href="#x">enlace en un párrafo</a> no es un botón.</p>
        <div class="wide" id="wide"></div>
        <div class="scroller"><div>Dentro de su propio scroll</div></div>
        <div class="cut" id="cut">Un texto bastante largo que no cabe</div>
        <span class="vh">Solo para el lector, aunque no quepa</span>
        <button class="vh">Botón del lector</button>
        <p class="dim">Casi invisible en oscuro</p>
        <p class="ignorada" style="width:60px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Cortado a sabiendas</p>`;
    });
    const found = await mobileAudit(page, { ignore: ['.ignorada'] });
    const by = (k: string) => found.filter((f) => f.kind === k).map((f) => f.sel);
    expect(by('desborde')).toEqual(expect.arrayContaining(['html', 'div#wide.wide']));
    expect(by('desborde')).not.toContain('div');
    expect(by('toque')).toEqual(['button#tiny']);
    expect(by('cortado')).toEqual(['div#cut.cut']);
    expect(by('contraste')).toEqual(['p.dim']);
    expect(formatFindings(found.filter((f) => f.kind === 'toque'))).toBe('toque · button#tiny «Pequeño» · 75×30 px'.replace('75', String(Math.round((await page.locator('#tiny').boundingBox())!.width))));
    // Vuelve a claro al acabar.
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(false);
    // Solo lo pedido.
    expect((await mobileAudit(page, { kinds: ['toque'] })).map((f) => f.kind)).toEqual(['toque']);
  });
});
