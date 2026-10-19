/**
 * Compras · «Por asignar» (tanda 27, MUELA-070): el destino que se propone para cada línea sin asignar, sacado de lo que
 * ya hay en el dispositivo (sin dato nuevo). Sin dependencias (se prueba con node).
 * - Primero, el destino de la misma línea (mismo nombre) en la factura más reciente del mismo proveedor.
 * - Si no, el último destino usado con ese proveedor.
 * - Si no, sin propuesta: el toque abre la hoja de asignar.
 * El toque solo asigna si el destino sigue abierto (lo decide la vista con `targetOpenFor`); si no, abre la hoja.
 */
export interface ProposalTarget { app: string; kind: string; id: string | null; code: string | null; label: string; revision: number | null }

export interface PastAllocation {
  supplierId: string;
  lineKey: string;
  date: string;
  target: ProposalTarget;
}

export const lineKeyOf = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
export const targetKeyOf = (t: Pick<ProposalTarget, 'app' | 'kind' | 'id'>) => `${t.app}:${t.kind}:${t.id ?? ''}`;

/** La propuesta para una línea (`null` si no hay nada con ese proveedor). */
export function proposeTarget(supplierId: string, lineName: string, past: readonly PastAllocation[]): ProposalTarget | null {
  const key = lineKeyOf(lineName);
  const mine = past.filter((p) => p.supplierId === supplierId).sort((a, b) => b.date.localeCompare(a.date));
  return (mine.find((p) => p.lineKey === key) ?? mine[0])?.target ?? null;
}

/** «Asignar los 2 a Cocina · 115,80 €». */
export function batchLabel(count: number, target: ProposalTarget, total: string): string {
  return `Asignar ${count === 1 ? '' : `los ${count} `}a ${target.label} · ${total}`;
}
