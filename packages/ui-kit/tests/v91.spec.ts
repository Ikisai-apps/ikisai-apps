import { expect, test } from 'playwright/test';
import { ITEM_ICONS, hasIcon, itemIcon } from '../src/icons.ts';

/** C-06 (Tasks y Recursos): el juego de iconos de artículo. Las claves son las que acepta `resources.items.icon`. */
test('ITEM_ICONS: claves válidas para Recursos, sin repetir, y cada una con su icono en el kit', ({}, info) => {
  test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
  const keys = ITEM_ICONS.map((i) => i.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const i of ITEM_ICONS) {
    expect(i.key).toMatch(/^[a-z][a-z0-9_-]{0,40}$/);
    expect(hasIcon(i.icon)).toBe(true);
  }
  expect(keys).toEqual(expect.arrayContaining(['maquinaria', 'herramienta']));
  expect(itemIcon('grifo')).toBe('faucet');
  expect(itemIcon('no-existe')).toBeNull();
});
