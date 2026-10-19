/**
 * Ikisai Food · recorrido de una máquina que falla (tanda 27, MUELA-068 §4; regla de VG del 19-10-2026):
 * Falla · Avisado · En reparación · Funciona, con datos reales y sin deducir nada.
 * - Funciona: está operativa.
 * - Falla: limitada, averiada o fuera de servicio, y nadie ha avisado a Tasks desde que tiene ese estado.
 * - Avisado: hay un aviso a Tasks (`food.equipment_notices`, 1104) desde que tiene ese estado.
 * - En reparación: solo si Tasks dice que la petición está en curso (`open`). El worker de Food copia el estado de Tasks
 *   (#606) en el aviso (`request_status`, 1106). `pending` sigue «Avisado»; `done`, `dismissed`, `deleted` (ya no hay
 *   reparación en curso) y `unknown` (el aviso no llegó) vuelven a «Falla», con «Avisar a Tasks».
 * Debajo de la etapa, siempre la palabra del estado («Falla · averiada»): no se pierde «Limitado», «Averiado» ni
 * «Fuera de servicio».
 */
import type { Equipment, EquipmentStatus, SyncedColumns } from './catalog.ts';

export interface EquipmentNotice extends SyncedColumns {
  equipment_id: string;
  notified_on: string;
  equipment_status: Exclude<EquipmentStatus, 'operativo'>;
  task_id: string;
  /** Estado de la petición en Tasks, copiado por el worker (1106); `null` mientras no se ha mirado. */
  request_status?: TaskRequestStatus | null;
}

export type EquipmentStage = 'falla' | 'avisado' | 'en_reparacion' | 'funciona';
export const EQUIPMENT_STAGES: readonly EquipmentStage[] = ['falla', 'avisado', 'en_reparacion', 'funciona'];

/** Estado de una petición en Tasks, cuando llegue (pedido a Core). `open` es «en curso». */
export type TaskRequestStatus = 'pending' | 'open' | 'done' | 'dismissed' | 'deleted' | 'unknown';

/** Peticiones que ya no llevan a una reparación en curso: la máquina vuelve a «Falla» y se puede avisar otra vez. */
const CLOSED_REQUESTS = new Set<TaskRequestStatus>(['done', 'dismissed', 'deleted', 'unknown']);

export interface EquipmentJourney {
  stage: EquipmentStage;
  /** La palabra del estado de la máquina, siempre a la vista bajo la etapa. */
  status: EquipmentStatus;
  /** El último aviso desde que tiene este estado, si lo hay. */
  notice: EquipmentNotice | null;
}

export function equipmentJourney(
  equipment: Pick<Equipment, 'id' | 'status'> & { status_since?: string | null },
  notices: EquipmentNotice[],
  requestStatus?: (taskId: string) => TaskRequestStatus | undefined,
): EquipmentJourney {
  if (equipment.status === 'operativo') return { stage: 'funciona', status: equipment.status, notice: null };
  const since = equipment.status_since ? Date.parse(equipment.status_since) : Number.NEGATIVE_INFINITY;
  const notice = notices
    .filter((n) => !n.deleted_at && n.equipment_id === equipment.id && Date.parse(n.created_at) >= since)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  if (!notice) return { stage: 'falla', status: equipment.status, notice: null };
  const request = requestStatus?.(notice.task_id) ?? notice.request_status ?? null;
  if (request === 'open') return { stage: 'en_reparacion', status: equipment.status, notice };
  if (request && CLOSED_REQUESTS.has(request)) return { stage: 'falla', status: equipment.status, notice: null };
  return { stage: 'avisado', status: equipment.status, notice };
}
