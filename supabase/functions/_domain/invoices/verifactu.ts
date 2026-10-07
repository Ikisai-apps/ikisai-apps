/**
 * VERI*FACTU (API.md §14.5–14.6): huella encadenada de los registros de alta y de anulación y URL del QR de cotejo.
 * Misma regla que `invoices.vf_*` en SQL (migración 0213), que es quien la calcula al emitir; aquí sirve para comprobar
 * la cadena y para generar el XML del envío cuando se active.
 *
 * Fuentes: AEAT, «Detalle de las especificaciones técnicas para la generación de la huella o hash de los registros»
 * v0.1.2 y «Especificaciones técnicas del código QR de la factura» v0.5.0.
 */

export interface VfAltaInput {
  /** IDEmisorFactura: NIF del obligado a expedir. */
  issuerTaxId: string;
  /** NumSerieFactura: serie y número completos. */
  numSerie: string;
  /** FechaExpedicionFactura, DD-MM-AAAA. */
  issueDate: string;
  invoiceType: string;
  /** CuotaTotal: cuotas repercutidas más recargo de equivalencia. */
  quotaTotal: number;
  /** ImporteTotal: base más cuotas y recargos, sin restar retenciones. */
  amountTotal: number;
  /** Huella del registro anterior, o vacía si es el primero. */
  previousHash: string | null;
  /** FechaHoraHusoGenRegistro: AAAA-MM-DDThh:mm:ss+hh:mm. */
  generatedAt: string;
}

export interface VfAnulacionInput {
  issuerTaxId: string;
  numSerie: string;
  issueDate: string;
  previousHash: string | null;
  generatedAt: string;
}

/** Importe con dos decimales y punto (la AEAT acepta uno o dos; usamos siempre dos, como el XML). */
export function vfAmount(value: number): string {
  const cents = Math.round(value * 100);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const v = (value: string | null | undefined) => (value ?? '').trim();

export function vfAltaString(input: VfAltaInput): string {
  return `IDEmisorFactura=${v(input.issuerTaxId)}&NumSerieFactura=${v(input.numSerie)}&FechaExpedicionFactura=${v(input.issueDate)}`
    + `&TipoFactura=${v(input.invoiceType)}&CuotaTotal=${vfAmount(input.quotaTotal)}&ImporteTotal=${vfAmount(input.amountTotal)}`
    + `&Huella=${v(input.previousHash)}&FechaHoraHusoGenRegistro=${v(input.generatedAt)}`;
}

export function vfAnulacionString(input: VfAnulacionInput): string {
  return `IDEmisorFacturaAnulada=${v(input.issuerTaxId)}&NumSerieFacturaAnulada=${v(input.numSerie)}&FechaExpedicionFacturaAnulada=${v(input.issueDate)}`
    + `&Huella=${v(input.previousHash)}&FechaHoraHusoGenRegistro=${v(input.generatedAt)}`;
}

/** SHA-256 de la cadena en UTF-8, en hexadecimal y en mayúsculas (64 caracteres). */
export async function vfHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export const vfAltaHash = (input: VfAltaInput) => vfHash(vfAltaString(input));
export const vfAnulacionHash = (input: VfAnulacionInput) => vfHash(vfAnulacionString(input));

/** Codificación de URL en UTF-8: deja solo letras, cifras y `-._~`. */
export function vfUrlEncode(value: string): string {
  return [...new TextEncoder().encode(value)].map((c) => {
    const ch = String.fromCharCode(c);
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${c.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

/** URL de cotejo del QR de una factura verificable (QR v0.5.0, §5.1). */
export function vfQrUrl(env: 'pruebas' | 'produccion', issuerTaxId: string, numSerie: string, issueDate: string, amountTotal: number): string {
  const base = env === 'pruebas' ? 'https://prewww2.aeat.es' : 'https://www2.agenciatributaria.gob.es';
  return `${base}/wlpl/TIKE-CONT/ValidarQR?nif=${vfUrlEncode(issuerTaxId)}&numserie=${vfUrlEncode(numSerie)}&fecha=${vfUrlEncode(issueDate)}&importe=${vfAmount(amountTotal)}`;
}

/** Formato del número de una serie de emisión: {serie}, {año} y {n} o {n:K}. Misma regla que invoices.format_issued_number. */
export function formatIssuedNumber(format: string, code: string, year: number, n: number): string {
  const withSeries = format.replaceAll('{serie}', code.trim()).replaceAll('{año}', String(year));
  const padded = withSeries.match(/\{n:(\d)\}/);
  return padded ? withSeries.replace(/\{n:\d\}/g, String(n).padStart(Number(padded[1]), '0')) : withSeries.replaceAll('{n}', String(n));
}

/** Un formato válido lleva {n} o {n:K} y, con el número más largo, cabe en 60 caracteres ASCII imprimibles. */
export function validIssuedNumberFormat(format: string, code: string): boolean {
  if (!/\{n(:\d)?\}/.test(format)) return false;
  const sample = formatIssuedNumber(format, code, 2026, 999999);
  return sample.length <= 60 && /^[ -~]+$/.test(sample);
}
