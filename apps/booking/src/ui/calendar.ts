/** Calendario (API §9.3): ocupación mensual de días completos y estado de la sincronización con Google Calendar. */
import { confirmDialog, createCalendar, el, replace, toast, type CalendarEvent } from '@ikisai/ui-kit';
import type { SyncedRow } from '@ikisai/sync-client';
import { DATE_BLOCKS, RESERVATIONS, canRead, canWrite, dateRange, describeError, type ReservationRow } from '../app/client.ts';
import { fetchCalendarStatus, readCalendarCache, type CalendarHealth as Health, type CalendarStatus } from '../app/calendarStatus.ts';
import { openRowSheet, type FieldSpec } from './form.ts';
import { checkDateRange } from './dates.ts';
import type { ViewMount } from './shell.ts';

type Block = SyncedRow & { start_date: string; end_date: string; reason: string | null };

const BLOCK_SPECS: FieldSpec[] = [
  { key: 'start_date', label: 'Inicio', type: 'date' },
  { key: 'end_date', label: 'Fin', type: 'date' },
  { key: 'reason', label: 'Motivo interno', type: 'text', max: 300, optional: true, personal: true, hint: 'Solo lo ve el personal.' },
];

/** Colores como en Google Calendar; en estudio y negociación se pintan atenuadas por CSS (`data-status`). */
const COLORS: Record<string, string> = {
  pre_reservada: '#d9a400',
  confirmada: '#2e8b57',
  en_ejecucion: '#2b6cb0',
  cerrada: '#7d8590',
  en_estudio: '#a58b5b',
  negociacion: '#a58b5b',
};

const HEALTH_TEXT: Record<Health, string> = {
  ok: 'Sincronizado',
  not_configured: 'Calendar no está configurado todavía',
  calendar_not_shared: 'El calendario no está compartido con la cuenta de servicio de Ikisai: compártelo con permiso de hacer cambios en eventos',
  auth_error: 'Las credenciales de Google no son válidas',
  calendar_not_found: 'No se encuentra el calendario',
};

/** Tramo de día completo de entrada a salida (ambos incluidos); sin fechas, canceladas, perdidas, archivadas o borradas no se pintan. */
export function toCalendarEvent(row: ReservationRow): CalendarEvent | null {
  if (row.deleted_at !== null || row.archived_at !== null || !row.start_date || !row.end_date) return null;
  const color = COLORS[row.status];
  if (!color) return null;
  const pre = row.status === 'pre_reservada';
  return { id: row.id, title: pre ? `[PRE] ${row.title}` : row.title, start: row.start_date, end: row.end_date, color, status: row.status };
}

/** Tramo bloqueado como evento de día completo; el estado `bloqueo` lo distingue de las reservas (rayado por CSS). */
export function blockToCalendarEvent(row: Block): CalendarEvent | null {
  if (row.deleted_at !== null || !row.start_date || !row.end_date) return null;
  return { id: row.id, title: 'Bloqueado', start: row.start_date, end: row.end_date, color: '#6b7280', status: 'bloqueo' };
}

