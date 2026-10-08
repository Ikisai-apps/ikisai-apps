import type { SyncClient } from '@ikisai/sync-client';

/** Estado compartido para decidir si es seguro actualizar el shell (contrato §6.4 e initAppUpdates del kit). */
export const guard = {
  /** Hay un formulario abierto con cambios sin guardar. */
  dirtyEditor: false,
};

export function safeToUpdate(client: SyncClient): boolean {
  const status = client.status();
  return !guard.dirtyEditor && status.pendingCommands === 0 && status.pendingBlobs === 0 && status.conflicts === 0 && status.network !== 'syncing';
}
