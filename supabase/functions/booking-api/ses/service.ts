/**
 * Ikisai Booking · SES-2: comunicar la reserva (RH) con botón tras el pago, anularla y seguir sus lotes (API.md §17.2–§17.4).
 * Construye el XML con el dominio, lo envía con el transporte y deja el resultado con acciones del sistema (`booking.ses_*`).
 * Nunca guarda el XML ni el SOAP: solo la huella del contenido, el lote, el código y el error.
 */
import {
  batchOutcome, batchQueryEnvelope, buildCancellationRequest, buildReservationRequest, communicationEnvelope,
  parseBatchResponse, parseCommunicationResponse, SesDataError, type SesContract, type SesPerson,
} from '../../_domain/booking/ses/mod.ts';
import { sesCredentials, type SesCredentials, type SesEnvironment, type SesTransport } from './transport.ts';

export const SES_APPLICATION = 'Ikisai Booking';

export type SesInvoke = (name: string, args: Record<string, unknown>) => Promise<any>;
export interface SesDeps {
  /** Acciones del sistema (`core_invoke` sin actor). */
  invoke: SesInvoke;
  transport: SesTransport;
  env: (name: string) => string | undefined;
  /** Petición a Tasks por su ruta de worker (`booking.ses_deadline`); sin ella, los avisos quedan solo en la ficha e Inicio. */
  notifyTasks?: (request: TasksRequest) => Promise<boolean>;
}

/** Cuerpo de `POST /api/v1/worker/requests/task` de Tasks (identidad de servicio `booking`). */
export interface TasksRequest {
  source: 'booking';
  kind: 'booking.ses_deadline';
  kind_label: string;
  external_ref: string;
  title: string;
  note: string;
  due: string;
  priority: 'urgente';
  external_url: string;
}

/** Notificador real: la ruta de worker de Tasks con la clave de sistema. Devuelve si Tasks aceptó la petición. */
export function createTasksNotifier(env: (name: string) => string | undefined, fetchImpl: typeof fetch = fetch): ((request: TasksRequest) => Promise<boolean>) | undefined {
  const key = env('IKISAI_WORKER_KEY');
  if (!key) return undefined;
  const url = env('TASKS_WORKER_REQUEST_URL') ?? 'https://tasks.ikisai.com/api/v1/worker/requests/task';
  return async (request) => {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ikisai-worker-key': key }, body: JSON.stringify(request) });
      return res.ok;
    } catch {
      return false;
    }
  };
}

const BOOKING_URL = 'https://booking.ikisai.com';

/** Avisos de plazo: reservas con el pago registrado hace 12 h sin comunicación aceptada ni en proceso. Idempotente por reserva. */
async function deadlineNotices(deps: SesDeps): Promise<number> {
  if (!deps.notifyTasks) return 0;
  const { items } = (await deps.invoke('booking.ses_deadlines', {})) as { items: Array<{ reservation_id: string; code: string | null; title: string; legal_start_at: string }> };
  let sent = 0;
  for (const r of items) {
    const due = new Date(Date.parse(r.legal_start_at) + 24 * 3_600_000).toISOString();
    const ok = await deps.notifyTasks({
      source: 'booking', kind: 'booking.ses_deadline', kind_label: 'Comunicación a SES pendiente',
      external_ref: `${r.code ?? r.reservation_id}:deadline`,
      title: `Comunicar a SES la reserva ${r.code ?? ''}`.trim(),
      note: `Pago registrado hace más de 12 h sin comunicación aceptada. El plazo legal de 24 h vence el ${due.slice(0, 16).replace('T', ' ')} (UTC).`,
      due, priority: 'urgente', external_url: `${BOOKING_URL}/#/reservas/${r.reservation_id}`,
    });
    if (ok) { await deps.invoke('booking.ses_deadline_mark', { reservation_id: r.reservation_id, legal_start_at: r.legal_start_at }); sent++; }
  }
  return sent;
}

interface Source {
  reservation: { id: string; code: string | null; start_date: string | null; end_date: string | null; persons: number | null; contact_name: string | null;
    contact_phone: string | null; contact_email: string | null; arrival_time: string | null; departure_time: string | null; rooms: number | null };
  payment: { type: string | null; date: string | null; holder: string | null; registered_at: string; contract_date: string };
  settings: { environment: SesEnvironment; paused: boolean };
}

/** El titular es el contacto del organizador: primera palabra como nombre y el resto como apellidos. */
export function holderFromContact(name: string | null, phone: string | null, email: string | null): SesPerson {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) throw new SesDataError('titular', 'El contacto de la reserva necesita nombre y apellido para comunicarla a SES.');
  return { role: 'TI', firstName: parts[0]!, lastName1: parts[1]!, lastName2: parts.slice(2).join(' ') || null, phone, email };
}

