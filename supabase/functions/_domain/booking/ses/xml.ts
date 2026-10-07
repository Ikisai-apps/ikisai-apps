/**
 * Ikisai Booking · SES.HOSPEDAJES (docs/booking/API.md §17.3): solicitudes de reserva (RH), parte de viajeros (PV) y
 * anulación, siguiendo los XSD oficiales v3.1.3 (`integrations/ses/`). Puro: sin red ni secretos.
 * El elemento raíz va calificado con el espacio de nombres de su XSD; los hijos no (los XSD no fijan `elementFormDefault`),
 * salvo en la anulación, cuyo XSD los califica.
 */

export const SES_NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  comunicacion: 'http://www.soap.servicios.hospedajes.mir.es/comunicacion',
  reserva: 'http://www.neg.hospedajes.mir.es/altaReservaHospedaje',
  parte: 'http://www.neg.hospedajes.mir.es/altaParteHospedaje',
  anulacion: 'http://www.neg.hospedajes.mir.es/anularComunicacion',
} as const;

/** Catálogos oficiales (instrucciones v1.1.0, §8). */
export const SES_DOCUMENT: Record<string, string> = { DNI: 'NIF', NIE: 'NIE', TIE: 'NIE', Pasaporte: 'PAS', Otro: 'OTRO' };
export const SES_SEX: Record<string, string> = { H: 'H', M: 'M', X: 'O' };
export const SES_PAYMENT: Record<string, string> = { efectivo: 'EFECT', tarjeta: 'TARJT', transferencia: 'TRANS', plataforma_pago: 'PLATF', otro: 'OTRO' };
export const SES_KINSHIP = ['AB', 'BA', 'BN', 'CD', 'CY', 'HJ', 'HR', 'NI', 'PM', 'SB', 'SG', 'TI', 'YN', 'TU', 'OT'] as const;

export class SesDataError extends Error {
  constructor(readonly field: string, message: string) { super(message); this.name = 'SesDataError'; }
}

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

type Node = string | null | undefined | false;
/** Elemento con texto (escapado) o con hijos ya construidos; los vacíos se omiten. */
function el(name: string, content: Node | Node[]): string {
  if (Array.isArray(content)) {
    const inner = content.filter(Boolean).join('');
    return inner ? `<${name}>${inner}</${name}>` : '';
  }
  if (content === null || content === undefined || content === false || content === '') return '';
  return `<${name}>${escapeXml(String(content).trim())}</${name}>`;
}
const cut = (value: string | null | undefined, max: number): string | null => {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
};
const required = (value: string | null | undefined, field: string, max: number): string => {
  const v = cut(value, max);
  if (!v) throw new SesDataError(field, `Falta «${field}».`);
  return v;
};
const country = (value: string | null | undefined): string | null => (value && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null);

export interface SesContract {
  /** Referencia del contrato: el código de la reserva. */
  reference: string;
  /** Fecha del contrato (AAAA-MM-DD): la del registro del pago (formalización). */
  contractDate: string;
  /** Entrada y salida (AAAA-MM-DD y hora HH:MM opcional). */
  startDate: string;
  endDate: string;
  arrivalTime?: string | null;
  departureTime?: string | null;
  persons: number;
  rooms?: number | null;
  internet?: boolean | null;
  payment: { type: string; date?: string | null; holder?: string | null };
}

function contract(c: SesContract): string {
  const at = (date: string, time: string | null | undefined, fallback: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new SesDataError('fechas', 'Las fechas de la reserva no son válidas.');
    const t = time && /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : fallback;
    return `${date}T${t}:00`;
  };
  if (!Number.isInteger(c.persons) || c.persons < 1) throw new SesDataError('numPersonas', 'Indica el número de personas.');
  const payType = SES_PAYMENT[c.payment.type] ?? (Object.values(SES_PAYMENT).includes(c.payment.type) ? c.payment.type : null);
  if (!payType) throw new SesDataError('tipoPago', 'Indica el tipo de pago.');
  return el('contrato', [
    el('referencia', required(c.reference, 'referencia', 50)),
    el('fechaContrato', c.contractDate),
    el('fechaEntrada', at(c.startDate, c.arrivalTime, '14:00')),
    el('fechaSalida', at(c.endDate, c.departureTime, '12:00')),
    el('numPersonas', String(c.persons)),
    c.rooms ? el('numHabitaciones', String(c.rooms)) : null,
    c.internet === true || c.internet === false ? el('internet', String(c.internet)) : null,
    el('pago', [el('tipoPago', payType), el('fechaPago', c.payment.date ?? null), el('titular', cut(c.payment.holder, 100))]),
  ]);
}

