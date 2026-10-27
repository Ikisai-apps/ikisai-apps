/**
 * Ikisai Flow · código de dominio compartido entre la Edge `flow-api` y el frontend (contrato §5.4).
 * Modelo y procedimientos: docs/flow/API.md (migración 0900).
 */

/** Id de la app en `core.apps`. */
export const APP = 'flow';

/** Tablas sincronizables de Flow (`flow.*`). */
export const TABLES = {
  projects: 'flow.projects',
  customers: 'flow.customers',
  columns: 'flow.columns',
  products: 'flow.products',
  productComponents: 'flow.product_components',
  orders: 'flow.orders',
  orderLines: 'flow.order_lines',
  payments: 'flow.payments',
  units: 'flow.units',
  events: 'flow.events',
  dayClosures: 'flow.day_closures',
  buffers: 'flow.buffers',
  consumptionRules: 'flow.consumption_rules',
  projectDocuments: 'flow.project_documents',
  templateUnits: 'flow.template_units',
  templateColumnPatches: 'flow.template_column_patches',
} as const satisfies Record<string, `flow.${string}`>;

/** Procedimientos `call` permitidos (API.md §3). */
export const PROCEDURES = {
  confirmPayment: 'flow.confirm_payment',
  adjustPaidOrder: 'flow.adjust_paid_order',
  reversePayment: 'flow.reverse_payment',
  unitStep: 'flow.unit_step',
  deliverOrder: 'flow.deliver_order',
  reopenOrder: 'flow.reopen_order',
  createExtension: 'flow.create_extension',
  confirmRefund: 'flow.confirm_refund',
  closeDay: 'flow.close_day',
  markClosureSent: 'flow.mark_closure_sent',
  unitSetQty: 'flow.unit_set_qty',
  generateIngredientTasks: 'flow.generate_ingredient_tasks',
  unitLinkExternal: 'flow.unit_link_external',
  newVersion: 'flow.new_version',
  stationSetParams: 'flow.station_set_params',
} as const;

/** Refresco entre móviles (P-3, aprobado por Core): pull cada 3 s con la app visible; el sync-client para en segundo plano. */
export const PULL_INTERVAL_MS = 3_000;

export type ColumnKey = 'order' | 'prep' | 'service' | 'logistics';
export type ColumnBehavior = 'inspect_confirm' | 'quick_steps' | 'free_task';
export type OrderStatus = 'open' | 'paid' | 'delivered';
export type UnitStatus = 'proposed' | 'pending' | 'in_progress' | 'done' | 'cancelled';
export type PayMethod = 'cash' | 'bizum';
export type DeliveryIdent = 'number' | 'qr' | 'presence' | 'skipped';

/** Siguiente estado de un toque (§5, §7). Una unidad cancelada no avanza. */
export function nextUnitStatus(status: UnitStatus): UnitStatus | null {
  switch (status) {
    case 'proposed': return 'pending';
    case 'pending': return 'in_progress';
    case 'in_progress': return 'done';
    case 'done': return 'pending';
    default: return null;
  }
}

export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = { proposed: 'Propuesta', pending: 'Pendiente', in_progress: 'En curso', done: 'Terminado', cancelled: 'Cancelado' };
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = { open: 'Pendiente de cobro', paid: 'Cobrado', delivered: 'Entregado' };
export const PAY_METHOD_LABELS: Record<PayMethod, string> = { cash: 'Efectivo', bizum: 'Bizum' };

/** Mensajes de los errores de dominio de los procedimientos y de la guarda (migración 0900). */
export const FLOW_ERRORS: Record<string, string> = {
  ORDER_NOT_OPEN: 'Este pedido ya está cobrado: para cambiarlo, corrige el pedido cobrado.',
  ORDER_EMPTY: 'El pedido no tiene productos.',
  ORDER_NOT_PAID: 'Este pedido no está cobrado.',
  ORDER_NOT_DELIVERED: 'Este pedido no está entregado.',
  ORDER_ALREADY_DELIVERED: 'Este pedido ya está entregado.',
  ORDER_HAS_PAYMENTS: 'Un pedido con cobros no se borra: anula el cobro.',
  PRODUCT_INACTIVE: 'Hay un producto que ya no está en la carta.',
  UNIT_CHANGED: 'Otra persona ha cambiado esta tarjeta antes.',
  UNIT_CANCELLED: 'Esta tarjeta está cancelada.',
  DELIVERY_NEEDS_CONFIRMATION: 'Faltan montaditos por terminar o líneas por revisar.',
  PROCEDURE_ONLY: 'Esto solo se cambia con su botón.',
  MONEY_BACK_FORBIDDEN: 'Solo quien cobró o el encargado puede devolver o anular.',
  REDUCTION_NEEDS_CONFIRMATION: 'Hay montaditos ya empezados, terminados o entregados: confirma la corrección.',
  USE_EXTENSION: 'Lo que se añade tras cobrar va en una ampliación con su propio cobro.',
  REFUND_NOT_PENDING: 'Esa devolución ya está confirmada.',
  OFFLINE: 'Esta acción necesita conexión.',
  PROJECT_OUT_OF_SCOPE: 'Este flujo no es tuyo: pide acceso a Dirección.',
  NEEDS_ACCESS: 'Tu cuenta no tiene acceso a esa app: pide acceso a Dirección.',
  NO_FOOD_MENU: 'Este flujo no está ligado a una carta de Food: actualiza la carta desde Food primero.',
  APP_UNAVAILABLE: 'La otra app no responde ahora mismo. Inténtalo más tarde.',
  ENTRY_LOCKED: 'Finance ya entregó ese día a la gestoría: no se puede sustituir.',
  INVALID_FILE: 'Ese archivo no vale aquí: sube una imagen (o un PDF en documentos) ya terminada de subir.',
  UNSUPPORTED_MEDIA: 'Ese tipo de archivo no se admite: imágenes (webp, jpeg, png) o PDF.',
  PAYLOAD_TOO_LARGE: 'El archivo es demasiado grande (15 MB como máximo).',
  FLOW_FROZEN: 'Esta versión del flujo está congelada: crea una versión nueva para cambiar su configuración.',
  NO_TASKS_PROJECT: 'Este flujo aún no tiene proyecto de Tasks: el encargado lo elige en el Inicio del flujo.',
  TASKS_PROJECT_GONE: 'El proyecto de Tasks de este flujo ya no existe o no lo ves: elige otro.',
  PROJECT_ARCHIVED: 'Ese proyecto de Tasks está archivado: elige otro.',
  EXTERNAL_REF_IN_USE: 'Esta tarea ya se pidió a Tasks en otro proyecto.',
};

export * from './menu.ts';
export * from './scope.ts';
export * from './carta-sync.ts';