export function reservationContract(source: Source): SesContract {
  const r = source.reservation;
  if (!r.start_date || !r.end_date) throw new SesDataError('fechas', 'La reserva necesita fechas de entrada y salida.');
  if (!source.payment.type) throw new SesDataError('tipoPago', 'Indica el tipo de pago en los importes de la reserva.');
  return {
    reference: r.code ?? r.id.slice(0, 50), contractDate: source.payment.contract_date, startDate: r.start_date, endDate: r.end_date,
    arrivalTime: r.arrival_time, departureTime: r.departure_time, persons: r.persons ?? 0, rooms: r.rooms,
    payment: { type: source.payment.type, date: source.payment.date, holder: source.payment.holder },
  };
}

function buildRh(source: Source, establishmentCode: string): string {
  const r = source.reservation;
  return buildReservationRequest({ establishmentCode, contract: reservationContract(source), holder: holderFromContact(r.contact_name, r.contact_phone, r.contact_email) });
}

const snapshotOf = (s: Source) => ({ start_date: s.reservation.start_date, end_date: s.reservation.end_date, persons: s.reservation.persons });

/** Envía una comunicación ya reclamada y deja el resultado. */
async function send(deps: SesDeps, id: string, environment: SesEnvironment, creds: SesCredentials, kind: 'RH' | 'anulacion', solicitud: string): Promise<string> {
  const { xml } = await communicationEnvelope({ landlordCode: creds.landlordCode, application: SES_APPLICATION, operation: kind === 'RH' ? 'A' : 'B', kind: kind === 'RH' ? 'RH' : undefined, solicitud });
  let response;
  try {
    response = await deps.transport.post(environment, xml, { user: creds.user, password: creds.password });
  } catch (error) {
    await deps.invoke('booking.ses_report', { id, outcome: 'error', error_code: 'NETWORK', error_text: error instanceof Error ? error.message.slice(0, 200) : 'Error de red' });
    return 'error';
  }
  if (response.status === 401 || response.status === 403) {
    await deps.invoke('booking.ses_report', { id, outcome: 'error', http_status: response.status, error_code: 'AUTH', error_text: 'SES rechazó las credenciales del servicio web.' });
    return 'error';
  }
  const parsed = parseCommunicationResponse(response.body);
  if (response.status >= 500 && parsed.code !== 0) {
    await deps.invoke('booking.ses_report', { id, outcome: 'error', http_status: response.status, error_code: `HTTP_${response.status}`, error_text: parsed.description || 'SES no responde.' });
    return 'error';
  }
  if (parsed.code === 0 && parsed.lot) {
    await deps.invoke('booking.ses_report', { id, outcome: 'submitted', http_status: response.status, lot_id: parsed.lot });
    return 'en_proceso';
  }
  await deps.invoke('booking.ses_report', { id, outcome: 'rejected', http_status: response.status, error_code: `SES_${parsed.code}`, error_text: parsed.description || 'SES rechazó la petición.' });
  return 'rechazada';
}

/** Botón «Comunicar reserva a SES». `source` lo lee la ruta con el usuario (comprueba su rol y que la reserva se puede comunicar). */
export async function sesCommunicateReservation(deps: SesDeps, source: Source, requestedBy: string | null): Promise<{ id: string; status: string }> {
  const environment = source.settings.environment;
  const creds = sesCredentials(deps.env, environment);
  // Sin credenciales todavía se valida igual el contenido con un código de prueba, para avisar de lo que falta ya.
  const solicitud = buildRh(source, creds?.establishmentCode ?? '0000000000');
  const prepared = await deps.invoke('booking.ses_prepare', {
    reservation_id: source.reservation.id, kind: 'RH', environment, snapshot: snapshotOf(source),
    legal_start_at: source.payment.registered_at, requested_by: requestedBy,
  });
  const id = prepared.id as string;
  if (source.settings.paused || !creds) {
    await deps.invoke('booking.ses_report', { id, outcome: 'held', error_code: source.settings.paused ? 'PAUSED' : 'NOT_CONFIGURED' });
    return { id, status: 'preparada' };
  }
  const claimed = await deps.invoke('booking.ses_claim', { id });
  if (!claimed) return { id, status: 'enviando' };
  return { id, status: await send(deps, id, environment, creds, 'RH', solicitud) };
}

/** Botón «Anular en SES» sobre una comunicación aceptada. */
export async function sesCancel(deps: SesDeps, input: { reservationId: string; communicationId: string; sesCode: string; environment: SesEnvironment; requestedBy: string | null }) {
  const creds = sesCredentials(deps.env, input.environment);
  const prepared = await deps.invoke('booking.ses_prepare', {
    reservation_id: input.reservationId, kind: 'anulacion', cancels_id: input.communicationId, environment: input.environment, requested_by: input.requestedBy,
  });
  const id = prepared.id as string;
  if (!creds) {
    await deps.invoke('booking.ses_report', { id, outcome: 'held', error_code: 'NOT_CONFIGURED' });
    return { id, status: 'preparada' };
  }
  const claimed = await deps.invoke('booking.ses_claim', { id });
  if (!claimed) return { id, status: 'enviando' };
  return { id, status: await send(deps, id, input.environment, creds, 'anulacion', buildCancellationRequest([input.sesCode])) };
}

