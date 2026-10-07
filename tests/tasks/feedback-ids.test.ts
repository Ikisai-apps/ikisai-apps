/**
 * Tasks · «Sugerencias y QA» y catálogo de «Uso»: los `data-feedback-id` (y `feedbackId:` de los mapas) y los
 * `usage.run/track` del código de la interfaz tienen la forma estable `tasks.<pantalla>.<sección>.<elemento>`
 * (minúsculas, sin acentos, de uno a cuatro niveles), son literales (el catálogo se saca leyendo el código) y no llevan
 * identificadores de negocio. Comprobación estática: no abre el navegador. El recorrido real está en `feedback.spec.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, '../../apps/tasks/public');
const PATTERN = /^tasks(\.[a-z0-9_]+){1,4}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface Found { id: string; file: string; line: number; kind: 'mark' | 'usage' }

function collect(): Found[] {
  const files = readdirSync(PUBLIC).filter((name) => (name.endsWith('.js') || name === 'index.html') && name !== 'sw.js');
  const found: Found[] = [];
  for (const name of files) {
    // Sin comentarios: la documentación cita la forma del id y no es un id.
    const text = readFileSync(path.join(PUBLIC, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
    const at = (index: number) => text.slice(0, index).split('\n').length;
    for (const m of text.matchAll(/(?:data-feedback-id|feedbackId)['"]?\s*[:=]\s*(['"`])([^'"`]*)\1/g)) found.push({ id: m[2]!, file: name, line: at(m.index!), kind: 'mark' });
    for (const m of text.matchAll(/\busage\s*\.\s*(?:run|track)\s*\(\s*(['"`])([^'"`]*)\1/g)) found.push({ id: m[2]!, file: name, line: at(m.index!), kind: 'usage' });
  }
  return found;
}

test('todos los ids de feedback y uso de Tasks cumplen el patrón, son literales y no llevan ids de negocio', () => {
  const found = collect();
  assert.ok(found.filter((f) => f.kind === 'mark').length >= 300, `se esperaban muchas marcas y hay ${found.filter((f) => f.kind === 'mark').length}`);
  assert.ok(found.filter((f) => f.kind === 'usage').length >= 8, 'las operaciones importantes cuentan su uso');
  const bad = found.filter(({ id }) => !PATTERN.test(id) || id.includes('${') || UUID.test(id)).map(({ id, file, line }) => `${file}:${line} ${id}`);
  assert.deepEqual(bad, []);
});

test('ningún elemento lleva a la vez data-feedback-id y data-feedback-ignore', () => {
  const clash: string[] = [];
  for (const name of readdirSync(PUBLIC).filter((n) => n.endsWith('.js') || n === 'index.html')) {
    const text = readFileSync(path.join(PUBLIC, name), 'utf8');
    for (const m of text.matchAll(/<[a-z][^<>]*>/g)) if (m[0].includes('data-feedback-id') && /data-feedback-ignore/.test(m[0])) clash.push(`${name}: ${m[0].slice(0, 80)}`);
  }
  assert.deepEqual(clash, []);
});
