/** Central · lector de SVG de «Colocar solo» (tanda 37, MUELA-092): la matriz completa y lo que no se puede leer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeContent, generatedName, parseTransform } from '../../apps/central/src/app/svg-plan.ts';

const close = (m: number[] | null, want: number[]) => {
  assert.ok(m, 'se lee');
  m!.forEach((v, i) => assert.ok(Math.abs(v - want[i]!) < 1e-9, `${i}: ${v} ≠ ${want[i]}`));
};

test('svg · translate, scale, rotate (con centro), skewX, skewY y matrix, encadenadas', () => {
  close(parseTransform(null), [1, 0, 0, 1, 0, 0]);
  close(parseTransform('translate(10 20) scale(2)'), [2, 0, 0, 2, 10, 20]);
  close(parseTransform('rotate(90)'), [0, 1, -1, 0, 0, 0]);
  // Girar 90° sobre (200,150): el punto (100,100) va a (250,50).
  const m = parseTransform('rotate(90 200 150)')!;
  close([m[0] * 100 + m[2] * 100 + m[4], m[1] * 100 + m[3] * 100 + m[5]], [250, 50]);
  close(parseTransform('skewX(45)'), [1, 0, 1, 1, 0, 0]);
  close(parseTransform('skewY(45)'), [1, 1, 0, 1, 0, 0]);
  close(parseTransform('matrix(1,0,0,1,5,6), translate(1)'), [1, 0, 0, 1, 6, 6]);
});

test('svg · lo que no se sabe leer no se coloca (null)', () => {
  assert.equal(parseTransform('rotate(10deg)'), null);
  assert.equal(parseTransform('perspective(3)'), null);
  assert.equal(parseTransform('translate(1 2) y algo'), null);
  assert.equal(parseTransform('rotate(1 2)'), null);
});

test('svg · nombres del programa de dibujo y contenido activo', () => {
  for (const n of ['layer1', 'Capa 1', 'rect123', 'g45', 'path-9']) assert.ok(generatedName(n), n);
  for (const n of ['Cocina', 'Dormitorio_3', 'Galería']) assert.ok(!generatedName(n), n);
  assert.equal(activeContent('<svg xmlns="http://www.w3.org/2000/svg"><rect id="Salón"/></svg>'), null);
  assert.equal(activeContent('<svg><script>x</script></svg>'), 'elemento');
  assert.equal(activeContent('<svg onload="x"></svg>'), 'manejador');
  assert.equal(activeContent('<svg><a href="java&#x09;script:x"/></svg>'), 'enlace');
});
