/** SES.HOSPEDAJES (API §17.2, §17.4): llamadas de la app. Las reglas (plazo, cambios, bandeja) viven en el dominio y se reexportan aquí. */
import type { SyncClient } from '@ikisai/sync-client';
import type { SesCommunication, SesOverviewData } from '@ikisai/domain-booking';

export {
  COMMUNICABLE_STATUSES, DEADLINE_TEXT, HOUR, LIVE_STATUSES, PV_IN_PROCESS, SES_AREAS, SES_ERROR_FIELD, SES_PROBLEM_AREAS,
  acceptedReservationComm, changedSinceCommunicated, deadlineLevel, deadlineOf, guestReports, liveReservationComm, paymentDateIsOld,
  pendingCancellation, reservationComms, sesErrorTarget, sesOverview, sesRowOf,
  type Deadline, type DeadlineLevel, type ReservationShape, type SesAction, type SesArea, type SesCommunication, type SesErrorTarget,
  type SesGuestCounts, type SesOverview, type SesOverviewData, type SesOverviewItem, type SesRow, type SesStatus,
} from '@ikisai/domain-booking';

export async function fetchSes(client: SyncClient, reservationId: string): Promise<SesCommunication[]> {
  const out = await client.api<{ items?: SesCommunication[] }>(`/ses/${encodeURIComponent(reservationId)}`);
  return [...(out.items ?? [])].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
}

/** B2: estado de SES de las reservas que importan, en una llamada (editor y owner). */
export const fetchSesOverview = (client: SyncClient): Promise<SesOverviewData> => client.api<SesOverviewData>('/ses');
