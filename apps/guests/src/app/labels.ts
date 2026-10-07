/**
 * Etiquetas traducidas de los catálogos de Booking (API.md §9.4, §9.5 y §9.10). Booking guarda los valores canónicos
 * (`DNI`, `alergia`, `PM`, `ESP`…); Guests solo los muestra en el idioma elegido.
 */
import { KINSHIP_CODES, type GuestMode } from '@ikisai/domain-booking';
import { formatDate, localeTag, t } from './i18n.ts';

export type FieldType = 'text' | 'email' | 'tel' | 'date' | 'select' | 'country' | 'toggle';
export interface FieldSpec { key: string; group: Group; type: FieldType; options?: () => Array<[string, string]>; autocomplete?: string; minorOnly?: boolean; adultOnly?: boolean }
export type Group = 'identity' | 'document' | 'residence' | 'contact' | 'minor';

export const GROUPS: Group[] = ['identity', 'document', 'residence', 'contact', 'minor'];

const DOCUMENT_TYPES = ['DNI', 'NIE', 'Pasaporte', 'TIE', 'Otro'] as const;
const SEXES = ['H', 'M', 'X'] as const;

export const FIELDS: FieldSpec[] = [
  { key: 'first_name', group: 'identity', type: 'text', autocomplete: 'given-name' },
  { key: 'last_name_1', group: 'identity', type: 'text', autocomplete: 'family-name' },
  { key: 'last_name_2', group: 'identity', type: 'text' },
  { key: 'sex', group: 'identity', type: 'select', options: () => SEXES.map((s) => [s, t(`sex.${s}`)]) },
  { key: 'birth_date', group: 'identity', type: 'date', autocomplete: 'bday' },
  { key: 'nationality', group: 'identity', type: 'country' },
  { key: 'document_type', group: 'document', type: 'select', adultOnly: true, options: () => DOCUMENT_TYPES.map((d) => [d, t(`doc.${d}`)]) },
  { key: 'document_number', group: 'document', type: 'text', adultOnly: true },
  { key: 'document_support_number', group: 'document', type: 'text', adultOnly: true },
  { key: 'residence_address', group: 'residence', type: 'text', autocomplete: 'street-address' },
  { key: 'residence_postal_code', group: 'residence', type: 'text', autocomplete: 'postal-code' },
  { key: 'residence_city', group: 'residence', type: 'text', autocomplete: 'address-level2' },
  { key: 'residence_country', group: 'residence', type: 'country' },
  { key: 'phone', group: 'contact', type: 'tel', autocomplete: 'tel' },
  { key: 'email', group: 'contact', type: 'email', autocomplete: 'email' },
  { key: 'is_minor', group: 'minor', type: 'toggle' },
  { key: 'guardian_name', group: 'minor', type: 'text', minorOnly: true },
  { key: 'kinship', group: 'minor', type: 'select', minorOnly: true, options: () => Object.keys(KINSHIP_CODES).map((code) => [code, t(`kinship.${code}`)]) },
];

/** Sin registro de viajeros solo se piden nombre, apellido y contacto (Booking §17.1). */
const OPERATIVE = new Set(['first_name', 'last_name_1', 'phone', 'email']);

export function fieldsFor(mode: GuestMode): FieldSpec[] {
  if (mode === 'ninguno') return [];
  return mode === 'operativo' ? FIELDS.filter((f) => OPERATIVE.has(f.key)) : FIELDS;
}

export function fieldLabel(key: string): string { return t(`field.${key}`); }

/** Lo que falta, en frase corta: «documento, dirección y código postal». `contact` es «teléfono o correo». */
export function missingText(missing: readonly string[]): string {
  const names = missing.map((m) => t(`missing.${m}`));
  if (names.length <= 1) return names[0] ?? '';
  return new Intl.ListFormat(localeTag(), { style: 'long', type: 'conjunction' }).format(names);
}

export const RESTRICTION_TYPES = ['alergia', 'intolerancia', 'vegetariano', 'vegano', 'sin_gluten', 'sin_lactosa', 'preferencia', 'otra'] as const;
export const NEEDS_SUBJECT = new Set(['alergia', 'intolerancia', 'otra']);
export const HAS_SEVERITY = new Set(['alergia', 'intolerancia']);
export const SEVERITIES = ['leve', 'moderada', 'grave'] as const;

export function restrictionLabel(type: string): string { return t(`diet.${type}`); }
export function severityLabel(value: string): string { return t(`severity.${value}`); }

/** «del 12 al 15 de marzo de 2027» · «12–15 March 2027». */
export function dateRange(start: string | null, end: string | null): string {
  if (!start) return '';
  if (!end || end === start) return formatDate(start);
  const fmt = new Intl.DateTimeFormat(localeTag(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
  return fmt.formatRange(new Date(`${start}T12:00:00Z`), new Date(`${end}T12:00:00Z`));
}

export function timeLabel(at: string): string {
  return formatDate(at, { hour: '2-digit', minute: '2-digit' });
}

export function hhmm(value: string | null | undefined): string | null {
  return value ? value.slice(0, 5) : null;
}

/** Países frecuentes (alfa-3 de Booking → alfa-2 para `Intl.DisplayNames`); el resto, con «Otro país». */
const COUNTRIES: Record<string, string> = {
  ESP: 'ES', PRT: 'PT', FRA: 'FR', ITA: 'IT', DEU: 'DE', GBR: 'GB', IRL: 'IE', NLD: 'NL', BEL: 'BE', LUX: 'LU', CHE: 'CH', AUT: 'AT',
  DNK: 'DK', SWE: 'SE', NOR: 'NO', FIN: 'FI', ISL: 'IS', POL: 'PL', CZE: 'CZ', SVK: 'SK', HUN: 'HU', ROU: 'RO', BGR: 'BG', GRC: 'GR',
  HRV: 'HR', SVN: 'SI', EST: 'EE', LVA: 'LV', LTU: 'LT', UKR: 'UA', RUS: 'RU', TUR: 'TR', MAR: 'MA', DZA: 'DZ', TUN: 'TN', EGY: 'EG',
  SEN: 'SN', NGA: 'NG', ZAF: 'ZA', ISR: 'IL', IND: 'IN', CHN: 'CN', JPN: 'JP', KOR: 'KR', AUS: 'AU', NZL: 'NZ', USA: 'US', CAN: 'CA',
  MEX: 'MX', GTM: 'GT', CUB: 'CU', DOM: 'DO', COL: 'CO', VEN: 'VE', ECU: 'EC', PER: 'PE', BOL: 'BO', CHL: 'CL', ARG: 'AR', URY: 'UY',
  PRY: 'PY', BRA: 'BR', AND: 'AD', MCO: 'MC',
};

export function countryName(alpha3: string): string {
  const alpha2 = COUNTRIES[alpha3];
  if (!alpha2) return alpha3;
  try {
    return new Intl.DisplayNames([localeTag()], { type: 'region' }).of(alpha2) ?? alpha3;
  } catch {
    return alpha3;
  }
}

/** Opciones del selector de país, ordenadas por nombre en el idioma elegido (España primero). */
export function countryOptions(): Array<[string, string]> {
  const collator = new Intl.Collator(localeTag());
  const rest = Object.keys(COUNTRIES).filter((c) => c !== 'ESP').map((c) => [c, countryName(c)] as [string, string]).sort((a, b) => collator.compare(a[1], b[1]));
  return [['ESP', countryName('ESP')], ...rest];
}

export function isKnownCountry(alpha3: string): boolean { return alpha3 in COUNTRIES; }
