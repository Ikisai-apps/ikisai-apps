/**
 * Rechazos de «Validar» (incidencia del usuario, 9-10-2026). Si el servidor rechaza una validación (falta la categoría,
 * no cuadran los importes…), se dice el motivo en español y el lote se descarta solo: un intento de validar fallido no
 * pierde nada (la factura sigue como estaba) y no debe quedarse como «1 rechazado». Al arrancar, limpia los que hubiera.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { toast } from '@ikisai/ui-kit';
import { validationRejectionText } from '@ikisai/domain-invoices';
import { loadMirror } from './data.ts';

type Op = { op: string; procedure?: string; table?: string; args?: Record<string, unknown> };

/** Un lote que solo intentaba validar (más, como mucho, el aprendizaje de la plantilla que va con él). */
function validateOnly(operations: Op[]): string | null {
  const call = operations.find((o) => o.op === 'call' && o.procedure === 'invoices.validate');
  if (!call) return null;
  const rest = operations.filter((o) => o !== call);
  if (rest.some((o) => !(o.table === 'invoices.supplier_templates' || o.table === 'invoices.suppliers'))) return null;
  return typeof call.args?.invoice_id === 'string' ? call.args.invoice_id : null;
}

let running = false;

export async function handleValidationRejections(client: SyncClient): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const rejected = await client.rejected();
    let handled = 0;
    let mirror: Awaited<ReturnType<typeof loadMirror>> | null = null;
    for (const batch of rejected) {
      const invoiceId = validateOnly(batch.operations as unknown as Op[]);
      if (!invoiceId) continue;
      mirror ??= await loadMirror(client);
      const code = mirror.invoices.find((i) => i.id === invoiceId)?.code ?? 'la factura';
      const reason = validationRejectionText(batch.error) ?? batch.error.message ?? 'el servidor la rechazó';
      await client.discardRejected(batch.requestId);
      toast(`No se pudo validar ${code}: ${reason}. Corrígelo en la ficha y vuelve a pulsar «Validar».`);
      handled += 1;
    }
    return handled;
  } catch {
    return 0;
  } finally {
    running = false;
  }
}

/** Engancha el vigilante: al arrancar y cada vez que aumentan los rechazados. */
export function startRejectionWatcher(client: SyncClient): () => void {
  let last = client.status().rejected;
  const off = client.onStatus((status) => {
    if (status.rejected > last || (status.rejected && status.rejected !== last)) void handleValidationRejections(client);
    last = status.rejected;
  });
  void handleValidationRejections(client);
  return off;
}
