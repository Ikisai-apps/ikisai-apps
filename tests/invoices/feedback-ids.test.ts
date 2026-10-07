/**
 * Finance · «Sugerencias y QA» y catálogo de «Uso»: los `data-feedback-id` y los `usage.run/track` del código tienen la forma
 * estable `invoices.<pantalla>.<sección>.<elemento>` (minúsculas, sin acentos, de uno a cuatro niveles tras `invoices`) y no
 * llevan identificadores de negocio. Comprobación estática del código fuente; el recorrido real está en la prueba de pantalla.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../apps/invoices/src');
const PATTERN = /^invoices(\.[a-z0-9_]+){1,4}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** Cadenas `invoices.…` del código que no son ids de feedback: procedimientos, lecturas y tablas del servidor. */
const NOT_IDS = /^invoices\.(issue|rectify|annul|annul_issued|validate|import_v1|create_export|mark_delivered|archive_period|close_series|take_issuer|vf_records_of|document_text|[a-z_]+_summary|customers|issued_[a-z_]+|invoices|suppliers|allocations|invoice_[a-z_]+|tax_lines|exports|export_items|supplier_templates)$/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : [];
  });
}

interface Found { id: string; file: string; line: number }

function collect(): Found[] {
  const found: Found[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
    const rel = path.relative(SRC, file).replaceAll('\\', '/');
    for (const match of text.matchAll(/(['"`])(invoices\.[^'"`\n]*)\1/g)) {
      const id = match[2]!;
      if (NOT_IDS.test(id)) continue;
      found.push({ id, file: rel, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return found;
}

test('todos los ids de Finance cumplen el patrón, sin uuids ni partes dinámicas', () => {
  const found = collect();
  assert.ok(found.length >= 250, `se esperaban muchos ids y hay ${found.length}`);
  const bad: string[] = [];
  for (const { id, file, line } of found) {
    if (id.includes('${')) bad.push(`${file}:${line} «${id}» es dinámico: el catálogo de «Uso» necesita el id literal`);
    else if (!PATTERN.test(id)) bad.push(`${file}:${line} «${id}» no cumple ${PATTERN}`);
    if (UUID.test(id)) bad.push(`${file}:${line} «${id}» lleva un uuid`);
  }
  assert.deepEqual(bad, []);
});

test('cada data-feedback-id escrito en un el(...) lleva su etiqueta, y cada marca de nodo del kit también', () => {
  const bad: string[] = [];
  for (const file of sources(path.join(SRC, 'ui'))) {
    const text = readFileSync(file, 'utf8');
    const rel = path.relative(SRC, file).replaceAll('\\', '/');
    const ids = (text.match(/'data-feedback-id':/g) ?? []).length;
    const labels = (text.match(/'data-feedback-label':/g) ?? []).length;
    if (ids !== labels) bad.push(`${rel}: ${ids} data-feedback-id y ${labels} data-feedback-label`);
    const marks = (text.match(/feedbackId: '/g) ?? []).length;
    const markLabels = (text.match(/feedbackLabel: '/g) ?? []).length;
    if (marks !== markLabels) bad.push(`${rel}: ${marks} feedbackId y ${markLabels} feedbackLabel`);
  }
  assert.deepEqual(bad, []);
});

test('la raíz de cada id es una pantalla o una pieza de la cáscara conocida', () => {
  const roots = new Set(collect().map((f) => f.id.split('.')[1]));
  const allowed = new Set(['inicio', 'facturas', 'emitidas', 'compras', 'gestoria', 'proveedores', 'conflictos', 'cabecera', 'navegacion', 'avisos']);
  assert.deepEqual([...roots].filter((root) => !allowed.has(root!)), []);
});

test('las operaciones importantes se miden con usage.run o usage.track y un id literal', () => {
  const ops = new Set<string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of text.matchAll(/\busage\.(?:run|track)\(\s*'([^']+)'/g)) ops.add(m[1]!);
  }
  for (const id of ops) assert.match(id, PATTERN, id);
  for (const id of ['invoices.facturas.subir', 'invoices.facturas.extraer', 'invoices.facturas.leer_pdf', 'invoices.facturas.validar', 'invoices.emitidas.emitir',
    'invoices.emitidas.rectificar', 'invoices.gestoria.generar_entrega']) assert.ok(ops.has(id), `falta medir ${id}`);
});
