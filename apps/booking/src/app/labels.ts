/** Etiquetas en español de los catálogos del dominio, como pares [valor, etiqueta] para los desplegables. */
import {
  CHECKLIST_STATUSES, CUSTOMER_TYPES, DOCUMENT_TYPES, EVENT_TYPES, GUEST_DATA_STATUSES, MEAL_PLANS, MENU_STYLES, PAYMENT_TYPES, PRIORITIES,
  RESERVATION_STATUSES, RESTRICTION_SEVERITIES, RESTRICTION_TYPES, SES_STATUSES, SETUP_STYLES, SEXES, STATUS_LABELS, TASK_STATUSES_F,
  TASK_STATUSES_M, TECHNICAL_NEEDS, TRAVELER_REGISTRATION_STATUSES,
} from '@ikisai/domain-booking';

type Pairs = ReadonlyArray<readonly [string, string]>;

const LABELS: Record<string, string> = {
  ...STATUS_LABELS,
  retiro: 'Retiro', convivencia: 'Convivencia', formacion: 'Formación', encuentro: 'Encuentro', actividad_divulgativa: 'Actividad divulgativa', alquiler_grupo: 'Alquiler de grupo', otro: 'Otro',
  alta: 'Alta', media: 'Media', baja: 'Baja',
  particular: 'Particular', empresa: 'Empresa', asociacion: 'Asociación', colectivo: 'Colectivo', organizador_recurrente: 'Organizador recurrente',
  no_aplica: 'No aplica', desayuno: 'Desayuno', media_pension: 'Media pensión', pension_completa: 'Pensión completa', segun_programa: 'Según programa',
  vegetariano: 'Vegetariano', vegano: 'Vegano', mixto: 'Mixto',
  efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', plataforma_pago: 'Plataforma de pago',
  basico: 'Básico', circulo: 'Círculo', escenario: 'Escenario', personalizado: 'Personalizado',
  ninguna: 'Ninguna', wifi: 'Wifi', sonido: 'Sonido', proyeccion: 'Proyección',
  pendiente: 'Pendiente', en_proceso: 'En proceso', hecha: 'Hecha', hecho: 'Hecho', en_curso: 'En curso', completo: 'Completo',
  H: 'Hombre', M: 'Mujer', X: 'Otro / no indicado',
  pendiente_datos: 'Pendiente de datos', datos_incompletos: 'Datos incompletos', datos_recibidos: 'Datos recibidos', datos_revisados: 'Datos revisados',
  pendiente_envio: 'Pendiente de envío', listo_para_envio: 'Listo para envío', enviado_SES: 'Enviado a SES', incidencia_envio: 'Incidencia de envío',
  alergia: 'Alergia', intolerancia: 'Intolerancia', sin_gluten: 'Sin gluten', sin_lactosa: 'Sin lactosa', preferencia: 'Preferencia', otra: 'Otra',
  grave: 'Grave', moderada: 'Moderada', leve: 'Leve',
};

export function label(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return LABELS[String(value)] ?? String(value);
}

const pairs = (values: readonly string[]): Pairs => values.map((value) => [value, LABELS[value] ?? value] as const);

export const OPTIONS = {
  eventType: pairs(EVENT_TYPES),
  status: pairs(RESERVATION_STATUSES),
  priority: pairs(PRIORITIES),
  customerType: pairs(CUSTOMER_TYPES),
  mealPlan: pairs(MEAL_PLANS),
  menuStyle: pairs(MENU_STYLES),
  paymentType: pairs(PAYMENT_TYPES),
  setupStyle: pairs(SETUP_STYLES),
  technicalNeeds: pairs(TECHNICAL_NEEDS),
  taskF: pairs(TASK_STATUSES_F),
  taskM: pairs(TASK_STATUSES_M),
  travelerRegistration: pairs(TRAVELER_REGISTRATION_STATUSES),
  sex: pairs(SEXES),
  documentType: pairs(DOCUMENT_TYPES),
  dataStatus: pairs(GUEST_DATA_STATUSES),
  sesStatus: pairs(SES_STATUSES),
  restrictionType: pairs(RESTRICTION_TYPES),
  severity: pairs(RESTRICTION_SEVERITIES),
  checklistStatus: pairs(CHECKLIST_STATUSES),
} as const;
