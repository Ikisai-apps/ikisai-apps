/**
 * Guiado: avisar del guardado de verdad (`announceSaved`, nunca con valores). Sin red, se avisa como pendiente y se vuelve
 * a avisar sin pendiente cuando la cola sube ese lote y la base lo acepta; Flow solo da por hecho un paso sin pendiente, y
 * la guía del kit reconfirma con el segundo aviso (revisión de UI-kit sobre la #1130). Si la base lo rechaza, no se avisa.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { announceSaved } from '@ikisai/ui-kit';

export function announceWhenAccepted(client: SyncClient, requestId: string, ids: readonly string[]): void {
  const fire = (pending: boolean) => { for (const id of ids) announceSaved(id, { pending }); };
  let done = false;
  let off: (() => void) | null = null;
  const finish = () => { done = true; off?.(); off = null; };
  // la cola vacía y el lote sin rechazar: aceptado
  const check = async (): Promise<boolean> => {
    if (done || !navigator.onLine) return false;
    if ((await client.rejected()).some((b) => b.requestId === requestId)) { finish(); return true; }
    if (client.status().pendingCommands > 0) return false;
    finish();
    fire(false);
    return true;
  };
  void check().then((settled) => {
    if (settled || done) return;
    fire(true);
    off = client.onStatus(() => { void check(); });
  });
}
