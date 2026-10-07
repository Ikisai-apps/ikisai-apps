/** Textos en lenguaje claro para lo que llega de Booking (API.md §9). Nada de códigos ni jerga en pantalla. */
import type { GuestMode } from '@ikisai/domain-booking';
import type { ReservationStatus } from './api.ts';
import { i18n, L, lang, t } from './i18n.ts';

const STATUS: Record<ReservationStatus, string> = {
  en_estudio: L('En preparación'), negociacion: L('En preparación'), pre_reservada: L('Prerreservada'), confirmada: L('Confirmada'),
  en_ejecucion: L('En curso'), cerrada: L('Finalizada'), cancelada: L('Cancelada'), perdida: L('Cancelada'),
};
export const statusLabel = (status: ReservationStatus) => t(STATUS[status] ?? status);
export const STATUS_TONE: Record<ReservationStatus, '' | 'ok' | 'warn' | 'trash'> = {
  en_estudio: '', negociacion: '', pre_reservada: 'warn', confirmada: 'ok', en_ejecucion: 'ok', cerrada: '', cancelada: 'trash', perdida: 'trash',
};
export const isCancelled = (status: ReservationStatus) => status === 'cancelada' || status === 'perdida';

const MEAL_PLAN: Record<string, string> = {
  pension_completa: L('Pensión completa'), media_pension: L('Media pensión'), desayuno: L('Desayuno'), segun_programa: L('Comidas según programa'), no_aplica: L('Sin comidas'),
};
export const mealPlanLabel = (plan: string) => (MEAL_PLAN[plan] ? t(MEAL_PLAN[plan]) : plan);
const MENU_STYLE: Record<string, string> = { vegetariano: L('menú vegetariano'), vegano: L('menú vegano'), mixto: L('menú mixto'), otro: L('menú a medida') };
export const menuStyleLabel = (style: string) => (MENU_STYLE[style] ? t(MENU_STYLE[style]) : style);

const RESTRICTION: Record<string, string> = {
  alergia: L('Alergia'), intolerancia: L('Intolerancia'), vegetariano: L('Vegetariano'), vegano: L('Vegano'), sin_gluten: L('Sin gluten'),
  sin_lactosa: L('Sin lactosa'), preferencia: L('Preferencia'), otra: L('Otra'),
};
export const RESTRICTION_TYPES = Object.keys(RESTRICTION);
export const restrictionLabel = (type: string) => (RESTRICTION[type] ? t(RESTRICTION[type]) : type);
const SEVERITY: Record<string, string> = { grave: L('grave'), moderada: L('moderada'), leve: L('leve') };
export const SEVERITIES = Object.keys(SEVERITY);
export const severityLabel = (severity: string) => (SEVERITY[severity] ? t(SEVERITY[severity]) : severity);
/** Tipos que necesitan decir «a qué» (igual que la restricción de Booking). */
export const RESTRICTION_NEEDS_SUBJECT = new Set(['alergia', 'intolerancia', 'otra']);
export const RESTRICTION_HAS_SEVERITY = new Set(['alergia', 'intolerancia']);

/** «Alergia a frutos secos · grave», «Vegetariano», «Sin cebolla» (tipo «otra»: solo lo que se escribió). */
export function restrictionText(r: { restriction_type: string; subject: string | null; severity?: string | null }): string {
  const severity = r.severity ? ` · ${severityLabel(r.severity)}` : '';
  if (r.restriction_type === 'otra') return `${r.subject ?? t('Otra')}${severity}`;
  const base = restrictionLabel(r.restriction_type);
  if (!r.subject) return `${base}${severity}`;
  return RESTRICTION_HAS_SEVERITY.has(r.restriction_type)
    ? `${t('{tipo} a {que}', { tipo: base, que: r.subject })}${severity}`
    : `${base} (${r.subject})${severity}`;
}

/**
 * Campos de un asistente: etiqueta, bloque y tipo de control. Solo los que Booking deja escribir al portal.
 * `label`, `group`, `hint` y las opciones van en español (`L`) y se traducen al pintarlos; `group` es además el gancho
 * estable del bloque (`data-group`).
 */
export interface FieldSpec { key: string; label: string; group: string; type: 'text' | 'email' | 'tel' | 'date' | 'select' | 'country'; options?: Array<[string, string]>; hint?: string }

export const GUEST_FIELDS: FieldSpec[] = [
  { key: 'first_name', label: L('Nombre'), group: L('Identidad'), type: 'text' },
  { key: 'last_name_1', label: L('Primer apellido'), group: L('Identidad'), type: 'text' },
  { key: 'last_name_2', label: L('Segundo apellido'), group: L('Identidad'), type: 'text' },
  { key: 'sex', label: L('Sexo'), group: L('Identidad'), type: 'select', options: [['M', L('Mujer')], ['H', L('Hombre')], ['X', L('Otro')]] },
  { key: 'birth_date', label: L('Fecha de nacimiento'), group: L('Identidad'), type: 'date' },
  { key: 'nationality', label: L('Nacionalidad'), group: L('Identidad'), type: 'country' },
  { key: 'guardian_name', label: L('Si es menor: persona responsable'), group: L('Identidad'), type: 'text', hint: L('Madre, padre o tutor que le acompaña o autoriza.') },
  { key: 'kinship', label: L('Si es menor: parentesco con esa persona'), group: L('Identidad'), type: 'text' },
  { key: 'document_type', label: L('Tipo de documento'), group: L('Documento'), type: 'select', options: [['DNI', 'DNI'], ['NIE', 'NIE'], ['Pasaporte', L('Pasaporte')], ['TIE', L('Tarjeta de residencia (TIE)')], ['Otro', L('Otro')]] },
  { key: 'document_number', label: L('Número de documento'), group: L('Documento'), type: 'text' },
  { key: 'document_support_number', label: L('Número de soporte'), group: L('Documento'), type: 'text', hint: L('En el DNI y el NIE, el código de la cara delantera (por ejemplo, ABC123456).') },
  { key: 'residence_address', label: L('Dirección'), group: L('Residencia'), type: 'text' },
  { key: 'residence_postal_code', label: L('Código postal'), group: L('Residencia'), type: 'text' },
  { key: 'residence_city', label: L('Población'), group: L('Residencia'), type: 'text' },
  { key: 'residence_country', label: L('País'), group: L('Residencia'), type: 'country' },
  { key: 'phone', label: L('Teléfono'), group: L('Contacto'), type: 'tel' },
  { key: 'email', label: L('Correo electrónico'), group: L('Contacto'), type: 'email' },
];

