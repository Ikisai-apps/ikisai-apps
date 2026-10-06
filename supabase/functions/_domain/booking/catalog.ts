/** Ikisai Booking · catálogos cerrados. Deben coincidir con los `check` de las migraciones `*_booking_*`. */

export const TABLES = {
  reservations: 'booking.reservations',
  finance: 'booking.reservation_finance',
  events: 'booking.events',
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
