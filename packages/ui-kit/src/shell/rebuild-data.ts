/**
 * «Rehacer datos de este dispositivo» (K-06; decisión de VG del 05-11, K-08 b). Sin cerrar sesión:
 * 1. intenta enviar lo pendiente (`sync()`);
 * 2. si aún queda algo (pendientes, adjuntos, conflictos o rechazados), lo enseña y pide confirmación antes de borrar;
 * 3. borra el espejo local y vuelve a descargar (`resetMirror`, sync-client).
 * La pone sola la cáscara en el menú común cuando el cliente de `status` tiene `resetMirror`.
 */
import type { SyncStatus } from '@ikisai/sync-client';
import { el } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { confirmDialog } from '../overlay/dialog.ts';
import { toast } from '../toast.ts';

export interface RebuildClient {
  status(): SyncStatus;
  sync(): Promise<void>;
  resetMirror(options?: { discardPending?: boolean }): Promise<void>;
}

/** El cliente sabe rehacer su espejo (sync-client con K-06). */
export const canRebuild = (client: unknown): client is RebuildClient =>
  !!client && typeof (client as RebuildClient).resetMirror === 'function' && typeof (client as RebuildClient).sync === 'function' && typeof (client as RebuildClient).status === 'function';

/** Devuelve `true` si se rehízo; `false` si la persona lo dejó o falló (con su aviso). */
export async function rebuildDeviceData(client: RebuildClient): Promise<boolean> {
  const go = await confirmDialog({
    title: kt('¿Rehacer los datos de este dispositivo?'),
    text: kt('Se envía lo pendiente, se borra lo guardado en este dispositivo y se vuelve a descargar. No cierra la sesión.'),
    confirmLabel: kt('Rehacer'),
  });
  if (!go) return false;
  try { await client.sync(); } catch { /* sin red o con error: lo que quede se enseña abajo */ }
  const s = client.status();
  const left = [
    s.pendingCommands ? (s.pendingCommands === 1 ? kt('1 cambio sin enviar') : kt('{n} cambios sin enviar', { n: String(s.pendingCommands) })) : null,
    s.pendingBlobs ? (s.pendingBlobs === 1 ? kt('1 archivo sin subir') : kt('{n} archivos sin subir', { n: String(s.pendingBlobs) })) : null,
    s.conflicts ? (s.conflicts === 1 ? kt('1 conflicto sin resolver') : kt('{n} conflictos sin resolver', { n: String(s.conflicts) })) : null,
    s.rejected ? (s.rejected === 1 ? kt('1 cambio rechazado') : kt('{n} cambios rechazados', { n: String(s.rejected) })) : null,
  ].filter((x): x is string => !!x);
  if (left.length) {
    const sure = await confirmDialog({
      title: kt('Quedan cosas sin enviar'),
      text: kt('No se han podido enviar. Si rehaces los datos ahora, se pierden:'),
      body: el('ul', { class: 'rebuild-left' }, ...left.map((t) => el('li', null, t))),
      focusBody: false,
      confirmLabel: kt('Borrar y rehacer'),
      danger: true,
    });
    if (!sure) return false;
  }
  toast(kt('Rehaciendo los datos de este dispositivo…'));
  try {
    await client.resetMirror({ discardPending: left.length > 0 });
    toast(kt('Datos rehechos: ya tienes lo último del servidor.'));
    return true;
  } catch {
    toast(kt('No se han podido rehacer los datos. Prueba otra vez con conexión.'));
    return false;
  }
}
