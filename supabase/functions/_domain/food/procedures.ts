/** Ikisai Food · procedimientos `call` y validación de sus argumentos (docs/food/API.md §3). */
import { MENU_STATUSES, type EventSnapshot, type MenuStatus } from './menus.ts';

export const FOOD_PROCEDURES = {
  setMenuStatus: 'food.set_menu_status',
  acknowledgeEvent: 'food.acknowledge_event',
  validateMenu: 'food.validate_menu',
  regenerateShopping: 'food.regenerate_shopping',
  regeneratePreparation: 'food.regenerate_preparation',
} as const;

export interface AcknowledgedWarning {
  key: string;
  kind: string;
  text: string;
}

export interface SetMenuStatusArgs { menu_id: string; expectedRevision: number; status: MenuStatus }
export interface AcknowledgeEventArgs { menu_id: string; expectedRevision: number; event_revision: number; event_snapshot: EventSnapshot }
export interface ValidateMenuArgs extends AcknowledgeEventArgs { acknowledged: AcknowledgedWarning[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positiveInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Devuelve el nombre del argumento inválido de una llamada a un procedimiento de Food, o `null`. */
export function invalidCallArgument(procedure: string, args: Record<string, unknown>): string | null {
  if (!(Object.values(FOOD_PROCEDURES) as string[]).includes(procedure)) return null; // lo decide core.allowed_procedures
  if (typeof args.menu_id !== 'string' || !UUID.test(args.menu_id)) return 'menu_id';
  if (procedure === FOOD_PROCEDURES.regeneratePreparation) return null;
  if (procedure === FOOD_PROCEDURES.regenerateShopping) {
    // list_id: uuid que el cliente propone para la lista si todavía no existe.
    return typeof args.list_id === 'string' && UUID.test(args.list_id) ? null : 'list_id';
  }
  if (!positiveInteger(args.expectedRevision)) return 'expectedRevision';
  if (procedure === FOOD_PROCEDURES.setMenuStatus) {
    return typeof args.status === 'string' && (MENU_STATUSES as readonly string[]).includes(args.status) ? null : 'status';
  }
  if (!positiveInteger(args.event_revision)) return 'event_revision';
  if (!args.event_snapshot || typeof args.event_snapshot !== 'object' || Array.isArray(args.event_snapshot)) return 'event_snapshot';
  if (procedure === FOOD_PROCEDURES.validateMenu) {
    const list = args.acknowledged;
    if (!Array.isArray(list) || list.length > 500) return 'acknowledged';
    if (list.some((w) => !w || typeof w !== 'object' || typeof (w as AcknowledgedWarning).key !== 'string' || typeof (w as AcknowledgedWarning).kind !== 'string' || typeof (w as AcknowledgedWarning).text !== 'string')) return 'acknowledged';
  }
  return null;
}
