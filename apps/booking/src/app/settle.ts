import type { RejectedBatch, SyncClient } from '@ikisai/sync-client';

/**
 * Espera a que el lote recién encolado se resuelva con el servidor (solo con red) para poder avisar en la propia hoja
 * si lo rechazó (por ejemplo `BED_OVERBOOKED`). Si no termina a tiempo o no hay red, devuelve `null`: el lote sigue en cola.
 * Un lote rechazado se retira de la lista de rechazados para que no quede además como aviso general.
 */
export async function settleBatch(client: SyncClient, requestId: string, timeoutMs = 8000): Promise<RejectedBatch | null> {
  const deadline = Date.now() + timeoutMs;
  while (navigator.onLine && Date.now() < deadline) {
    const rejected = (await client.rejected()).find((batch) => batch.requestId === requestId);
    if (rejected) {
      await client.discardRejected(requestId);
      return rejected;
    }
    if (client.status().pendingCommands === 0) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}