/** Lo que se pide sin registro de viajeros (modo `operativo`): nunca documento, dirección, nacimiento ni firma. */
const OPERATIVE = new Set(['first_name', 'last_name_1', 'phone', 'email']);
export const fieldsFor = (mode: GuestMode): FieldSpec[] => (mode === 'ses' ? GUEST_FIELDS : mode === 'operativo' ? GUEST_FIELDS.filter((f) => OPERATIVE.has(f.key)) : []);

const MISSING: Record<string, string> = {
  first_name: L('nombre'), last_name_1: L('primer apellido'), last_name_2: L('segundo apellido'), birth_date: L('fecha de nacimiento'),
  residence_address: L('dirección'), residence_postal_code: L('código postal'), residence_city: L('población'), residence_country: L('país'),
  contact: L('teléfono o correo'), kinship: L('parentesco'), document_type: L('tipo de documento'), document_number: L('documento'),
  document_support_number: L('número de soporte'),
};
export const missingText = (missing: readonly string[]) => missing.map((m) => (MISSING[m] ? t(MISSING[m]) : m)).join(', ');

/** Países habituales (código ISO de tres letras que pide el registro de viajeros); el nombre lo da `Intl` en cada idioma. */
export const COUNTRY_CODES = ['ESP', 'PRT', 'FRA', 'ITA', 'DEU', 'GBR', 'IRL', 'NLD', 'BEL', 'CHE', 'AUT', 'POL', 'ROU', 'SWE', 'DNK', 'NOR', 'MAR', 'USA', 'CAN', 'MEX', 'ARG', 'CHL', 'COL', 'PER', 'VEN', 'URY', 'ECU', 'BRA'];
const ALPHA2: Record<string, string> = {
  ESP: 'ES', PRT: 'PT', FRA: 'FR', ITA: 'IT', DEU: 'DE', GBR: 'GB', IRL: 'IE', NLD: 'NL', BEL: 'BE', CHE: 'CH', AUT: 'AT', POL: 'PL', ROU: 'RO', SWE: 'SE',
  DNK: 'DK', NOR: 'NO', MAR: 'MA', USA: 'US', CAN: 'CA', MEX: 'MX', ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE', VEN: 'VE', URY: 'UY', ECU: 'EC', BRA: 'BR',
};
export function countryName(code: string): string {
  try { return new Intl.DisplayNames([i18n.tag()], { type: 'region' }).of(ALPHA2[code] ?? code) ?? code; } catch { return code; }
}
export const countries = (): Array<[string, string]> =>
  COUNTRY_CODES.map((code) => [code, countryName(code)] as [string, string]).sort((a, b) => (a[0] === 'ESP' ? -1 : b[0] === 'ESP' ? 1 : a[1].localeCompare(b[1], i18n.tag())));

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}
const utc = (date: string) => { const [y, m, d] = parts(date); return new Date(Date.UTC(y, m - 1, d)); };

/** «del 12 al 15 de marzo de 2027» en español; «12–15 March 2027» en inglés (`Intl.formatRange`). */
export function dateRange(start: string | null, end: string | null): string {
  if (!start) return t('Fechas por concretar');
  if (lang() !== 'es') {
    const f = new Intl.DateTimeFormat(i18n.tag(), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    return !end || end === start ? f.format(utc(start)) : f.formatRange(utc(start), utc(end));
  }
  const [y1, m1, d1] = parts(start);
  if (!end || end === start) return `${d1} de ${MONTHS[m1 - 1]} de ${y1}`;
  const [y2, m2, d2] = parts(end);
  if (y1 !== y2) return `del ${d1} de ${MONTHS[m1 - 1]} de ${y1} al ${d2} de ${MONTHS[m2 - 1]} de ${y2}`;
  if (m1 !== m2) return `del ${d1} de ${MONTHS[m1 - 1]} al ${d2} de ${MONTHS[m2 - 1]} de ${y1}`;
  return `del ${d1} al ${d2} de ${MONTHS[m1 - 1]} de ${y1}`;
}

/** «3 de marzo» / «3 March» (hora de Madrid) para fechas con hora. */
export function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat(i18n.tag(), { day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' }).format(new Date(iso));
}

export function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat(i18n.tag(), { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(iso));
}

/** «10:30» desde una hora de Postgres («10:30:00»). */
export const hourLabel = (time: string | null) => (time ? time.slice(0, 5) : null);
