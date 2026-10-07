/**
 * Ikisai Central · datos de la entidad (configuración común, API.md §2.9): razón social, NIF/CIF, domicilio fiscal y logotipo.
 */

export const ENTITY_TABLE = 'central.entity';
export const ENTITY_PROJECTION = 'central.common_entity_projection';

/** Logotipo: imagen nítida, sin recomprimir si cabe (un logotipo no es una foto; contrato §11.3, excepción explícita). */
export const LOGO_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Normaliza un NIF/CIF tal como se escribe: mayúsculas, sin espacios, puntos ni guiones. */
export function normalizeTaxId(value: string): string {
  return value.toUpperCase().replace(/[\s.\-]/g, '');
}

/**
 * Comprueba un identificador fiscal español: NIF (8 cifras + letra), NIE (X/Y/Z + 7 cifras + letra) o CIF
 * (letra + 7 cifras + control, número o letra según el tipo de entidad). Devuelve null si es válido o el motivo.
 */
export function taxIdProblem(raw: string): string | null {
  const id = normalizeTaxId(raw);
  if (/^\d{8}[A-Z]$/.test(id)) return NIF_LETTERS[Number(id.slice(0, 8)) % 23] === id[8] ? null : 'la letra del NIF no corresponde';
  if (/^[XYZ]\d{7}[A-Z]$/.test(id)) {
    const number = Number('XYZ'.indexOf(id[0]!) + id.slice(1, 8));
    return NIF_LETTERS[number % 23] === id[8] ? null : 'la letra del NIE no corresponde';
  }
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(id)) {
    const digits = id.slice(1, 8);
    let sum = 0;
    for (let i = 0; i < 7; i++) {
      const n = Number(digits[i]);
      if (i % 2 === 0) { const d = n * 2; sum += Math.floor(d / 10) + (d % 10); } else sum += n;
    }
    const control = (10 - (sum % 10)) % 10;
    const letter = 'JABCDEFGHI'[control]!;
    const kind = id[0]!;
    const expected = 'PQRSNW'.includes(kind) ? [letter] : 'ABEH'.includes(kind) ? [String(control)] : [String(control), letter];
    return expected.includes(id[8]!) ? null : 'el dígito de control del CIF no corresponde';
  }
  return 'no tiene forma de NIF, NIE ni CIF';
}

export interface EntityRow {
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  address_line: string;
  postal_code: string;
  city: string;
  province: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  logo_file_id: string | null;
}

/** Fila de la proyección `central.common_entity_projection` que leen Booking y Finance. */
export interface EntityProjection extends Omit<EntityRow, 'logo_file_id'> {
  entity_id: string;
  entity_revision: number;
  updated_at: string;
  logo_file_id: string | null;
  logo_bucket: string | null;
  logo_path: string | null;
  logo_mime: string | null;
  logo_sha256: string | null;
  /** `supabase | r2` (contrato §3.9): con qué proveedor se firma el logotipo (`createStorage(supabase).readUrl`). */
  logo_provider: string | null;
}
