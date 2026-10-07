/** Etiquetas en español de los catálogos del dominio, como pares [valor, etiqueta] para los desplegables. */
import {
  BED_KINDS, SPACE_KINDS, NEED_PRIORITIES, NEED_STATUSES, NEED_TYPES, STAFF_FUNCTIONS, STAFF_STATUSES, CHECKLIST_STATUSES, CUSTOMER_TYPES, DOCUMENT_TYPES, EVENT_TYPES, GUEST_DATA_STATUSES, MEAL_PLANS, MENU_STYLES, PAYMENT_TYPES, PRIORITIES,
  PROPOSAL_NATURES, PROPOSAL_STATUSES, RATE_LAYERS, RATE_SERVICES, RATE_UNITS, RESERVATION_STATUSES, RESTRICTION_SEVERITIES, RESTRICTION_TYPES, SES_STATUSES, SETUP_STYLES, SEXES, STATUS_LABELS, TASK_STATUSES_F,
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
  habitacion: 'Habitación', sala: 'Sala', zona_exterior: 'Zona exterior',
  coordinacion_general: 'Coordinación general', acogida_grupo: 'Acogida del grupo', cocina: 'Cocina', apoyo_cocina: 'Apoyo de cocina', limpieza_previa: 'Limpieza previa',
  limpieza_rotacion: 'Limpieza de rotación', mantenimiento_guardia: 'Mantenimiento de guardia', soporte_tecnico: 'Soporte técnico', apoyo_logistico: 'Apoyo logístico', cierre_evento: 'Cierre del evento',
  prevista: 'Prevista', realizada: 'Realizada',
  limpieza: 'Limpieza', mantenimiento: 'Mantenimiento', tecnico: 'Soporte técnico', acogida: 'Acogida', urgente: 'Urgente',
  detectado: 'Detectado', buscando: 'Buscando', cubierto: 'Cubierto',
  individual: 'Individual', doble: 'Doble', litera: 'Litera', sofa_cama: 'Sofá cama', supletoria: 'Supletoria',
};

export function label(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return LABELS[String(value)] ?? String(value);
}

/** Categorías de gasto de Invoices (catálogo cerrado suyo), para el bloque «Coste real». */
const EXPENSE_CATEGORIES: Record<string, string> = {
  compras: 'Compras', suministros: 'Suministros', mantenimiento: 'Mantenimiento', inversiones: 'Inversiones', canon_concesion: 'Canon de concesión',
  seguros: 'Seguros', personal: 'Personal', fiscalidad: 'Fiscalidad', otros: 'Otros',
};

export function expenseCategoryLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Sin categoría';
  return EXPENSE_CATEGORIES[String(value)] ?? String(value);
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
  spaceKind: pairs(SPACE_KINDS),
  bedKind: pairs(BED_KINDS),
  staffFunction: pairs(STAFF_FUNCTIONS),
  staffStatus: pairs(STAFF_STATUSES),
  needType: pairs(NEED_TYPES),
  needPriority: pairs(NEED_PRIORITIES),
  needStatus: pairs(NEED_STATUSES),
} as const;

/** Tarifario y propuestas (aparte de `LABELS`: «cerrada» ya es un estado de reserva). */
export const RATE_LABELS = {
  layer: { recinto: 'Recinto', por_persona: 'Por persona', servicio: 'Servicio', ajuste: 'Ajuste', extra: 'Extras' } as Record<string, string>,
  unit: { persona_noche: 'Persona y noche', persona_dia: 'Persona y día', dia: 'Día', noche: 'Noche', estancia: 'Estancia', unidad: 'Unidad', porcentaje: 'Porcentaje' } as Record<string, string>,
  /** Cómo se lee tras «€ /»: «40,00 € / persona y noche». */
  per: { persona_noche: 'persona y noche', persona_dia: 'persona y día', dia: 'día', noche: 'noche', estancia: 'estancia', unidad: 'unidad' } as Record<string, string>,
  service: { alojamiento: 'Alojamiento', comidas: 'Comidas', centro_interpretacion: 'Centro de interpretación', exterior: 'Exteriores', piscina: 'Piscina', montaje: 'Montaje especial', tecnico: 'Soporte técnico', cama_supletoria: 'Camas supletorias' } as Record<string, string>,
  status: { borrador: 'Borrador', enviada: 'Enviada', aceptada: 'Aceptada', rechazada: 'Rechazada', caducada: 'Caducada', sustituida: 'Sustituida' } as Record<string, string>,
  nature: { orientativa: 'Orientativa', cerrada: 'Cerrada' } as Record<string, string>,
};
const rateOptions = (values: readonly string[], dict: Record<string, string>): Pairs => values.map((value) => [value, dict[value] ?? value] as const);
export const RATE_OPTIONS = {
  layer: rateOptions(RATE_LAYERS, RATE_LABELS.layer),
  unit: rateOptions(RATE_UNITS, RATE_LABELS.unit),
  service: rateOptions(RATE_SERVICES, RATE_LABELS.service),
  status: rateOptions(PROPOSAL_STATUSES, RATE_LABELS.status),
  nature: rateOptions(PROPOSAL_NATURES, RATE_LABELS.nature),
} as const;

/** Registro de viajeros (API §17.1): motivos para no comunicar una reserva a SES y ayuda según el modo de datos de huéspedes. */
export const SES_REASON_LABELS: Record<string, string> = {
  uso_privado: 'Uso privado sin contraprestación', prueba: 'Prueba', otro: 'Otro',
};
export const GUEST_MODE_HELP: Record<'ses' | 'operativo' | 'ninguno', string> = {
  ses: 'Se piden los datos del registro de viajeros y la firma',
  operativo: 'Solo nombre, contacto, alergias y dieta',
  ninguno: 'Sin lista de huéspedes ni enlaces de huésped',
};
export const SES_ENVIRONMENT_LABELS: Record<string, string> = { pre: 'Pruebas (PRE)', prod: 'Real (PROD)' };
/** «Sin comunicar a SES: uso privado sin contraprestación» (con «Otro», la nota escrita). */
export function sesReasonText(reason: unknown, note: unknown): string {
  if (reason === 'otro') return `Otro: ${typeof note === 'string' && note ? note : '—'}`;
  const text = SES_REASON_LABELS[String(reason)] ?? 'sin motivo';
  return text.charAt(0).toLowerCase() + text.slice(1);
}
