/** Estado de la sincronización con Google Calendar (`GET /calendar/status`) y su caché local, compartidos por Calendario y la ficha. */
import type { SyncClient } from '@ikisai/sync-client';

export type CalendarHealth = 'ok' | 'not_configured' | 'auth_error' | 'calendar_not_found' | 'calendar_not_shared';
export type CalendarSyncStatus = 'pending' | 'synced' | 'error' | 'deleted';

export interface CalendarItem {
  reservationId: string;
  syncStatus: CalendarSyncStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  htmlLink: string | null;
  pendingJob: boolean;
  attempts: number;
  nextAttemptAt: string | null;
}

export interface CalendarStatus {
  configured: boolean;
  calendarId: string | null;
  health: CalendarHealth;
  items: CalendarItem[];
}

const CACHE_KEY = 'booking.calendarStatus';

export function readCalendarCache(): CalendarStatus | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CalendarStatus) : null;
  } catch {
    return null;
  }
}

export function writeCalendarCache(status: CalendarStatus): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(status));
  } catch {
    /* sin almacenamiento: la app funciona igual */
  }
}

/**
 * Pide el estado a la API y lo guarda en la caché. Con `reservationId` solo pide esa reserva y la fusiona con lo que ya había.
 * Devuelve `null` si no hay red o la API no responde.
 */
export async function fetchCalendarStatus(client: SyncClient, reservationId?: string): Promise<CalendarStatus | null> {
  if (!navigator.onLine) return null;
  try {
    const query = reservationId ? `?reservationIds=${encodeURIComponent(reservationId)}` : '';
    const status = await client.api<CalendarStatus>(`/calendar/status${query}`);
    if (!reservationId) {
      writeCalendarCache(status);
      return status;
    }
    const cached = readCalendarCache();
    const others = (cached?.items ?? []).filter((item) => item.reservationId !== reservationId);
    const merged: CalendarStatus = { ...status, items: [...others, ...status.items.filter((item) => item.reservationId === reservationId)] };
    writeCalendarCache(merged);
    return merged;
  } catch {
    return null;
  }
}
