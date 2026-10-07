/** Textos en lenguaje claro para lo que llega de Booking (API.md §9). Nada de códigos ni jerga en pantalla. */
import type { GuestMode } from '@ikisai/domain-booking';
import type { ReservationStatus } from './api.ts';

export const STATUS_LABELS: Record<ReservationStatus, string> = {
  en_estudio: 'En preparación', negociacion: 'En preparación', pre_reservada: 'Prerreservada', confirmada: 'Confirmada',
  en_ejecucion: 'En curso', cerrada: 'Finalizada', cancelada: 'Cancelada', perdida: 'Cancelada',
};
export const STATUS_TONE: Record<ReservationStatus, '' | 'ok' | 'warn' | 'trash'> = {
  en_estudio: '', negociacion: '', pre_reservada: 'warn', confirmada: 'ok', en_ejecucion: 'ok', cerrada: '', cancelada: 'trash', perdida: 'trash',
};
export const isCancelled = (status: ReservationStatus) => status === 'cancelada' || status === 'perdida';

export const MEAL_PLAN_LABELS: Record<string, string> = {
  pension_completa: 'Pensión completa', media_pension: 'Media pensión', desayuno: 'Desayuno', segun_programa: 'Comidas según programa', no_aplica: 'Sin comidas',
};
export const MENU_STYLE_LABELS: Record<string, string> = { vegetariano: 'menú vegetariano', vegano: 'menú vegano', mixto: 'menú mixto', otro: 'menú a medida' };

export const RESTRICTION_LABELS: Record<string, string> = {
  alergia: 'Alergia', intolerancia: 'Intolerancia', vegetariano: 'Vegetariano', vegano: 'Vegano', sin_gluten: 'Sin gluten',
  sin_lactosa: 'Sin lactosa', preferencia: 'Preferencia', otra: 'Otra',
};
export const SEVERITY_LABELS: Record<string, string> = { grave: 'grave', moderada: 'moderada', leve: 'leve' };
/** Tipos que necesitan decir «a qué» (igual que la restricción de Booking). */
export const RESTRICTION_NEEDS_SUBJECT = new Set(['alergia', 'intolerancia', 'otra']);
export const RESTRICTION_HAS_SEVERITY = new Set(['alergia', 'intolerancia']);

/** «Alergia a frutos secos · grave», «Vegetariano», «Sin cebolla» (tipo «otra»: solo lo que se escribió). */
export function restrictionText(r: { restriction_type: string; subject: string | null; severity?: string | null }): string {
  const severity = r.severity ? ` · ${SEVERITY_LABELS[r.severity] ?? r.severity}` : '';
  if (r.restriction_type === 'otra') return `${r.subject ?? 'Otra'}${severity}`;
  const base = RESTRICTION_LABELS[r.restriction_type] ?? r.restriction_type;
  if (!r.subject) return `${base}${severity}`;
  return RESTRICTION_HAS_SEVERITY.has(r.restriction_type) ? `${base} a ${r.subject}${severity}` : `${base} (${r.subject})${severity}`;
}

/** Campos de un asistente: etiqueta, bloque y tipo de control. Solo los que Booking deja escribir al portal. */
export interface FieldSpec { key: string; label: string; group: string; type: 'text' | 'email' | 'tel' | 'date' | 'select' | 'country'; options?: Array<[string, string]>; hint?: string }

export const GUEST_FIELDS: FieldSpec[] = [
  { key: 'first_name', label: 'Nombre', group: 'Identidad', type: 'text' },
  { key: 'last_name_1', label: 'Primer apellido', group: 'Identidad', type: 'text' },
  { key: 'last_name_2', label: 'Segundo apellido', group: 'Identidad', type: 'text' },
  { key: 'sex', label: 'Sexo', group: 'Identidad', type: 'select', options: [['M', 'Mujer'], ['H', 'Hombre'], ['X', 'Otro']] },
  { key: 'birth_date', label: 'Fecha de nacimiento', group: 'Identidad', type: 'date' },
  { key: 'nationality', label: 'Nacionalidad', group: 'Identidad', type: 'country' },
  { key: 'guardian_name', label: 'Si es menor: persona responsable', group: 'Identidad', type: 'text', hint: 'Madre, padre o tutor que le acompaña o autoriza.' },
  { key: 'kinship', label: 'Si es menor: parentesco con esa persona', group: 'Identidad', type: 'text' },
  { key: 'document_type', label: 'Tipo de documento', group: 'Documento', type: 'select', options: [['DNI', 'DNI'], ['NIE', 'NIE'], ['Pasaporte', 'Pasaporte'], ['TIE', 'Tarjeta de residencia (TIE)'], ['Otro', 'Otro']] },
  { key: 'document_number', label: 'Número de documento', group: 'Documento', type: 'text' },
  { key: 'document_support_number', label: 'Número de soporte', group: 'Documento', type: 'text', hint: 'En el DNI y el NIE, el código de la cara delantera (por ejemplo, ABC123456).' },
  { key: 'residence_address', label: 'Dirección', group: 'Residencia', type: 'text' },
  { key: 'residence_postal_code', label: 'Código postal', group: 'Residencia', type: 'text' },
  { key: 'residence_city', label: 'Población', group: 'Residencia', type: 'text' },
  { key: 'residence_country', label: 'País', group: 'Residencia', type: 'country' },
  { key: 'phone', label: 'Teléfono', group: 'Contacto', type: 'tel' },
  { key: 'email', label: 'Correo electrónico', group: 'Contacto', type: 'email' },
];

