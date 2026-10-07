/**
 * Booking · «Sugerencias y QA»: los `data-feedback-id` del código tienen la forma estable `booking.<pantalla>.<sección>.<elemento>`
 * (minúsculas, sin acentos, de uno a cuatro niveles) y no llevan identificadores de negocio (uuid). Es una comprobación estática
 * del código fuente: no abre el navegador. El recorrido real está en `feedback.spec.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../apps/booking/src');
const PATTERN = /^booking(\.[a-z0-9_]+){1,4}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Cadenas `booking.…` del código que no son ids de feedback (claves de almacenamiento). */
const NOT_IDS = new Set(['booking.proposalMarks']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : [];
  });
}

interface Found { id: string; file: string; line: number; dynamic: boolean }

function collect(): Found[] {
  const found: Found[] = [];
  for (const file of sources(path.join(SRC, 'ui'))) {
    // Sin comentarios: la documentación cita la forma del id (`booking.<pantalla>…`) y no es un id.
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
    const rel = path.relative(SRC, file).replaceAll('\\', '/');
    // Cualquier literal «booking.…» del código de pantallas (atributos, mapas de ids, bases de formulario, fbMark).
    for (const match of text.matchAll(/(['"`])(booking\.[^'"`\n]*)\1/g)) {
      const id = match[2]!;
      if (NOT_IDS.has(id)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      found.push({ id, file: rel, line, dynamic: id.includes('${') });
    }
  }
  return found;
}

test('todos los data-feedback-id de Booking cumplen el patrón y no llevan uuids', () => {
  const found = collect();
  // La instrumentación existe de verdad (no es una prueba vacía).
  assert.ok(found.length >= 300, `se esperaban muchos ids y hay ${found.length}`);
  const bad: string[] = [];
  for (const { id, file, line, dynamic } of found) {
    // Un id con parte dinámica (`booking.reservas.alta.${key}`) se valida con un tramo final de ejemplo.
    const concrete = dynamic ? id.replace(/\$\{[^}]*\}/g, 'x') : id;
    if (!PATTERN.test(concrete)) bad.push(`${file}:${line} «${id}» no cumple ${PATTERN}`);
    if (UUID.test(id)) bad.push(`${file}:${line} «${id}» lleva un uuid`);
    if (/[A-Z]/.test(id.replace(/\$\{[^}]*\}/g, ''))) bad.push(`${file}:${line} «${id}» lleva mayúsculas`);
  }
  assert.deepEqual(bad, []);
});

test('las bases de formulario dejan sitio para el campo (como mucho tres niveles) y cada atributo lleva su etiqueta', () => {
  const bad: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(SRC, file).replaceAll('\\', '/');
    for (const match of text.matchAll(/feedbackId:\s*([^,]+),/g)) {
      for (const id of match[1]!.matchAll(/'(booking\.[^']+)'/g)) {
        if (id[1]!.split('.').length - 1 > 3) bad.push(`${rel}: base «${id[1]}» sin sitio para el campo`);
      }
    }
    // Cada `'data-feedback-id'` escrito en un `el(...)` lleva su `'data-feedback-label'` en la misma llamada.
    const ids = (text.match(/'data-feedback-id':/g) ?? []).length;
    const labels = (text.match(/'data-feedback-label':/g) ?? []).length;
    if (ids !== labels) bad.push(`${rel}: ${ids} data-feedback-id y ${labels} data-feedback-label`);
  }
  assert.deepEqual(bad, []);
});

test('la raíz de cada id es una pantalla o una pieza de la cáscara conocida', () => {
  const roots = new Set(collect().filter((f) => !f.dynamic).map((f) => f.id.split('.')[1]));
  const allowed = new Set([
    'inicio', 'reservas', 'reserva', 'huespedes', 'calendario', 'espacios', 'tarifas', 'propuesta', 'ses', 'pendientes', 'cabecera', 'navegacion', 'avisos',
  ]);
  assert.deepEqual([...roots].filter((root) => !allowed.has(root!)), []);
});
