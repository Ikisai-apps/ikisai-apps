import { expect, test } from 'playwright/test';
import { hasIcon } from '../src/icons.ts';

/** K13 (KIT_PETICIONES): iconos de comida en el kit, para Food y para quien enseñe el régimen de comidas (Booking, Guests). */
const FOOD = ['cup', 'bowl', 'plate', 'leaf', 'cake', 'basket', 'cookie', 'glass', 'jar', 'timer', 'pot', 'noGluten', 'noLactose', 'noNuts', 'vegan', 'cheese', 'drumstick', 'chefHat', 'fish'];

test('ui-kit v0.69.10 · K13: los iconos de comida están en el kit', ({}, info) => {
  test.skip(info.project.name !== 'escritorio', 'función pura: una vez basta');
  expect(FOOD.filter((name) => !hasIcon(name))).toEqual([]);
});
