import type { ApiError, SyncClient } from '@ikisai/sync-client';
import { PROCEDURES } from '@ikisai/domain-flow';

/**
 * Procedimientos de Flow (API.md §3) contra el servidor, sin pasar por la cola offline: cobrar, corregir, entregar y tocar
 * una unidad necesitan la respuesta del servidor (§10.3: nada se da por confirmado sin él). Tras cada uno, un pull
 * inmediato para que el espejo y las demás pantallas lo vean ya (P-3).
 */

export class OfflineError extends Error {
  code = 'OFFLINE';
  constructor() { super('Esta acción necesita conexión.'); }
}

export function isOnline(client: SyncClient): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine && client.status().network !== 'offline';
}

export async function callProcedure<T = Record<string, unknown>>(client: SyncClient, procedure: string, args: Record<string, unknown>): Promise<T> {
  if (!isOnline(client)) throw new OfflineError();
  const out = await client.api<{ results: Array<{ result: T }> }>('/commands', {
    method: 'POST',
    json: { requestId: crypto.randomUUID(), operations: [{ op: 'call', procedure, args }] },
  });
  void client.sync().catch(() => undefined);
  return out.results[0]!.result;
}

export const errorCode = (error: unknown): string => (error as Partial<ApiError>)?.code ?? '';
export const errorDetails = (error: unknown): Record<string, any> => ((error as { details?: Record<string, any> })?.details ?? {}) as Record<string, any>;

export const flowActions = (client: SyncClient) => ({
  confirmPayment: (orderId: string, method: 'cash' | 'bizum', revision: number) =>
    callProcedure<{ pay_seq: number; total_cents: number; units: number }>(client, PROCEDURES.confirmPayment, { order_id: orderId, method, expected_revision: revision }),
  unitStep: (unitId: string, from: string) => callProcedure<{ status: string }>(client, PROCEDURES.unitStep, { unit_id: unitId, from }),
  deliverOrder: (orderId: string, ident: string, confirmException: boolean, revision: number) =>
    callProcedure(client, PROCEDURES.deliverOrder, { order_id: orderId, ident, confirm_exception: confirmException, expected_revision: revision }),
  reopenOrder: (orderId: string, reason: string, revision: number) => callProcedure(client, PROCEDURES.reopenOrder, { order_id: orderId, reason, expected_revision: revision }),
  reversePayment: (orderId: string, reason: string, revision: number) => callProcedure(client, PROCEDURES.reversePayment, { order_id: orderId, reason, expected_revision: revision }),
  adjustPaidOrder: (orderId: string, lines: Array<{ line_id: string; quantity: number }>, method: 'cash' | 'bizum', confirmStarted: boolean, revision: number) =>
    callProcedure<{ diff_cents: number; refund_id: string | null }>(client, PROCEDURES.adjustPaidOrder, { order_id: orderId, lines, method, confirm_started: confirmStarted, expected_revision: revision }),
  createExtension: (parentOrderId: string, lines: Array<{ product_id: string; quantity: number }>) =>
    callProcedure<{ order_id: string }>(client, PROCEDURES.createExtension, { parent_order_id: parentOrderId, order_id: crypto.randomUUID(), lines }),
  confirmRefund: (paymentId: string) => callProcedure(client, PROCEDURES.confirmRefund, { payment_id: paymentId }),
});

export type FlowActions = ReturnType<typeof flowActions>;
