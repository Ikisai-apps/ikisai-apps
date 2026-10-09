/**
 * Corpus real del lector (fase 2, PR 7): lee cada `<id>.pdf` de una carpeta con el mismo PDF.js y el mismo lector que la
 * Edge y lo compara con `<id>.expected.json`. Escribe SOLO acierto o fallo por campo y documento (ningún valor ni texto),
 * en Markdown para el resumen del job. Sale con 1 si algún campo falla.
 *
 *   npx tsx tests/invoices/corpus/run.ts <carpeta>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPdfItemsServer } from '../../../supabase/functions/invoices-api/drive.ts';
import { extractFromPdfText, validSpanishTaxId, type PartialInvoice } from '../../../packages/domain-invoices/src/index.ts';

type Expected = Partial<Record<'supplier_tax_id' | 'invoice_number' | 'invoice_date' | 'base' | 'vat' | 'withholding' | 'total', string | number>>;
const LABELS: Record<keyof Expected, string> = { supplier_tax_id: 'NIF', invoice_number: 'número', invoice_date: 'fecha', base: 'base', vat: 'IVA', withholding: 'retención', total: 'total' };

/** El valor leído para cada campo (de lo encontrado, aunque la lectura sea parcial). */
function readField(found: PartialInvoice, field: keyof Expected): string | number | null {
  switch (field) {
    case 'vat': return found.vat.length ? Math.round(found.vat.reduce((n, v) => n + v.quota, 0) * 100) / 100 : null;
    case 'withholding': return found.withholding?.amount ?? null;
    default: return (found as unknown as Record<string, string | number | null>)[field] ?? null;
  }
}
function same(field: keyof Expected, read: string | number | null, want: string | number): boolean {
  if (read === null) return false;
  if (typeof want === 'number') return Math.abs(Number(read) - want) <= 0.005;
  if (field === 'supplier_tax_id') return (validSpanishTaxId(String(read)) ?? String(read)) === (validSpanishTaxId(want) ?? want.toUpperCase());
  if (field === 'invoice_number') return String(read).replace(/[\s.\-/]/g, '').toLowerCase() === want.replace(/[\s.\-/]/g, '').toLowerCase();
  return String(read) === want;
}

const folder = process.argv[2];
if (!folder) { console.error('Uso: npx tsx tests/invoices/corpus/run.ts <carpeta>'); process.exit(2); }
const ids = readdirSync(folder).filter((n) => n.endsWith('.pdf')).map((n) => n.slice(0, -4)).sort();
let fails = 0; let checks = 0;
const rows: string[] = [];
for (const id of ids) {
  let expected: Expected;
  try { expected = JSON.parse(readFileSync(join(folder, `${id}.expected.json`), 'utf-8')); } catch { rows.push(`| ${id} | sin esperado |`); continue; }
  let cells: string[];
  try {
    const items = await readPdfItemsServer(new Uint8Array(readFileSync(join(folder, `${id}.pdf`))));
    const r = extractFromPdfText(items);
    cells = (Object.keys(expected) as Array<keyof Expected>).map((field) => {
      checks += 1;
      const ok = same(field, readField(r.found, field), expected[field]!);
      if (!ok) fails += 1;
      return `${LABELS[field]} ${ok ? '✓' : '✗'}`;
    });
    cells.unshift(r.read === 'no_text' ? 'sin texto' : r.read === 'partial' ? 'parcial' : 'completa');
  } catch {
    fails += 1;
    cells = ['no se pudo abrir'];
  }
  rows.push(`| ${id} | ${cells.join(' · ')} |`);
}
console.log(`### Corpus del lector: ${checks - fails} de ${checks} campos bien (${ids.length} documentos)\n\n| Documento | Resultado |\n|---|---|\n${rows.join('\n')}`);
process.exit(fails ? 1 : 0);