/** Tick del planificador: envía lo preparado (si no está en pausa) o con error, y consulta los lotes en proceso. */
export async function sesTick(deps: SesDeps, limit = 10): Promise<{ sent: number; checked: number; skipped: number; notices: number }> {
  const due = (await deps.invoke('booking.ses_due', { limit })) as { items: Array<Record<string, any>> };
  let sent = 0; let checked = 0; let skipped = 0;
  const inProgress = due.items.filter((c) => c.status === 'en_proceso' && c.lot_id);
  for (const c of due.items.filter((c) => c.status === 'preparada' || c.status === 'error')) {
    const environment = c.environment as SesEnvironment;
    const creds = sesCredentials(deps.env, environment);
    let solicitud: string;
    try {
      if (c.kind === 'RH') {
        const source = (await deps.invoke('booking.ses_reservation_source_system', { reservation_id: c.reservation_id })) as Source;
        if (source.settings.paused || !creds) { await deps.invoke('booking.ses_report', { id: c.id, outcome: 'held', error_code: source.settings.paused ? 'PAUSED' : 'NOT_CONFIGURED' }); skipped++; continue; }
        solicitud = buildRh(source, creds.establishmentCode);
      } else if (c.kind === 'anulacion' && c.cancels_code) {
        if (!creds) { await deps.invoke('booking.ses_report', { id: c.id, outcome: 'held', error_code: 'NOT_CONFIGURED' }); skipped++; continue; }
        solicitud = buildCancellationRequest([c.cancels_code]);
      } else { skipped++; continue; }
    } catch (error) {
      const code = error instanceof SesDataError ? `DATA_${error.field}` : (error as { code?: string })?.code ?? 'SOURCE';
      await deps.invoke('booking.ses_report', { id: c.id, outcome: 'rejected', error_code: String(code).slice(0, 40), error_text: error instanceof Error ? error.message.slice(0, 300) : 'No se pudo preparar.' });
      continue;
    }
    if (!(await deps.invoke('booking.ses_claim', { id: c.id }))) continue;
    await send(deps, c.id, environment, creds!, c.kind === 'RH' ? 'RH' : 'anulacion', solicitud);
    sent++;
  }
  for (const environment of ['pre', 'prod'] as const) {
    const items = inProgress.filter((c) => c.environment === environment);
    const creds = sesCredentials(deps.env, environment);
    if (items.length === 0 || !creds) continue;
    let response;
    try {
      response = await deps.transport.post(environment, batchQueryEnvelope(items.map((c) => c.lot_id)), { user: creds.user, password: creds.password });
    } catch {
      for (const c of items) await deps.invoke('booking.ses_report', { id: c.id, operation: 'consultaLote', outcome: 'in_progress', error_code: 'NETWORK' });
      continue;
    }
    const parsed = parseBatchResponse(response.body);
    for (const c of items) {
      checked++;
      const batch = parsed.batches.find((b) => b.lot === c.lot_id);
      if (!batch) { await deps.invoke('booking.ses_report', { id: c.id, operation: 'consultaLote', http_status: response.status, outcome: 'in_progress', lot_id: c.lot_id }); continue; }
      const outcome = batchOutcome(batch.stateCode);
      const item = batch.items[0];
      if (outcome === 'en_proceso') {
        await deps.invoke('booking.ses_report', { id: c.id, operation: 'consultaLote', http_status: response.status, outcome: 'in_progress', lot_id: c.lot_id });
      } else if ((outcome === 'aceptado' || outcome === 'parcial') && item?.code) {
        await deps.invoke('booking.ses_report', { id: c.id, operation: 'consultaLote', http_status: response.status, outcome: 'accepted', lot_id: c.lot_id, ses_code: item.code });
      } else if (outcome === 'error') {
        await deps.invoke('booking.ses_report', { id: c.id, operation: 'consultaLote', http_status: response.status, outcome: 'error', lot_id: c.lot_id, error_code: `LOTE_${batch.stateCode}`, error_text: batch.stateText });
      } else {
        await deps.invoke('booking.ses_report', { id: c.id, operation: 'consultaLote', http_status: response.status, outcome: 'rejected', lot_id: c.lot_id,
          error_code: (item?.errorType ?? `LOTE_${batch.stateCode}`).slice(0, 40), error_text: item?.error ?? batch.stateText });
      }
    }
  }
  const notices = await deadlineNotices(deps);
  return { sent, checked, skipped, notices };
}
