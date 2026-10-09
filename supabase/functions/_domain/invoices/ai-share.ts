/**
 * Extracción con la app de IA del usuario, sin API de pago (ronda 29, fase 1). La app comparte el documento y un
 * contrato en texto (`ikisai_invoice_contract.txt`) con la app que elija el usuario (ChatGPT, Gemini…); lo que vuelve,
 * por «Compartir» hacia Ikisai, pegado o como archivo, es **no confiable**: se extrae el JSON del texto, se separa el
 * sobre `source` y se valida como cualquier `ikisai.invoice.v1` antes de la vista previa y la confirmación.
 */
import { EXTRACTION_PROMPT_STRUCTURED } from './extraction-prompt.ts';
import { validateImportDocument, type ImportValidation } from './import-v1.schema.ts';

export const INVOICE_CONTRACT_FILENAME = 'ikisai_invoice_contract.txt';
export const INVOICE_RESULT_FILENAME = 'ikisai_invoice_result.json';

export interface SharedSource { filename: string; sha256: string }

/** Instrucciones que acompañan al documento. Si se conoce el documento, pide devolver `source` con su nombre y hash. */
export function invoiceContractText(source?: SharedSource | null, known?: string | null): string {
  // Fase 3 (9-10-2026): lo que Finance ya leyó va con el contrato; la IA lo comprueba y completa solo lo que falta.
  const knownBlock = known ? `\n\n${known}` : '';
  const envelope = source
    ? `\n\nSobre de intercambio: añade al JSON, en el primer nivel, la clave "source" con exactamente este valor, sin cambiarlo:\n"source": { "filename": ${JSON.stringify(source.filename)}, "sha256": "${source.sha256}" }\nSirve para comprobar que el resultado corresponde a este documento.`
    : '';
  return `IKISAI · CONTRATO DE EXTRACCIÓN DE FACTURA (ikisai.invoice.v1)

Te comparto una factura (PDF o foto) desde la app Ikisai Finance. Tu tarea es leerla y devolver sus datos en JSON.

Normas obligatorias:
- Responde SOLO con el JSON, sin texto antes ni después (si tu app no lo permite, pon el JSON en un bloque de código).
- Si un dato no aparece o no se lee, usa null. No inventes nada.
- Fechas en formato AAAA-MM-DD. Números con punto decimal y sin símbolo de moneda (40.5, no "40,50 €").
- Si te es posible, devuelve el resultado también como archivo ${INVOICE_RESULT_FILENAME} y compártelo con Ikisai; si no, el usuario lo copiará y lo pegará.

${EXTRACTION_PROMPT_STRUCTURED}${knownBlock}${envelope}
`;
}

/**
 * Lo que Finance ya ha leído del documento, para la IA: valores encontrados y lo que falta. La IA los comprueba en el
 * documento, los conserva salvo error evidente y completa solo lo demás. Devuelve `null` si no hay nada leído.
 */
export function knownFieldsText(found: { supplier_name: string | null; supplier_tax_id: string | null; invoice_number: string | null; invoice_date: string | null; base: number | null; vat: Array<{ rate: number; quota: number }>; withholding: { amount: number } | null; total: number | null }, missing: string[]): string | null {
  const lines: string[] = [];
  if (found.supplier_name || found.supplier_tax_id) lines.push(`- Proveedor: ${[found.supplier_name, found.supplier_tax_id ? `NIF ${found.supplier_tax_id}` : null].filter(Boolean).join(', ')}`);
  if (found.invoice_number) lines.push(`- Número de factura: ${found.invoice_number}`);
  if (found.invoice_date) lines.push(`- Fecha de la factura: ${found.invoice_date}`);
  if (found.base !== null) lines.push(`- Base imponible: ${found.base}`);
  for (const v of found.vat) lines.push(`- IVA ${v.rate} %: ${v.quota}`);
  if (found.withholding) lines.push(`- Retención: ${found.withholding.amount}`);
  if (found.total !== null) lines.push(`- Total: ${found.total}`);
  if (!lines.length) return null;
  return `DATOS YA LEÍDOS POR FINANCE (sin IA) — compruébalos en el documento y consérvalos salvo error evidente; completa solo lo que falta:\n${lines.join('\n')}${missing.length ? `\nFalta: ${missing.join(', ')}.` : ''}\nSi algún dato ya leído no coincide con el documento, usa el del documento y dilo en extraction_notes.`;
}

/**
 * Busca el JSON dentro de un texto: el texto entero si ya es JSON, un bloque ```json … ```, o el primer objeto `{…}`
 * equilibrado (respetando cadenas). Devuelve `null` si no hay ninguno.
 */
export function extractJsonText(text: string): string | null {
  const trimmed = text.trim().replace(/^﻿/, '');
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try { JSON.parse(trimmed); return trimmed; } catch { /* puede llevar texto detrás: sigue buscando */ }
  }
  const fence = trimmed.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fence && fence[1]!.trim().startsWith('{')) return fence[1]!.trim();
  for (let start = trimmed.indexOf('{'); start >= 0; start = trimmed.indexOf('{', start + 1)) {
    let depth = 0; let inString = false; let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch { break; }
        }
      }
    }
  }
  return null;
}

export interface ExternalResult {
  /** Validación del documento (sin el sobre). */
  validation: ImportValidation;
  /** Sobre `source` si venía y tenía la forma esperada. */
  source: SharedSource | null;
  /** El texto contenía un JSON (aunque luego no cumpla el formato). */
  foundJson: boolean;
  /** JSON del documento sin el sobre, listo para mostrarlo en el cuadro de la importación. */
  documentText: string | null;
}

/** Resultado de la app de IA: JSON dentro del texto, sobre separado y validación estricta del resto. */
export function parseExternalResult(text: string): ExternalResult {
  const json = extractJsonText(text);
  if (json === null) return { validation: { ok: false, errors: [{ path: '$', reason: 'No hay ningún JSON en el texto recibido.' }] }, source: null, foundJson: false, documentText: null };
  let value: unknown;
  try { value = JSON.parse(json); } catch (error) {
    return { validation: { ok: false, errors: [{ path: '$', reason: 'JSON inválido: ' + (error as Error).message }] }, source: null, foundJson: true, documentText: null };
  }
  let source: SharedSource | null = null;
  if (value && typeof value === 'object' && !Array.isArray(value) && 'source' in value) {
    const { source: raw, ...rest } = value as Record<string, unknown>;
    const s = raw as Partial<SharedSource> | null;
    if (s && typeof s === 'object' && typeof s.filename === 'string' && typeof s.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(s.sha256)) {
      source = { filename: s.filename, sha256: s.sha256.toLowerCase() };
    }
    value = rest;
  }
  return { validation: validateImportDocument(value), source, foundJson: true, documentText: JSON.stringify(value, null, 2) };
}
