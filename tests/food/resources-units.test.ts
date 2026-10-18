/**
 * Food · conversiones a la unidad base del artículo: el dominio de Food (`itemUnitFactor`, que usa también la Edge y
 * no puede importar el kit) da lo mismo que `unitsFor` + `baseQuantity` del kit, que es lo que usa Finance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseQuantity, unitsFor, type ItemRow } from '../../packages/ui-kit/src/items/model.ts';
import { itemUnitFactor, toItemBase, type ItemConversion } from '../../supabase/functions/_domain/food/mod.ts';

const item = (id: string, baseUnit: string): ItemRow => ({
  id, name: id, kind: 'ingrediente', category: null, baseUnit, minQuantity: null, reorderQuantity: null, defaultSpaceId: null, defaultSupplierId: null,
  tracksLots: false, tracksExpiry: false, aliases: [], attributes: {}, active: true,
} as unknown as ItemRow);

test('conversiones · iguales que las del kit: base, métricas y conversiones sin proveedor', () => {
  const conversions: ItemConversion[] = [
    { item_id: 'tomate', unit: 'unidad', factor: 0.15, supplier_id: null },
    { item_id: 'harina', unit: 'paquete', factor: 1, supplier_id: null },
    { item_id: 'harina', unit: 'saco', factor: 25, supplier_id: 'proveedor-x' },
    { item_id: 'huevos', unit: 'ud', factor: 1, supplier_id: null },
  ];
  const kit = (itemId: string, base: string, unit: string, quantity: number) => {
    const options = unitsFor(item(itemId, base), conversions.map((c) => ({ id: `${c.item_id}:${c.unit}`, itemId: c.item_id, unit: c.unit, factor: Number(c.factor), supplierId: c.supplier_id ?? null })));
    const option = options.find((o) => o.unit === unit);
    return option ? baseQuantity(quantity, option.value, options) : null;
  };
  const cases: Array<[string, string, Parameters<typeof itemUnitFactor>[0], string, number]> = [
    ['arroz', 'kg', 'g', 'g', 800],
    ['arroz', 'kg', 'kg', 'kg', 2],
    ['aceite', 'l', 'ml', 'ml', 250],
    ['tomate', 'kg', 'unidad', 'unidad', 4],
    ['harina', 'kg', 'paquete', 'paquete', 3],
  ];
  for (const [id, base, unit, kitUnit, quantity] of cases) {
    assert.equal(toItemBase(quantity, unit, base, id, conversions), kit(id, base, kitUnit, quantity), `${quantity} ${unit} de ${id}`);
  }
  // «unidad» de Food es «ud» en Recursos, como base y como conversión.
  assert.equal(toItemBase(6, 'unidad', 'ud', 'pimiento'), 6);
  assert.equal(itemUnitFactor('unidad', 'kg', 'huevos', conversions), 1);
  // Las conversiones de un proveedor no valen para la cocina; sin conversión, no se puede.
  assert.equal(itemUnitFactor('otro', 'kg', 'harina', conversions), null);
  assert.equal(itemUnitFactor('manojo', 'g', 'perejil', conversions), null);
});
