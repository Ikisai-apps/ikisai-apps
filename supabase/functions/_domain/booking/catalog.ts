/** Ikisai Booking · catálogos cerrados. Deben coincidir con los `check` de las migraciones `*_booking_*`. */

export const TABLES = {
  reservations: 'booking.reservations',
  finance: 'booking.reservation_finance',
  events: 'booking.events',
  guests: 'booking.guests',
  restrictions: 'booking.dietary_restrictions',
  checklist: 'booking.checklist_items',
  spaces: 'booking.spaces',
  beds: 'booking.beds',
  roomAssignments: 'booking.room_assignments',
} as const;

/** Lecturas registradas con `core.allow_read` (ruta `/api/v1/read/:name`). */
export const READS = {
  guestSummary: 'booking.guest_summary',
  foodEventProjection: 'booking.food_event_projection',
} as const;

export const PROCEDURES = {
  confirmReservation: 'booking.confirm_reservation',
} as const;

export const EVENT_TYPES = ['retiro', 'convivencia', 'formacion', 'encuentro', 'actividad_divulgativa', 'alquiler_grupo', 'otro'] as const;
export const RESERVATION_STATUSES = ['en_estudio', 'negociacion', 'pre_reservada', 'confirmada', 'en_ejecucion', 'cerrada', 'cancelada', 'perdida'] as const;
export const PRIORITIES = ['alta', 'media', 'baja'] as const;
export const CUSTOMER_TYPES = ['particular', 'empresa', 'asociacion', 'colectivo', 'organizador_recurrente'] as const;
export const MEAL_PLANS = ['no_aplica', 'desayuno', 'media_pension', 'pension_completa', 'segun_programa'] as const;
export const MENU_STYLES = ['vegetariano', 'vegano', 'mixto', 'otro'] as const;
export const PAYMENT_TYPES = ['efectivo', 'tarjeta', 'transferencia', 'plataforma_pago', 'otro'] as const;

export const SETUP_STYLES = ['no_aplica', 'basico', 'circulo', 'formacion', 'escenario', 'personalizado'] as const;
export const TECHNICAL_NEEDS = ['ninguna', 'wifi', 'sonido', 'proyeccion', 'mixto', 'personalizado'] as const;
/** Preparación y limpieza (femenino en C04: «hecha»). */
export const TASK_STATUSES_F = ['pendiente', 'en_proceso', 'hecha'] as const;
/** Alojamiento y cocina (pueden no aplicar). */
export const TASK_STATUSES_M = ['no_aplica', 'pendiente', 'en_proceso', 'hecho'] as const;
export const TRAVELER_REGISTRATION_STATUSES = ['no_aplica', 'pendiente', 'en_curso', 'completo'] as const;

export const SEXES = ['H', 'M', 'X'] as const;
export const DOCUMENT_TYPES = ['DNI', 'NIE', 'Pasaporte', 'TIE', 'Otro'] as const;
export const GUEST_DATA_STATUSES = ['pendiente_datos', 'datos_incompletos', 'datos_recibidos', 'datos_revisados', 'no_aplica'] as const;
export const SES_STATUSES = ['pendiente_envio', 'listo_para_envio', 'enviado_SES', 'incidencia_envio', 'no_aplica'] as const;

export const RESTRICTION_TYPES = ['alergia', 'intolerancia', 'vegetariano', 'vegano', 'sin_gluten', 'sin_lactosa', 'preferencia', 'otra'] as const;
export const RESTRICTION_SEVERITIES = ['grave', 'moderada', 'leve'] as const;
/** Tipos que admiten gravedad: una preferencia nunca se registra como alergia. */
export const RESTRICTION_TYPES_WITH_SEVERITY: readonly string[] = ['alergia', 'intolerancia'];
/** Tipos que exigen indicar el alérgeno o producto. */
export const RESTRICTION_TYPES_WITH_SUBJECT: readonly string[] = ['alergia', 'intolerancia', 'otra'];

export const CHECKLIST_TYPES = ['preparacion_general', 'alojamiento', 'cocina_comedor', 'salas', 'salida_rotacion'] as const;
export const CHECKLIST_STATUSES = ['pendiente', 'hecho', 'no_aplica'] as const;

export const SPACE_KINDS = ['habitacion', 'sala', 'zona_exterior', 'otro'] as const;
export const BED_KINDS = ['individual', 'doble', 'litera', 'sofa_cama', 'supletoria'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];
export type BedKind = (typeof BED_KINDS)[number];

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type RestrictionType = (typeof RESTRICTION_TYPES)[number];
export type ChecklistType = (typeof CHECKLIST_TYPES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export type MealPlan = (typeof MEAL_PLANS)[number];
export type MenuStyle = (typeof MENU_STYLES)[number];
export type PaymentType = (typeof PAYMENT_TYPES)[number];

/** Estados en los que la reserva debe tener evento operativo vivo (invariante `EVENT_REQUIRED`). */
export const STATUSES_REQUIRING_EVENT: readonly ReservationStatus[] = ['confirmada', 'en_ejecucion', 'cerrada'];
/** Estados en los que la reserva puede no tener fechas ni número de personas. */
export const STATUSES_WITHOUT_DATES: readonly ReservationStatus[] = ['en_estudio', 'negociacion', 'cancelada', 'perdida'];
/** Estados desde los que no se puede confirmar sin reabrir antes. */
export const STATUSES_CLOSED_TO_CONFIRM: readonly ReservationStatus[] = ['cancelada', 'perdida'];

export const STATUS_LABELS: Record<ReservationStatus, string> = {
  en_estudio: 'En estudio',
  negociacion: 'Negociación',
  pre_reservada: 'Pre-reserva',
  confirmada: 'Confirmada',
  en_ejecucion: 'En ejecución',
  cerrada: 'Cerrada',
  cancelada: 'Cancelada',
  perdida: 'Perdida',
};
