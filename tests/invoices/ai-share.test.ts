/** Fase 1 de la extracción sin API de pago: contrato, JSON dentro del texto, sobre `source` y resultados manipulados. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVOICE_CONTRACT_FILENAME, extractJsonText, invoiceContractText, parseExternalResult } from '../../packages/domain-invoices/src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(here, '../core/fixtures/invoice-import-v1.example.json'), 'utf8'));
const SHA = 'a'.repeat(64);

test('contrato: normas, formato y sobre con el nombre y el hash del documento', () => {
  const text = invoiceContractText({ filename: 'scan factura.pdf', sha256: SHA });
  assert.match(text, /Responde SOLO con el JSON/); assert.match(text, /usa null/); assert.match(text, /AAAA-MM-DD/);
  assert.match(text, /"schema_version": "ikisai\.invoice\.v1"/);
  assert.ok(text.includes(`"source": { "filename": "scan factura.pdf", "sha256": "${SHA}" }`));
  assert.ok(!invoiceContractText().includes('"source"'));
  assert.equal(INVOICE_CONTRACT_FILENAME, 'ikisai_invoice_contract.txt');
});

test('JSON dentro del texto: puro, en bloque de código, con prosa alrededor y sin JSON', () => {
  const json = JSON.stringify(EXAMPLE);
  assert.equal(extractJsonText(json), json);
  assert.equal(extractJsonText(`Aquí tienes:\n\`\`\`json\n${json}\n\`\`\`\nSuerte`), json);
  assert.equal(extractJsonText(`He leído la factura. ${json} ¿Algo más?`), json);
  assert.equal(extractJsonText('Lo siento, no puedo leer el documento.'), null);
  // Llaves dentro de cadenas no confunden el recorte
  const tricky = JSON.stringify({ ...EXAMPLE, extraction_notes: 'texto con } y { dentro' });
  assert.equal(extractJsonText(`Resultado: ${tricky}`), tricky);
});

test('resultado externo: sobre separado y validado; manipulado o incompleto se rechaza; sin sobre sigue valiendo', () => {
  const withSource = parseExternalResult(JSON.stringify({ ...EXAMPLE, source: { filename: 'scan factura.pdf', sha256: SHA.toUpperCase() } }));
  assert.equal(withSource.validation.ok, true); assert.deepEqual(withSource.source, { filename: 'scan factura.pdf', sha256: SHA });
  assert.ok(!withSource.documentText!.includes('"source"'));
  const plain = parseExternalResult('```json\n' + JSON.stringify(EXAMPLE) + '\n```');
  assert.equal(plain.validation.ok, true); assert.equal(plain.source, null);
  // Clave extra (manipulado), totales como texto y sobre mal formado
  const extra = parseExternalResult(JSON.stringify({ ...EXAMPLE, approved: true }));
  assert.equal(extra.validation.ok, false);
  const badTypes = parseExternalResult(JSON.stringify({ ...EXAMPLE, document_totals: { ...EXAMPLE.document_totals, total: '44,00 €' } }));
  assert.equal(badTypes.validation.ok, false);
  const badSource = parseExternalResult(JSON.stringify({ ...EXAMPLE, source: { filename: 'x.pdf', sha256: 'nope' } }));
  assert.equal(badSource.validation.ok, true); assert.equal(badSource.source, null);
  const nothing = parseExternalResult('No he podido.');
  assert.equal(nothing.foundJson, false); assert.equal(nothing.validation.ok, false);
});
