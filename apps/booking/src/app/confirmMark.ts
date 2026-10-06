/**
 * Marca de «confirmación pendiente de enviar» (API §10, «Confirmar sin red»).
 * `sync-client` no aplica nada en local para un `call`, así que la app anota en este dispositivo qué lote espera.
 */
const KEY = 'booking.confirmMarks';

export interface ConfirmMark {
  reservationId: string;
  requestId: string;
}

function readAll(): ConfirmMark[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as ConfirmMark[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(marks: ConfirmMark[]): void {
  try {
    if (marks.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(marks));
  } catch {
    /* sin almacenamiento: no hay marca, pero la cola sigue funcionando */
  }
}

export function getConfirmMark(reservationId: string): ConfirmMark | null {
  return readAll().find((mark) => mark.reservationId === reservationId) ?? null;
}

export function setConfirmMark(mark: ConfirmMark): void {
  writeAll([...readAll().filter((m) => m.reservationId !== mark.reservationId), mark]);
}

export function clearConfirmMark(reservationId: string): void {
  writeAll(readAll().filter((mark) => mark.reservationId !== reservationId));
}
