/**
 * Ikisai Booking · riesgo de los lotes de agentes de IA (contrato §3.1). El núcleo ya exige aprobación para borrados,
 * procedimientos no marcados seguros (confirmar una reserva) y lotes de 10 o más filas; aquí se añade lo que en Booking
 * tiene consecuencias fuera de la app o toca datos personales.
 */
import { TABLES } from './catalog.ts';
import type { OperationLike } from './validate.ts';

export interface AgentRisk {
  required: boolean;
  reasons: string[];
}

/** Estados que retiran la reserva de Google Calendar o la sacan del circuito comercial. */
const EXIT_STATUSES = ['cancelada', 'perdida'];

export function bookingAgentRisk(operations: readonly OperationLike[]): AgentRisk {
  const reasons: string[] = [];
  for (const op of operations) {
    const fields = op.fields ?? {};
    if (op.table === TABLES.reservations && op.op === 'update') {
      if (typeof fields.status === 'string' && EXIT_STATUSES.includes(fields.status)) reasons.push(`booking:status:${fields.status}`);
      if (fields.archived_at !== undefined && fields.archived_at !== null) reasons.push('booking:archive');
    }
    // Datos personales del registro de viajeros: siempre con una persona delante.
    if (op.table === TABLES.guests) reasons.push(`booking:guests:${op.op}`);
    // Propuestas al organizador: cualquier escritura la revisa una persona (API.md §15.2).
    if (op.table === TABLES.proposals || op.table === TABLES.proposalLines) reasons.push('booking:proposal');
    if (op.op === 'call' && typeof op.procedure === 'string' && op.procedure.startsWith('booking.') && op.procedure.includes('proposal')) reasons.push('booking:proposal');
    // Importes y datos de pago.
    if (op.table === TABLES.finance && op.op !== 'insert') reasons.push('booking:finance');
  }
  const unique = [...new Set(reasons)];
  return { required: unique.length > 0, reasons: unique };
}
