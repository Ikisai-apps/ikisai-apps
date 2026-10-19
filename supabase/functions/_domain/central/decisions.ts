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

// ---------------------------------------------------------------------------
// Votos y decisión final (tanda 27, MUELA-014 r2; migración `1512`). Todo el equipo vota, también quien solo lee; los votos
// orientan y quien administra decide en la ficha («Mantener» o «Retirar»), aunque los votos digan otra cosa.
// ---------------------------------------------------------------------------
export const DECISION_VOTES_TABLE = 'central.decision_votes';
export const DECISION_VOTES = ['mantener', 'retirar'] as const;
export type DecisionVote = typeof DECISION_VOTES[number];
export const DECISION_VOTE_LABELS: Record<DecisionVote, string> = { mantener: 'Se mantiene', retirar: 'Retirar' };
export const DECISION_REVIEW_LABELS: Record<DecisionVote, string> = { mantener: 'Mantener', retirar: 'Retirar' };

export interface VoteLike { decision_id: string; voter_id: string; vote: string; updated_at: string; deleted_at?: string | null }
export interface ReviewedDecision extends DecisionLike {
  id: string; superseded_by?: string | null; review_outcome?: string | null; reviewed_at?: string | null;
}
export interface Tally { mantener: number; retirar: number }

const liveVotes = <V extends VoteLike>(votes: readonly V[], decisionId: string, since?: string | null) =>
  votes.filter((v) => !v.deleted_at && v.decision_id === decisionId && (!since || Date.parse(v.updated_at) > Date.parse(since)));

/** Recuento de los votos vivos de una decisión. Con `since`, solo los puestos o cambiados después (tras la última decisión final). */
export function voteTally(votes: readonly VoteLike[], decisionId: string, since?: string | null): Tally {
  const tally: Tally = { mantener: 0, retirar: 0 };
  for (const v of liveVotes(votes, decisionId, since)) if (v.vote === 'mantener' || v.vote === 'retirar') tally[v.vote]++;
  return tally;
}

/** El voto vivo de una persona en una decisión, o null. */
export function myVote(votes: readonly VoteLike[], decisionId: string, userId: string): DecisionVote | null {
  const v = liveVotes(votes, decisionId).find((x) => x.voter_id === userId);
  return v && (v.vote === 'mantener' || v.vote === 'retirar') ? v.vote : null;
}

const alive = <T extends DecisionLike>(rows: readonly T[]) => rows.filter((d) => !d.deleted_at);
const newestFirst = <T extends DecisionLike>(a: T, b: T) => b.decided_on.localeCompare(a.decided_on) || String(b.code ?? '').localeCompare(String(a.code ?? ''));

/**
 * Lo que te toca decidir (foco de la portada): las vigentes con más votos para retirarlas que para mantenerlas. Después de
 * una decisión final solo cuentan los votos puestos o cambiados más tarde, para que «Mantener» la saque del foco hasta que
 * el equipo vuelva a pedirlo. Primero, la de más diferencia; después, la más reciente.
 */
export function decisionsToDecide<T extends ReviewedDecision>(rows: readonly T[], votes: readonly VoteLike[]): T[] {
  const margin = (d: T) => { const t = voteTally(votes, d.id, d.reviewed_at); return t.retirar - t.mantener; };
  return alive(rows).filter((d) => d.status === 'vigente' && margin(d) > 0).sort((a, b) => margin(b) - margin(a) || newestFirst(a, b));
}

/** Por votar: las vigentes en las que esta persona aún no ha votado, de la más reciente a la más antigua. */
export function decisionsToVote<T extends ReviewedDecision>(rows: readonly T[], votes: readonly VoteLike[], userId: string): T[] {
  return alive(rows).filter((d) => d.status === 'vigente' && !myVote(votes, d.id, userId)).sort(newestFirst);
}

/** Las tres últimas vigentes (las «Reciente» de la lista y las que enseña Inicio). */
export function recentDecisions<T extends DecisionLike>(rows: readonly T[], count = 3): T[] {
  return alive(rows).filter((d) => d.status === 'vigente').sort(newestFirst).slice(0, count);
}

/**
 * Cadena de sustituciones de una decisión, de la más antigua a la más nueva y con ella dentro: hacia atrás por quien la
 * tenía en `superseded_by` y hacia delante por su `superseded_by`. Sin filas en la papelera y a prueba de ciclos.
 */
export function decisionTrail<T extends ReviewedDecision>(rows: readonly T[], id: string): T[] {
  const live = alive(rows);
  const byId = new Map(live.map((d) => [d.id, d]));
  const start = byId.get(id);
  if (!start) return [];
  const seen = new Set([start.id]);
  const back: T[] = [];
  for (let cur = start; ;) {
    const prev = live.find((d) => d.superseded_by === cur.id && !seen.has(d.id));
    if (!prev) break;
    seen.add(prev.id); back.unshift(prev); cur = prev;
  }
  const forward: T[] = [];
  for (let cur = start; cur.superseded_by;) {
    const next = byId.get(cur.superseded_by);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id); forward.push(next); cur = next;
  }
  return [...back, start, ...forward];
}
