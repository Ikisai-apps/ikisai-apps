/**
 * Acciones de servidor (`call`): validar, cambiar de estado, dar por revisado un cambio del evento, regenerar.
 * Dependen de la verdad del servidor y sync-client no puede anticipar su efecto en el espejo, así que solo se hacen con
 * red (docs/food/API.md §10.3): primero se vacía la cola, después se envía el `call` para tener el resultado o el error
 * en el momento, y por último se sincroniza para traer las filas que cambió.
 */
import type { SyncClient } from '@ikisai/sync-client';

export class CallError extends Error {
  constructor(readonly code: string, message: string, readonly details: unknown = null) {
    super(message);
  }
}

interface CommandResponse {
  results: Array<{ op: string; procedure?: string; result?: unknown }>;
}

export async function runCall<T = unknown>(client: SyncClient, procedure: string, args: Record<string, unknown>): Promise<T> {
  if (!navigator.onLine) throw new CallError('OFFLINE', 'Esta acción necesita conexión.');
  await client.sync();
  const status = client.status();
  if (status.network === 'offline') throw new CallError('OFFLINE', 'Esta acción necesita conexión.');
  if (status.pendingCommands > 0 || status.conflicts > 0) throw new CallError('PENDING_CHANGES', 'Hay cambios sin sincronizar o conflictos por resolver.');
  const response = await client.api<CommandResponse>('/commands', {
    method: 'POST',
    json: { requestId: crypto.randomUUID(), operations: [{ op: 'call', procedure, args }] },
  });
  await client.sync();
  return response.results[0]?.result as T;
}