export interface SesAddress { address: string | null; postalCode: string | null; country: string | null; municipalityCode?: string | null; municipalityName?: string | null; complement?: string | null }
function address(a: SesAddress, requiredAll: boolean): string {
  if (!requiredAll && !a.address && !a.postalCode && !a.country) return '';
  const pais = country(a.country);
  if (!pais) throw new SesDataError('pais', 'Falta el país de residencia (código de tres letras).');
  return el('direccion', [
    el('direccion', required(a.address, 'direccion', 100)),
    el('direccionComplementaria', cut(a.complement, 100)),
    a.municipalityCode && /^\d{5}$/.test(a.municipalityCode) ? el('codigoMunicipio', a.municipalityCode) : null,
    el('nombreMunicipio', cut(a.municipalityName, 100)),
    el('codigoPostal', required(a.postalCode, 'codigoPostal', 20)),
    el('pais', pais),
  ]);
}

export interface SesPerson {
  role: 'TI' | 'VI';
  firstName: string | null;
  lastName1: string | null;
  lastName2?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  documentSupport?: string | null;
  birthDate?: string | null;
  nationality?: string | null;
  sex?: string | null;
  address?: SesAddress | null;
  phone?: string | null;
  email?: string | null;
  kinship?: string | null;
}

function person(p: SesPerson, kind: 'reserva' | 'parte'): string {
  const docType = p.documentType ? SES_DOCUMENT[p.documentType] ?? null : null;
  const email = p.email && /^[^@]+@[^.]+\..+$/.test(p.email.trim()) ? p.email.trim().slice(0, 250) : null;
  const kin = p.kinship && (SES_KINSHIP as readonly string[]).includes(p.kinship.trim().toUpperCase()) ? p.kinship.trim().toUpperCase() : null;
  if (kind === 'parte' && !p.birthDate) throw new SesDataError('fechaNacimiento', 'Falta la fecha de nacimiento.');
  return el('persona', [
    el('rol', p.role),
    el('nombre', required(p.firstName, 'nombre', 50)),
    el('apellido1', required(p.lastName1, 'apellido1', 50)),
    el('apellido2', cut(p.lastName2, 50)),
    docType ? el('tipoDocumento', docType) : null,
    docType ? el('numeroDocumento', cut(p.documentNumber, 15)) : null,
    kind === 'parte' && (docType === 'NIF' || docType === 'NIE') ? el('soporteDocumento', cut(p.documentSupport, 9)) : null,
    el('fechaNacimiento', p.birthDate ?? null),
    el('nacionalidad', country(p.nationality)),
    el('sexo', p.sex ? SES_SEX[p.sex] ?? null : null),
    p.address ? address(p.address, kind === 'parte') : kind === 'parte' ? address({ address: null, postalCode: null, country: null }, true) : null,
    el('telefono', cut(p.phone, 20)),
    el('correo', email),
    kind === 'parte' ? el('parentesco', kin) : null,
  ]);
}

/** Solicitud de alta de reserva de hospedaje (RH): una comunicación con el titular (el contacto del organizador). */
export function buildReservationRequest(input: { establishmentCode: string; contract: SesContract; holder: SesPerson }): string {
  return `<res:peticion xmlns:res="${SES_NS.reserva}">` + el('solicitud', [
    el('comunicacion', [
      el('establecimiento', [el('codigo', required(input.establishmentCode, 'codigoEstablecimiento', 10))]),
      contract(input.contract),
      person({ ...input.holder, role: 'TI' }, 'reserva'),
    ]),
  ]) + '</res:peticion>';
}

/** Solicitud de alta de parte de viajeros (PV): los huéspedes de una estancia. */
export function buildGuestReportRequest(input: { establishmentCode: string; contract: SesContract; guests: SesPerson[] }): string {
  if (input.guests.length === 0) throw new SesDataError('persona', 'No hay viajeros que comunicar.');
  return `<par:peticion xmlns:par="${SES_NS.parte}">` + el('solicitud', [
    el('codigoEstablecimiento', required(input.establishmentCode, 'codigoEstablecimiento', 10)),
    el('comunicacion', [contract(input.contract), ...input.guests.map((g) => person({ ...g, role: 'VI' }, 'parte'))]),
  ]) + '</par:peticion>';
}

/** Solicitud de anulación de comunicaciones ya aceptadas (operación B). */
export function buildCancellationRequest(codes: string[]): string {
  if (codes.length === 0) throw new SesDataError('codigoComunicacion', 'No hay comunicaciones que anular.');
  return `<anul:comunicaciones xmlns:anul="${SES_NS.anulacion}">`
    + codes.map((c) => `<anul:codigoComunicacion>${escapeXml(required(c, 'codigoComunicacion', 36))}</anul:codigoComunicacion>`).join('')
    + '</anul:comunicaciones>';
}
