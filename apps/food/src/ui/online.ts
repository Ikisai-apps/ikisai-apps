/**
 * Botones que necesitan red (MUELA-086, tanda 30): `bindOnline` del kit los deja desactivados con el motivo escrito y
 * los vuelve a activar al volver la conexión. Lo que funciona con la cola de sincronización no se ata nunca.
 * Cada vista suelta sus botones al repintar o al salir (`release`), para no dejar escuchas colgadas.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { bindOnline } from '@ikisai/ui-kit';

export interface OnlineBinder {
  bind<T extends HTMLElement>(button: T, reason: string): T;
  release(): void;
}

export function onlineBinder(client: SyncClient): OnlineBinder {
  let releases: Array<() => void> = [];
  return {
    bind(button, reason) {
      releases.push(bindOnline(button, { client, reason, retry: () => void client.sync().catch(() => undefined) }));
      return button;
    },
    release() {
      for (const off of releases) off();
      releases = [];
    },
  };
}
