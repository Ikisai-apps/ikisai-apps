// «Cobros sin casar» (API.md §19.7): qué pasó con un aviso de la pasarela que no casó y qué hacer. Lógica pura.

export interface UnmatchedFacts {
  kind: string; outcome: string; invoice_status: string | null; payment_status: string | null; amount: number | null; invoice_total: number | null;
}

/** Qué pasó y qué hacer, en palabras de quien revisa. */
export function explainUnmatched(u: UnmatchedFacts): { title: string; todo: string } {
  if (u.kind === 'refunded') return { title: 'Devolución en la pasarela', todo: 'Haz la rectificativa de la factura por lo devuelto.' };
  if (u.outcome === 'unknown') return { title: 'Pago sin enlace conocido', todo: 'Búscalo en la pasarela: si no es de Finance, márcalo revisado; si lo es, cobra la factura a mano.' };
  if (u.invoice_status === 'anulada' || u.invoice_status === 'rectificada') return { title: 'Pagaron una factura anulada o rectificada', todo: 'Devuelve el pago en la pasarela o emite la factura que corresponda.' };
  if (u.payment_status === 'cobrada') return { title: 'Pagaron una factura ya cobrada', todo: 'Comprueba si se cobró dos veces y devuelve uno de los pagos.' };
  if (u.amount !== null && u.invoice_total !== null && Number(u.amount) !== Number(u.invoice_total)) return { title: 'El importe no coincide', todo: 'Revisa el pago y la factura; devuelve o ajusta la diferencia.' };
  return { title: 'Pago por revisar', todo: 'Revisa el pago en la pasarela y la factura.' };
}
