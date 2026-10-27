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
  accounts: 'flow.accounts',
  projectSettings: 'flow.project_settings',
  receipts: 'flow.receipts',
  definitions: 'flow.definitions',
  definitionVersions: 'flow.definition_versions',
  definitionSteps: 'flow.definition_steps',
  definitionStages: 'flow.definition_stages',
  boardHistory: 'flow.board_history',
  guideReceipts: 'flow.guide_receipts',
  executions: 'flow.executions',
  templateColumns: 'flow.template_columns',
  presenceMarks: 'flow.presence_marks',
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
  unitSetQty: 'flow.unit_set_qty',
  generateIngredientTasks: 'flow.generate_ingredient_tasks',
  newVersion: 'flow.new_version',
  stationSetParams: 'flow.station_set_params',
  openAccount: 'flow.open_account',
  chargeToAccount: 'flow.charge_to_account',
  settleAccount: 'flow.settle_account',
  assignGuestNumbers: 'flow.assign_guest_numbers',
  createFlow: 'flow.create_flow',
  markPresence: 'flow.mark_presence',
  deliverAll: 'flow.deliver_all',
  boardCard: 'flow.board_card',
  publishVersion: 'flow.publish_version',
  startStage: 'flow.start_stage',
  saveStageValues: 'flow.save_stage_values',
  finishStage: 'flow.finish_stage',
  guideConfirm: 'flow.guide_confirm',
  addObjective: 'flow.add_objective',
  verifyCriterion: 'flow.verify_criterion',
  recordResult: 'flow.record_result',
  saveTemplate: 'flow.save_template',
  payOrders: 'flow.pay_orders',
  setBufferContainers: 'flow.set_buffer_containers',
  startExecution: 'flow.start_execution',
  saveExecutionValues: 'flow.save_execution_values',
  finishExecution: 'flow.finish_execution',
} as const;

/** Refresco entre móviles (P-3, aprobado por Core): pull cada 3 s con la app visible; el sync-client para en segundo plano. */
export const PULL_INTERVAL_MS = 3_000;

export type ColumnKey = 'order' | 'prep' | 'service' | 'logistics';
export type ColumnBehavior = 'inspect_confirm' | 'quick_steps' | 'free_task' | 'guest_presence';
/**
 * Piezas del editor de flujos (0914): cada columna es una pieza conocida (su clave de datos), con su comportamiento fijo y
 * sus opciones. Debe coincidir con flow.piece_behavior / flow.piece_config.
 */
export const PIECES: ReadonlyArray<{ key: string; label: string; behavior: ColumnBehavior; hint: string; options?: ReadonlyArray<{ key: string; label: string }> }> = [
  { key: 'order', label: 'Pedido y cobro', behavior: 'inspect_confirm', hint: 'Caja: pedidos, cobro y número de cliente', options: [{ key: 'accounts', label: 'Cuentas del cliente' }] },
  { key: 'prep', label: 'Preparación', behavior: 'quick_steps', hint: 'Cocina: una tarjeta por montadito cobrado' },
  { key: 'ingredients', label: 'Ingredientes', behavior: 'quick_steps', hint: 'Propuestas de reposición y existencias', options: [{ key: 'fresh_stock', label: 'Punto «fresco» y «Comprar X»' }] },
  { key: 'service', label: 'Servicio y entrega', behavior: 'inspect_confirm', hint: 'Entrega de lo cobrado', options: [{ key: 'complete_on_delivery', label: '«Dar por hecho y entregar»' }] },
  { key: 'logistics', label: 'Logística', behavior: 'free_task', hint: 'Tareas libres y puestos' },
  { key: 'arrival', label: 'Llegada', behavior: 'guest_presence', hint: 'Huéspedes por llegar (Booking)' },
  { key: 'bed', label: 'Cama', behavior: 'guest_presence', hint: 'Acompañar a su cama' },
  { key: 'signature', label: 'Firma', behavior: 'guest_presence', hint: 'Parte de viajeros pendiente' },
  { key: 'departure', label: 'Salida', behavior: 'guest_presence', hint: 'Huéspedes que se van (Booking)' },
];

/** Paso de una columna `guest_presence` (check-in, 0911). */
export type PresenceStage = 'arrival' | 'bed' | 'signature' | 'departure';
export type OrderStatus = 'open' | 'paid' | 'delivered';
export type UnitStatus = 'proposed' | 'pending' | 'in_progress' | 'done' | 'cancelled';
export type PayMethod = 'cash' | 'bizum';
/** Liquidación de una cuenta (0910): también con tarjeta. */
export type SettleMethod = PayMethod | 'card';
/** Métodos de la caja profunda (0917). */
export type CheckoutMethod = 'cash' | 'bizum' | 'card' | 'btc_ln' | 'btc_chain';
export const CHECKOUT_METHOD_LABELS: Record<CheckoutMethod, string> = { cash: 'Metálico', bizum: 'Bizum', card: 'Tarjeta', btc_ln: 'Bitcoin · Lightning', btc_chain: 'Bitcoin · on-chain' };
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
export const SETTLE_METHOD_LABELS: Record<SettleMethod, string> = { ...PAY_METHOD_LABELS, card: 'Tarjeta' };

/** Mensajes de los errores de dominio de los procedimientos y de la guarda (migración 0900). */
export const FLOW_ERRORS: Record<string, string> = {
  ORDER_NOT_OPEN: 'Este pedido ya está cobrado: para cambiarlo, corrige el pedido cobrado.',
  TOO_MANY_OPEN_ORDERS: 'Tienes varios pedidos sin cobrar: pásate por la barra antes de pedir más.',
  ORDER_EMPTY: 'El pedido no tiene productos.',
  EVENT_NOT_ACCESSIBLE: 'No tienes acceso a ese evento en Booking: pide acceso en Booking o al personal del evento.',
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
  ACCOUNTS_DISABLED: 'Esta versión del flujo no lleva cuentas.',
  ACCOUNT_ALREADY_OPEN: 'Ese cliente ya tiene una cuenta abierta.',
  ACCOUNT_NOT_OPEN: 'Esa cuenta ya está liquidada.',
  ACCOUNT_OPEN: 'Este pedido está en una cuenta abierta: no se corrige ni se anula hasta liquidarla.',
  ACCOUNT_SETTLED: 'Este pedido se pagó con su cuenta: corrígelo (la diferencia se devuelve), no se anula.',
  SETTLE_FORBIDDEN: 'Solo quien abrió la cuenta o el encargado puede liquidarla.',
  INVITATION_INVALID: 'Ese enlace no vale. Pide uno nuevo en la app de huéspedes.',
  INVITATION_EXPIRED: 'Ese enlace ha caducado. Ábrelo otra vez desde la app de huéspedes.',
  INVITATION_USED: 'Ese enlace ya se ha usado. Ábrelo otra vez desde la app de huéspedes.',
  NO_FLOW: 'Este evento no tiene la barra abierta ahora mismo.',
  EXECUTION_FINISHED: 'Este recorrido ya está terminado: empieza otro.',
  NO_BOOKING_EVENT: 'Este flujo aún no está ligado a su evento de Booking: el encargado lo liga en el Inicio.',
  SES_ALREADY_REGISTERED: 'Su llegada ya está comunicada a SES: no se puede deshacer desde aquí.',
  GUEST_ALREADY_LEFT: 'Este huésped ya se ha ido: deshaz la salida antes.',
  TEAM_GUEST: 'Es una ficha del equipo: su llegada no se marca.',
};

export * from './menu.ts';
export * from './scope.ts';
export * from './carta-sync.ts';
export * from './metrics.ts';