/** Lo que se pide sin registro de viajeros (modo `operativo`): nunca documento, dirección, nacimiento ni firma. */
const OPERATIVE = new Set(['first_name', 'last_name_1', 'phone', 'email']);
export const fieldsFor = (mode: GuestMode): FieldSpec[] => (mode === 'ses' ? GUEST_FIELDS : mode === 'operativo' ? GUEST_FIELDS.filter((f) => OPERATIVE.has(f.key)) : []);

export const MISSING_LABELS: Record<string, string> = {
  first_name: 'nombre', last_name_1: 'primer apellido', last_name_2: 'segundo apellido', birth_date: 'fecha de nacimiento',
  residence_address: 'dirección', residence_postal_code: 'código postal', residence_city: 'población', residence_country: 'país',
  contact: 'teléfono o correo', kinship: 'parentesco', document_type: 'tipo de documento', document_number: 'documento',
  document_support_number: 'número de soporte',
};
export const missingText = (missing: readonly string[]) => missing.map((m) => MISSING_LABELS[m] ?? m).join(', ');

/** Países habituales (código ISO de tres letras que pide el registro de viajeros) y «Otro país». */
export const COUNTRIES: Array<[string, string]> = [
  ['ESP', 'España'], ['PRT', 'Portugal'], ['FRA', 'Francia'], ['ITA', 'Italia'], ['DEU', 'Alemania'], ['GBR', 'Reino Unido'], ['IRL', 'Irlanda'],
  ['NLD', 'Países Bajos'], ['BEL', 'Bélgica'], ['CHE', 'Suiza'], ['AUT', 'Austria'], ['POL', 'Polonia'], ['ROU', 'Rumanía'], ['SWE', 'Suecia'],
  ['DNK', 'Dinamarca'], ['NOR', 'Noruega'], ['MAR', 'Marruecos'], ['USA', 'Estados Unidos'], ['CAN', 'Canadá'], ['MEX', 'México'],
  ['ARG', 'Argentina'], ['CHL', 'Chile'], ['COL', 'Colombia'], ['PER', 'Perú'], ['VEN', 'Venezuela'], ['URY', 'Uruguay'], ['ECU', 'Ecuador'], ['BRA', 'Brasil'],
];

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

/** «del 12 al 15 de marzo», «del 30 de abril al 2 de mayo», «del 28 de diciembre de 2026 al 2 de enero de 2027». */
export function dateRange(start: string | null, end: string | null): string {
  if (!start) return 'Fechas por concretar';
  const [y1, m1, d1] = parts(start);
  if (!end || end === start) return `${d1} de ${MONTHS[m1 - 1]} de ${y1}`;
  const [y2, m2, d2] = parts(end);
  if (y1 !== y2) return `del ${d1} de ${MONTHS[m1 - 1]} de ${y1} al ${d2} de ${MONTHS[m2 - 1]} de ${y2}`;
  if (m1 !== m2) return `del ${d1} de ${MONTHS[m1 - 1]} al ${d2} de ${MONTHS[m2 - 1]} de ${y1}`;
  return `del ${d1} al ${d2} de ${MONTHS[m1 - 1]} de ${y1}`;
}

/** «3 de marzo» (hora de Madrid) para fechas con hora. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' }).format(d);
}

export function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(iso));
}

/** «10:30» desde una hora de Postgres («10:30:00»). */
export const hourLabel = (time: string | null) => (time ? time.slice(0, 5) : null);
