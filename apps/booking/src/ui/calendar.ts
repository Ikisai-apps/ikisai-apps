/** Calendario (API §9.3): ocupación mensual de días completos y estado de la sincronización con Google Calendar. */
import { createCalendar, el, replace, toast, type CalendarEvent } from '@ikisai/ui-kit';
import { RESERVATIONS, canWrite, describeError, type ReservationRow } from '../app/client.ts';
import { fetchCalendarStatus, readCalendarCache, type CalendarHealth as Health, type CalendarStatus } from '../app/calendarStatus.ts';
import type { ViewMount } from './shell.ts';

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

export const mountCalendar: ViewMount = ({ main, client, navigate }) => {
  const writable = canWrite(client);
  let titles = new Map<string, string>();
  const calendarHost = el('div', { id: 'calendarHost' });
  const panelBody = el('div', { id: 'calendarSyncBody' }, el('p', { class: 'hint' }, 'Cargando…'));
  const panel = el('details', { class: 'card more-panel', id: 'calendarSync', open: true },
    el('summary', null, 'Google Calendar'), panelBody);

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Calendario'), el('p', null, 'Ocupación por meses y estado de la sincronización con Google Calendar.'))),
    calendarHost, panel);

  const calendar = createCalendar({
    view: 'month',
    viewSwitch: false,
    events: async () => {
      const rows = (await client.list(RESERVATIONS)) as ReservationRow[];
      titles = new Map(rows.map((row) => [row.id, row.title]));
      return rows.map(toCalendarEvent).filter((event): event is CalendarEvent => event !== null);
    },
    onSelectEvent: (event) => navigate(`#/reservas/${event.id}`),
  });
  calendarHost.append(calendar.element);

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
      el('p', { id: 'calendarHealth', dataset: { health: status.health }, class: status.health === 'ok' ? 'banner ok' : 'banner warn' }, HEALTH_TEXT[status.health] ?? HEALTH_TEXT.not_configured),
      el('p', { id: 'calendarCounts' }, `${pending} ${pending === 1 ? 'pendiente' : 'pendientes'} · ${errors} con error`),
      stale ? el('p', { class: 'hint', id: 'calendarStale' }, 'Se actualizará al reconectar.') : null,
      failing.length === 0 ? null : el('ul', { class: 'list', id: 'calendarFailing' }, failing.map((item) => el('li', { class: 'row', dataset: { reservationId: item.reservationId } },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, titles.get(item.reservationId) ?? 'Reserva'),
          el('span', { class: `chip${item.syncStatus === 'error' ? ' alert' : ''}` }, item.syncStatus === 'error' ? 'Con error' : 'Pendiente')),
        item.lastError ? el('div', { class: 'row-meta' }, item.lastError) : null,
        writable && !stale ? el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', onclick: () => void retry(item.reservationId),
          'aria-label': `Reintentar sincronizar ${titles.get(item.reservationId) ?? 'la reserva'}` }, 'Reintentar')) : null))),
      linked.length === 0 ? null : el('p', null, linked.map((item, index) => [index ? ' · ' : '',
        el('a', { href: item.htmlLink!, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Abrir en Google Calendar: ${titles.get(item.reservationId) ?? 'reserva'}` },
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
  void loadStatus();
  return () => {
    off();
    window.removeEventListener('online', onOnline);
    calendar.destroy();
  };
};
