/**
 * Ikisai Central · registro de decisiones (C01 «decision_clave»; docs/central/API.md §2.10).
 * Tres niveles: nombre llano (lista), descripción llana (al desplegar) y explicación técnica (plegada dentro).
 */

export const DECISIONS_TABLE = 'central.decisions';
export const DECISION_STATUSES = ['vigente', 'sustituida', 'revocada'] as const;
export type DecisionStatus = typeof DECISION_STATUSES[number];
export const DECISION_STATUS_LABELS: Record<DecisionStatus, string> = { vigente: 'Vigente', sustituida: 'Sustituida', revocada: 'Revocada' };

/** Apps o áreas a las que puede afectar una decisión (filtro de la lista). `ecosistema`: todas o el núcleo común. */
export const DECISION_SCOPES = ['ecosistema', 'central', 'tasks', 'invoices', 'booking', 'food', 'guests', 'organizers'] as const;
export const DECISION_SCOPE_LABELS: Record<string, string> = {
  ecosistema: 'Todo el ecosistema', central: 'Central', tasks: 'Tasks', invoices: 'Finance', booking: 'Booking', food: 'Food',
  guests: 'Guests', organizers: 'Organizers',
};

export interface DecisionLike {
  code?: string | null; name: string; summary: string; technical?: string | null; status: string; scopes?: string[] | null;
  decided_on: string; deleted_at?: string | null;
}

/** Texto sin acentos ni mayúsculas, para buscar «facturacion» y encontrar «Facturación». */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Búsqueda por texto (código, nombre, descripción y explicación técnica) y filtros por app y estado; más recientes primero. */
export function filterDecisions<T extends DecisionLike>(rows: readonly T[], query: string, scope: string, status: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return rows
    .filter((d) => !d.deleted_at)
    .filter((d) => !scope || (d.scopes ?? []).includes(scope))
    .filter((d) => !status || d.status === status)
    .filter((d) => {
      if (!words.length) return true;
      const haystack = fold([d.code ?? '', d.name, d.summary, d.technical ?? ''].join(' '));
      return words.every((w) => haystack.includes(w));
    })
    .sort((a, b) => b.decided_on.localeCompare(a.decided_on) || String(b.code ?? '').localeCompare(String(a.code ?? '')));
}