export const mountCalendar: ViewMount = ({ main, client, navigate }) => {
  const writable = canWrite(client);
  let titles = new Map<string, string>();
  const showBlocks = writable && canRead(client, DATE_BLOCKS);
  const blocksBody = el('div', { id: 'dateBlocksBody' });
  const blocksCard = showBlocks ? el('article', { class: 'card', id: 'blockDateBlocks', style: 'margin-top:16px', 'data-feedback-id': 'booking.calendario.bloqueos', 'data-feedback-label': 'Fechas bloqueadas' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Fechas bloqueadas')), blocksBody) : null;
  const calendarHost = el('div', { id: 'calendarHost', 'data-feedback-id': 'booking.calendario.mes', 'data-feedback-label': 'Calendario del mes' });
  const panelBody = el('div', { id: 'calendarSyncBody' }, el('p', { class: 'hint' }, 'Cargando…'));
  const panel = el('details', { class: 'card more-panel', id: 'calendarSync', open: true, 'data-feedback-id': 'booking.calendario.google', 'data-feedback-label': 'Google Calendar' },
    el('summary', null, 'Google Calendar'), panelBody);

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Calendario'), el('p', null, 'Ocupación por meses y estado de la sincronización con Google Calendar.'))),
    calendarHost, blocksCard, panel);

  const calendar = createCalendar({
    view: 'month',
    viewSwitch: false,
    events: async () => {
      const rows = (await client.list(RESERVATIONS)) as ReservationRow[];
      titles = new Map(rows.map((row) => [row.id, row.title]));
      const blocks = showBlocks ? ((await client.list(DATE_BLOCKS)) as Block[]).map(blockToCalendarEvent) : [];
      return [...rows.map(toCalendarEvent), ...blocks].filter((event): event is CalendarEvent => event !== null);
    },
    onSelectEvent: (event) => event.status === 'bloqueo' ? undefined : navigate(`#/reservas/${event.id}`),
  });
  calendarHost.append(calendar.element);

  async function removeBlock(row: Block): Promise<void> {
    const go = await confirmDialog({ title: 'Quitar bloqueo', text: `Se desbloquea ${dateRange(row)}. El organizador volverá a ver esos días como libres.`, confirmLabel: 'Quitar bloqueo', danger: true });
    if (!go) return;
    try {
      await client.commit([{ op: 'delete', table: DATE_BLOCKS, id: row.id, expectedRevision: row.revision }]);
      toast(navigator.onLine ? 'Bloqueo quitado.' : 'Bloqueo quitado. Se enviará al reconectar.');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function paintBlocks(): Promise<void> {
    if (!showBlocks) return;
    const rows = ((await client.list(DATE_BLOCKS)) as Block[]).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id));
    replace(blocksBody,
      el('p', { class: 'hint' }, 'Días en los que Ikisai no admite reservas. El organizador solo verá «ocupado».'),
      rows.length === 0 ? el('p', { class: 'hint', id: 'dateBlocksEmpty' }, 'No hay fechas bloqueadas.')
        : el('ul', { class: 'list', id: 'dateBlockList', 'data-feedback-id': 'booking.calendario.bloqueos.lista', 'data-feedback-label': 'Lista de bloqueos' }, rows.map((row) => el('li', { class: 'row', dataset: { pending: String(row._pending === true) }, 'data-feedback-id': 'booking.calendario.bloqueos.fila', 'data-feedback-label': 'Bloqueo' },
          el('div', { class: 'row-title' }, el('span', { class: 'name' }, dateRange(row)), row._pending ? el('span', { class: 'chip pending' }, 'Pendiente') : null),
          row.reason ? el('div', { class: 'row-meta', 'data-feedback-ignore': '' }, row.reason) : null,
          el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', 'aria-label': `Quitar el bloqueo ${dateRange(row)}`, 'data-feedback-id': 'booking.calendario.bloqueos.quitar', 'data-feedback-label': 'Quitar bloqueo', onclick: () => void removeBlock(row) }, 'Quitar'))))),
      el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'addDateBlock', 'data-feedback-id': 'booking.calendario.bloqueos.anadir', 'data-feedback-label': 'Bloquear fechas', onclick: () => openRowSheet({
        client, title: 'Bloquear fechas', table: DATE_BLOCKS, row: null, specs: BLOCK_SPECS, check: checkDateRange, savedMessage: 'Fechas bloqueadas.',
        feedbackId: 'booking.calendario.bloqueos.nuevo', feedbackLabel: 'Bloquear fechas' }) }, 'Bloquear fechas')));
  }

  async function retry(reservationId: string): Promise<void> {
    try {
      await client.api(`/calendar/${reservationId}/retry`, { method: 'POST', json: {} });
      toast('Reintento solicitado.');
      await loadStatus();
    } catch (error) {
      toast(describeError(error));
    }
  }

  function paintStatus(status: CalendarStatus, stale: boolean): void {
    const failing = status.items.filter((item) => item.pendingJob || item.syncStatus === 'error');
    const pending = status.items.filter((item) => item.pendingJob || item.syncStatus === 'pending').length;
    const errors = status.items.filter((item) => item.syncStatus === 'error').length;
    const linked = status.items.filter((item) => item.htmlLink);
    replace(panelBody,
      el('p', { id: 'calendarHealth', 'data-feedback-id': 'booking.calendario.google.estado', 'data-feedback-label': 'Estado de la sincronización', dataset: { health: status.health }, class: status.health === 'ok' ? 'banner ok' : 'banner warn' }, HEALTH_TEXT[status.health] ?? HEALTH_TEXT.not_configured),
      el('p', { id: 'calendarCounts', 'data-feedback-id': 'booking.calendario.google.recuento', 'data-feedback-label': 'Recuento' }, `${pending} ${pending === 1 ? 'pendiente' : 'pendientes'} · ${errors} con error`),
      stale ? el('p', { class: 'hint', id: 'calendarStale' }, 'Se actualizará al reconectar.') : null,
      failing.length === 0 ? null : el('ul', { class: 'list', id: 'calendarFailing', 'data-feedback-id': 'booking.calendario.google.fallos', 'data-feedback-label': 'Reservas con fallo' }, failing.map((item) => el('li', { class: 'row', dataset: { reservationId: item.reservationId }, 'data-feedback-id': 'booking.calendario.google.fallos.fila', 'data-feedback-label': 'Reserva con fallo' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, titles.get(item.reservationId) ?? 'Reserva'),
          el('span', { class: `chip${item.syncStatus === 'error' ? ' alert' : ''}` }, item.syncStatus === 'error' ? 'Con error' : 'Pendiente')),
        item.lastError ? el('div', { class: 'row-meta' }, item.lastError) : null,
        writable && !stale ? el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', 'data-feedback-id': 'booking.calendario.google.fallos.reintentar', 'data-feedback-label': 'Reintentar', onclick: () => void retry(item.reservationId),
          'aria-label': `Reintentar sincronizar ${titles.get(item.reservationId) ?? 'la reserva'}` }, 'Reintentar')) : null))),
      linked.length === 0 ? null : el('p', null, linked.map((item, index) => [index ? ' · ' : '',
        el('a', { href: item.htmlLink!, 'data-feedback-id': 'booking.calendario.google.abrir', 'data-feedback-label': 'Abrir en Google Calendar', target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Abrir en Google Calendar: ${titles.get(item.reservationId) ?? 'reserva'}` },
          linked.length > 1 ? `Abrir en Google Calendar (${titles.get(item.reservationId) ?? 'reserva'})` : 'Abrir en Google Calendar')])));
  }

  async function loadStatus(): Promise<void> {
    titles = new Map(((await client.list(RESERVATIONS)) as ReservationRow[]).map((row) => [row.id, row.title]));
    const fresh = await fetchCalendarStatus(client);
    if (fresh) return paintStatus(fresh, false);
    const cached = readCalendarCache();
    if (cached) paintStatus(cached, true);
    else replace(panelBody, el('p', { class: 'hint', id: 'calendarStale' }, 'El estado de Google Calendar se mostrará cuando haya conexión.'));
  }

  const onOnline = () => void loadStatus();
  window.addEventListener('online', onOnline);
  const off = client.onTable(RESERVATIONS, () => void calendar.refresh().then(loadStatus));
  const offBlocks = showBlocks ? client.onTable(DATE_BLOCKS, () => void calendar.refresh().then(paintBlocks)) : () => undefined;
  void paintBlocks();
  void loadStatus();
  return () => {
    off();
    offBlocks();
    window.removeEventListener('online', onOnline);
    calendar.destroy();
  };
};
