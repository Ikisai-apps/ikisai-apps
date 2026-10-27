import { expect, test } from 'playwright/test';
// @ts-expect-error: script de Node sin tipos.
import { extractFields } from '../scripts/feature-catalog.mjs';

/** Inventario de campos: lo que no es un dato (buscador, filtro, selección) se marca con NOT_A_FIELD y no se pide. */
test('data-field-none y NOT_A_FIELD sacan el control de «sin instrumentar»; un input sin nada sigue saliendo', ({}, info) => {
  test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
  const code = [
    "el('input', { type: 'search', 'aria-label': 'Buscar', ...NOT_A_FIELD })",
    "el('select', { 'data-field-none': '', 'aria-label': 'Filtrar' })",
    "el('input', { type: 'text', 'aria-label': 'Nombre' })",
    '// ayudante genérico: el campo lo declara quien llama (@field-caller)',
    "const box = (mark: object) => el('input', { type: 'text', 'aria-label': 'Ayudante', ...mark });",
    "const box2 = (mark: object) => el('textarea', { 'aria-label': 'Ayudante 2', ...mark }); // @field-caller",
  ].join('\n');
  const html = '<input type="checkbox" data-field-none aria-label="Elegir fila"><textarea aria-label="Nota"></textarea>';
  const a = extractFields(code, 'apps/demo/src/x.ts', 'demo');
  const b = extractFields(html, 'apps/demo/index.html', 'demo');
  expect(a.uninstrumented.map((u: { label: string }) => u.label)).toEqual(['Nombre']);
  expect(b.uninstrumented.map((u: { label: string }) => u.label)).toEqual(['Nota']);
});

test('storage device/none: declarado sin entity a propósito; el informe no lo cuenta como «sin entidad»', ({}, info) => {
  test.skip(info.project.name !== 'escritorio', 'funciones puras: una vez basta');
  const code = [
    "el('input', { ...fieldAttrs({ id: 'demo.diseno.margen', storage: 'device' }) })",
    "el('input', { ...fieldAttrs({ id: 'demo.entrada.codigo', storage: 'none' }) })",
    "el('input', { ...fieldAttrs({ id: 'demo.ficha.nombre' }) })",
  ].join('\n');
  const { fields } = extractFields(code, 'apps/demo/src/x.ts', 'demo');
  expect(fields.map((f: { fieldId: string; storage?: string }) => [f.fieldId, f.storage ?? null])).toEqual([
    ['demo.diseno.margen', 'device'], ['demo.entrada.codigo', 'none'], ['demo.ficha.nombre', null]]);
});
