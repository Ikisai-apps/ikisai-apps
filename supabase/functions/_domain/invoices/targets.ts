/** Invoices · destinos de asignación (API.md §6.2): reglas puras compartidas por la Edge y el frontend. */

/**
 * ¿Sigue abierto el destino para una factura de esta fecha? (tanda 27, «Compras»: el toque solo asigna si sí; si no, abre la
 * hoja). No lo está si está archivado o si es un evento de Booking que ya había acabado en la fecha de la factura (`ends_on`,
 * su último día). Sin fecha de factura, se compara con hoy.
 */
export function targetOpenFor(target: { archived: boolean; ends_on?: string | null }, invoiceDate: string | null, today: string = new Date().toISOString().slice(0, 10)): boolean {
  if (target.archived) return false;
  return !target.ends_on || target.ends_on >= (invoiceDate ?? today);
}
