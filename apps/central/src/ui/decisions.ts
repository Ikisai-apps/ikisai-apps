import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  confirmDialog, createFocus, createVoteDeck, el, icon, listRow, openSheet, renderCover, replace, toast, type Sheet,
} from '@ikisai/ui-kit';
import {
  DECISION_REVIEW_LABELS, DECISION_SCOPES, DECISION_SCOPE_LABELS, DECISION_STATUSES, DECISION_STATUS_LABELS, DECISION_VOTE_LABELS, decisionTrail,
  decisionsToDecide, decisionsToVote, filterDecisions, myVote as myVoteOf, recentDecisions, todayInMadrid, validateOperations, voteTally,
  type VoteLike,
} from '@ikisai/domain-central';
import { guard } from '../app/guard.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import type { ViewContext, ViewMount } from './shell.ts';
import { fbIgnoreWithin } from './feedback.ts';

type Decision = Mirror<{
  id: string; revision: number; deleted_at: string | null; code: string | null; decided_on: string; name: string; summary: string;
  technical: string | null; responsible_person_id: string | null; status: string; superseded_by: string | null; scopes: string[];
  link_url: string | null; link_label: string | null; review_outcome: string | null; reviewed_by: string | null; reviewed_at: string | null;
  review_tally: { mantener?: number; retirar?: number } | null;
}>;
type VoteRow = Mirror<VoteLike & { id: string; revision: number }>;
interface Person { id: string; display_name: string; user_id: string | null }

const text = (v: string) => v.trim() || null;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fmtDay = (d: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', ...(d.slice(0, 4) !== todayInMadrid().slice(0, 4) ? { year: 'numeric' } : {}) }).format(new Date(`${d.slice(0, 10)}T12:00:00Z`)).replace(/\./g, '');
const statusLabel = (s: string) => DECISION_STATUS_LABELS[s as keyof typeof DECISION_STATUS_LABELS] ?? s;
const statusChip = (s: string) => el('span', { class: s === 'vigente' ? 'chip ok' : s === 'revocada' ? 'chip alert' : 'chip' }, statusLabel(s));

/**
 * Registro de decisiones (C01; API.md §2.10; MUELA-014 r2 y 069). Tres niveles: nombre llano, qué se decidió y por qué, y
 * la explicación técnica plegada. Todo el equipo vota si cada decisión vigente se mantiene, también quien solo lee; quien
 * administra decide en la ficha («Mantener» o «Retirar»), aunque los votos digan otra cosa. Owner y editor escriben
 * decisiones; todos leen.
 */
async function loadAll(client: SyncClient) {
  const [rows, votes, people] = await Promise.all([client.list(T.decisions, { includeDeleted: true }), client.list(T.decisionVotes), client.list(T.people)]);
  return { rows: rows as unknown as Decision[], votes: votes as unknown as VoteRow[], people: people as unknown as Person[] };
}
type Data = Awaited<ReturnType<typeof loadAll>>;

/** El voto de esta cuenta. Uno recién puesto sin red aún no trae `voter_id` (lo pone el servidor): en este dispositivo es suyo. */
function mineOf(votes: VoteRow[], userId: string | null): VoteRow[] {
  return votes.map((v) => (!v.voter_id && v._pending ? { ...v, voter_id: userId ?? '' } : v));
}
function voteRowOf(votes: VoteRow[], decisionId: string, userId: string | null): VoteRow | undefined {
  return mineOf(votes, userId).find((v) => !v.deleted_at && v.decision_id === decisionId && v.voter_id === userId);
}

/** Pone, cambia o quita (`null`) el voto propio. Funciona sin red: va a la cola. */
async function castVote(ctx: ViewContext, data: Data, d: Decision, vote: 'mantener' | 'retirar' | null): Promise<void> {
  const userId = ctx.client.bootstrap()?.profile.userId ?? null;
  const current = voteRowOf(data.votes, d.id, userId);
  const ops: RowOperation[] = vote === null
    ? current ? [{ op: 'delete', table: T.decisionVotes, id: current.id, expectedRevision: current.revision }] : []
    : current ? (current.vote === vote ? [] : [{ op: 'update', table: T.decisionVotes, id: current.id, expectedRevision: current.revision, fields: { vote } }])
      : [{ op: 'insert', table: T.decisionVotes, id: crypto.randomUUID(), fields: { decision_id: d.id, vote } }];
  if (!ops.length) return;
  const issue = validateOperations(ops, ctx.client.bootstrap()?.membership ?? { role: 'reader' }, (t, id) => (t === T.decisions ? data.rows.find((r) => r.id === id) : undefined));
  if (issue) { toast(issue.message); return; }
  try {
    await ctx.usage.run('central.decisiones.votar', () => ctx.client.commit(ops));
    toast(vote === null ? 'Voto quitado.' : `Votado: ${DECISION_VOTE_LABELS[vote]}.${!navigator.onLine ? ' Se enviará cuando haya red.' : ''}`);
  } catch (e) { toast(describeError(e)); }
}

const tallyText = (t: { mantener: number; retirar: number }) => (t.mantener || t.retirar ? `${t.mantener} se mantiene · ${t.retirar} retirar` : 'Sin votos todavía');

// ---------------------------------------------------------------------------
// Lista: portada, foco, votar y la lista
// ---------------------------------------------------------------------------
export const mountDecisions: ViewMount = (ctx) => {
  const { main, client, navigate, isAdmin } = ctx;
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  const userId = client.bootstrap()?.profile.userId ?? null;
  let data: Data = { rows: [], votes: [], people: [] };
  let query = '';
  let scope = '';
  let status = '';
  const coverHost = el('div', { 'data-feedback-id': 'central.decisiones.portada', 'data-feedback-label': 'Portada de Decisiones' });
  const focusHost = el('section', { class: 'ctl-block', 'data-feedback-id': 'central.decisiones.foco', 'data-feedback-label': 'Lo que te toca decidir' });
  const deckHost = el('section', { class: 'ctl-block', id: 'decisionVote', 'data-feedback-id': 'central.decisiones.votar', 'data-feedback-label': '¿Se mantienen?' });
  const chipsHost = el('div', { class: 'ctl-chiprows', 'data-feedback-id': 'central.decisiones.filtros', 'data-feedback-label': 'Filtros' });
  const host = el('div', { id: 'decisionList', 'data-feedback-id': 'central.decisiones.lista', 'data-feedback-label': 'Lista de decisiones' });
  const search = el('input', { type: 'search', id: 'decisionSearch', 'data-field-id': 'central.decisiones.decision_search', 'data-feedback-id': 'central.decisiones.buscar', 'data-feedback-label': 'Buscar decisión', placeholder: 'Buscar en las decisiones', 'aria-label': 'Buscar decisión',
    oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; paintList(); } }) as HTMLInputElement;
  replace(main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.decisiones.cabecera', 'data-feedback-label': 'Cabecera de Decisiones' },
      el('div', null, el('h2', null, 'Decisiones'), el('p', null, 'Lo que se ha decidido, por qué y cómo se aplica.')),
      canEdit ? el('button', { class: 'primary', type: 'button', id: 'newDecision', 'data-feedback-id': 'central.decisiones.nueva', 'data-feedback-label': 'Nueva decisión', onclick: () => openDecisionEditor(ctx, null, data, (id) => navigate(`#/decisiones/${id}`)) }, icon('plus', 18), 'Nueva decisión') : null),
    coverHost, focusHost, deckHost,
    el('h3', { class: 'ctl-h' }, 'Todas las decisiones'),
    el('div', { class: 'toolbar', 'data-feedback-id': 'central.decisiones.barra', 'data-feedback-label': 'Búsqueda' }, search),
    chipsHost, host);

  const deck = createVoteDeck<Decision>({
    label: '¿Se mantienen?', items: [], feedbackId: 'central.decisiones.votar.baraja',
    name: (d) => d.name,
    card: (d) => {
      const t = voteTally(data.votes, d.id, d.reviewed_at);
      return el('div', { class: 'ctl-votecard' },
        el('div', { class: 'ctl-votehead' }, ...(d.scopes ?? []).slice(0, 3).map((s) => el('span', { class: 'chip' }, DECISION_SCOPE_LABELS[s] ?? s)), el('span', { class: 'hint', 'data-feedback-ignore': '' }, `${d.code ?? ''} · ${fmtDay(d.decided_on)}`)),
        el('h4', null, d.name), el('p', { class: 'pre ctl-clamp' }, d.summary), el('p', { class: 'hint' }, tallyText(t)));
    },
    onVote: (d, v) => void castVote(ctx, data, d, v === 'keep' ? 'mantener' : 'retirar'),
    onOpen: (d) => navigate(`#/decisiones/${d.id}`),
    texts: { keep: DECISION_VOTE_LABELS.mantener, drop: DECISION_VOTE_LABELS.retirar, keepLabel: 'Se mantiene: votar para que siga', dropLabel: 'Retirar: votar para quitarla',
      hint: 'Desliza la tarjeta: a la derecha se mantiene, a la izquierda se retira. También con los botones.', empty: 'Has votado todas las vigentes.', open: 'Leer entera' },
  });

  function paintTop(): void {
    const alive = data.rows.filter((d) => !d.deleted_at);
    const vigentes = alive.filter((d) => d.status === 'vigente');
    const toVote = decisionsToVote(alive, mineOf(data.votes, userId), userId ?? '');
    const last = recentDecisions(alive, 1)[0];
    const voters = new Set(data.votes.filter((v) => !v.deleted_at && v.voter_id).map((v) => v.voter_id));
    const faces = data.people.filter((p) => p.user_id && voters.has(p.user_id)).slice(0, 5).map((p) => ({ name: p.display_name }));
    replace(coverHost, alive.length ? renderCover({
      title: 'Decisiones de la casa', color: '#56663f', compact: true, faces,
      pill: toVote.length ? `${plural(toVote.length, 'por votar', 'por votar')}` : null, pillTone: toVote.length ? 'warn' : null,
      stats: [plural(vigentes.length, 'vigente', 'vigentes'), `${toVote.length} por votar`, `${alive.length - vigentes.length} ya no valen`, last ? `la última, ${fmtDay(last.decided_on)}` : ''].filter(Boolean).join(' · '),
      feedbackId: 'central.decisiones.portada.tarjeta',
    }) : null);
    // Foco: lo que toca decidir (más votos para retirarla que para mantenerla); si no hay, la última.
    const toDecide = decisionsToDecide(alive, data.votes);
    const items = (toDecide.length ? toDecide : last ? [last] : []).map((d) => {
      const t = voteTally(data.votes, d.id, d.reviewed_at);
      return { id: d.id, title: d.name, kicker: toDecide.length ? (isAdmin ? 'Te toca decidir' : 'Piden retirarla') : 'La última', tone: toDecide.length ? 'warn' as const : null,
        note: toDecide.length ? `${t.retirar} piden retirarla y ${t.mantener} mantenerla.${isAdmin ? ' Decide en su ficha.' : ' Decide quien administra.'}` : d.summary.slice(0, 160),
        meta: [d.code ?? '', fmtDay(d.decided_on)].filter(Boolean) };
    });
    replace(focusHost, items.length ? el('h3', { class: 'ctl-h' }, toDecide.length ? (isAdmin ? 'Lo que te toca decidir' : 'Lo que se está decidiendo') : 'La última decisión') : null,
      items.length ? createFocus({ label: 'Decisiones', items, onOpen: (i) => navigate(`#/decisiones/${i.id}`), feedbackId: 'central.decisiones.foco.tarjeta' }).element : null);
    deck.setItems(toVote);
    replace(deckHost, vigentes.length ? deck.element : null);
  }

  function paintChips(): void {
    const alive = data.rows.filter((d) => !d.deleted_at);
    const chip = (label: string, on: boolean, onclick: () => void, id: string) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(on), 'data-filter': id, onclick }, label);
    replace(chipsHost,
      el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'Estado', id: 'decisionStatus' },
        chip(`Todas (${alive.length})`, !status, () => { status = ''; paintAll(); }, 'estado:todas'),
        ...DECISION_STATUSES.map((s) => chip(`${statusLabel(s)} (${alive.filter((d) => d.status === s).length})`, status === s, () => { status = status === s ? '' : s; paintAll(); }, `estado:${s}`))),
      el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'App o área', id: 'decisionScope' },
        chip('Todas las apps', !scope, () => { scope = ''; paintAll(); }, 'area:todas'),
        ...DECISION_SCOPES.filter((s) => alive.some((d) => (d.scopes ?? []).includes(s))).map((s) => chip(`${DECISION_SCOPE_LABELS[s] ?? s} (${alive.filter((d) => (d.scopes ?? []).includes(s)).length})`, scope === s, () => { scope = scope === s ? '' : s; paintAll(); }, `area:${s}`))));
  }

  function row(d: Decision, recent: Set<string>): HTMLLIElement {
    const t = voteTally(data.votes, d.id);
    return listRow({
      id: d.id, title: d.name, pending: !!d._pending, label: d.name, onClick: () => navigate(`#/decisiones/${d.id}`),
      chips: [d.status !== 'vigente' ? statusChip(d.status) : null, recent.has(d.id) ? el('span', { class: 'chip ok' }, 'Reciente') : null].filter(Boolean) as HTMLElement[],
      meta: [el('span', { 'data-feedback-ignore': '' }, `${d.code ?? ''} · ${fmtDay(d.decided_on)}`), ...(d.scopes ?? []).map((s) => DECISION_SCOPE_LABELS[s] ?? s),
        ...(d.status === 'vigente' && (t.mantener || t.retirar) ? [tallyText(t)] : [])],
    });
  }

  function paintList(): void {
    const shown = filterDecisions(data.rows, query, scope, status);
    const recent = new Set(recentDecisions(data.rows, 3).map((d) => d.id));
    const vale = shown.filter((d) => d.status === 'vigente');
    const ya = shown.filter((d) => d.status !== 'vigente');
    const group = (title: string, rows: Decision[], id: string) => rows.length ? el('section', { class: 'ctl-group', 'data-group': id },
      el('div', { class: 'sectionlabel' }, title, el('span', { class: 'count' }, ` · ${rows.length}`)),
      el('ul', { class: 'list decisions' }, ...rows.map((d) => row(d, recent)))) : null;
    replace(host, shown.length ? el('div', null, group('Lo que vale hoy', vale, 'vigentes'), group('Ya no valen', ya, 'ya_no'))
      : el('div', { class: 'empty', 'data-feedback-id': 'central.decisiones.vacio', 'data-feedback-label': 'Sin decisiones' }, el('strong', null, data.rows.some((r) => !r.deleted_at) ? 'Ninguna decisión coincide' : 'Todavía no hay decisiones'),
        data.rows.length ? 'Cambia la búsqueda o quita los filtros.' : canEdit ? 'Apunta lo que se decide, para que cualquiera lo entienda después.' : ''));
  }

  function paintAll(): void { paintTop(); paintChips(); paintList(); }
  async function load(): Promise<void> { data = await loadAll(client); paintAll(); }
  void load();
  const offs = [T.decisions, T.decisionVotes, T.people].map((t) => client.onTable(t, () => void load()));
  return () => offs.forEach((off) => off());
};

// ---------------------------------------------------------------------------
// Ficha entera de una decisión
// ---------------------------------------------------------------------------
export function mountDecision(decisionId: string): ViewMount {
  return (ctx) => {
    const { main, client, isAdmin, usage } = ctx;
    const canEdit = client.bootstrap()?.membership.role !== 'reader';
    const userId = client.bootstrap()?.profile.userId ?? null;
    let data: Data = { rows: [], votes: [], people: [] };
    let remembered = false;
    const host = el('div', { id: 'decisionView', 'data-feedback-id': 'central.decision.contenido', 'data-feedback-label': 'Ficha de la decisión' });
    replace(main, el('a', { href: '#/decisiones', class: 'backlink', 'data-feedback-id': 'central.decision.volver', 'data-feedback-label': 'Volver a Decisiones' }, '‹ Decisiones'), host);
    const name = (pid: string | null) => data.people.find((p) => p.id === pid)?.display_name ?? null;
    const nameOfUser = (uid: string | null) => data.people.find((p) => p.user_id && p.user_id === uid)?.display_name ?? null;
    const link = (d: Decision, prefix: string, id: string) => el('a', { href: `#/decisiones/${d.id}`, class: 'ctl-trail', 'data-feedback-id': id === 'por' ? 'central.decision.sustituida_por' : 'central.decision.sustituye_a', 'data-feedback-label': prefix, 'data-feedback-ignore': '' },
      icon(id === 'por' ? 'chevronRight' : 'chevronLeft', 16), `${prefix} ${d.code ?? ''} ${d.name}`.trim());

    async function decide(d: Decision, outcome: 'mantener' | 'retirar'): Promise<void> {
      if (outcome === 'retirar' && !(await confirmDialog({ title: '¿Retirar la decisión?', text: 'Pasará a «Revocada». Queda registrado quién lo decidió, cuándo y con qué votos.', confirmLabel: 'Retirar', danger: true }))) return;
      const ops: RowOperation[] = [{ op: 'update', table: T.decisions, id: d.id, expectedRevision: d.revision, fields: { review_outcome: outcome, reviewed_at: new Date().toISOString() } }];
      const issue = validateOperations(ops, client.bootstrap()?.membership ?? { role: 'reader' }, () => d);
      if (issue) { toast(issue.message); return; }
      try {
        await usage.run('central.decision.decidir', () => client.commit(ops));
        toast(`${outcome === 'mantener' ? 'Se mantiene' : 'Retirada'}.${!navigator.onLine ? ' Se enviará cuando haya red.' : ''}`);
      } catch (e) { toast(describeError(e)); }
    }

    function paint(): void {
      const d = data.rows.find((r) => r.id === decisionId && !r.deleted_at);
      if (!d) { replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.decision.no_encontrada', 'data-feedback-label': 'Decisión no encontrada' }, el('strong', null, 'No se encontró la decisión'), 'Puede que se haya borrado.')); return; }
      document.title = `${d.name} · Ikisai Central`;
      if (!remembered) { remembered = true; ctx.remember({ hash: `#/decisiones/${d.id}`, title: d.name, kind: 'decision' }); }
      const trail = decisionTrail(data.rows, d.id);
      const replacement = d.superseded_by ? data.rows.find((r) => r.id === d.superseded_by && !r.deleted_at) : null;
      const previous = data.rows.filter((r) => !r.deleted_at && r.superseded_by === d.id);
      const all = voteTally(data.votes, d.id);
      const since = voteTally(data.votes, d.id, d.reviewed_at);
      const mine = myVoteOf(mineOf(data.votes, userId), d.id, userId ?? '');
      const responsible = name(d.responsible_person_id);
      replace(host,
        el('div', { class: 'pagehead', 'data-feedback-id': 'central.decision.cabecera', 'data-feedback-label': 'Cabecera de la decisión' }, el('div', null,
          el('span', { class: 'chips' }, statusChip(d.status), ...(d.scopes ?? []).map((s) => el('span', { class: 'chip' }, DECISION_SCOPE_LABELS[s] ?? s)), d._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null),
          el('h2', { tabindex: '-1', id: 'decisionTitle' }, d.name),
          el('p', { 'data-feedback-ignore': '' }, `${d.code ?? ''} · ${fmtDay(d.decided_on)}`)),
          canEdit ? el('button', { class: 'ghost', type: 'button', id: 'editDecision', 'data-feedback-id': 'central.decision.editar', 'data-feedback-label': 'Editar decisión', onclick: () => openDecisionEditor(ctx, d, data) }, icon('edit', 16), 'Editar') : null),
        replacement || previous.length ? el('div', { class: 'ctl-trails', 'data-feedback-id': 'central.decision.rastro', 'data-feedback-label': 'Sustituciones' },
          replacement ? link(replacement, 'Sustituida por', 'por') : null, ...previous.map((p) => link(p, 'Sustituye a', 'a'))) : null,
        el('section', { class: 'card personblock', 'data-feedback-id': 'central.decision.porque', 'data-feedback-label': 'Qué se decidió y por qué' },
          el('h3', null, 'Qué se decidió y por qué'), el('p', { class: 'pre' }, d.summary),
          d.technical ? el('details', { class: 'technical', 'data-feedback-id': 'central.decision.tecnica', 'data-feedback-label': 'Explicación técnica' }, el('summary', null, 'Explicación técnica'), el('p', { class: 'pre' }, d.technical)) : null,
          responsible ? el('p', { class: 'hint', 'data-feedback-ignore': '' }, `Responsable: ${responsible}`) : null,
          d.link_url ? el('a', { href: d.link_url, target: '_blank', rel: 'noopener', class: 'small', 'data-feedback-id': 'central.decision.enlace', 'data-feedback-label': 'Enlace externo', 'data-feedback-ignore': '' }, icon('attach', 14), ' ', d.link_label ?? d.link_url) : null),
        el('section', { class: 'card personblock', id: 'decisionVotes', 'data-feedback-id': 'central.decision.votos', 'data-feedback-label': 'Votos' },
          el('div', { class: 'blockhead' }, el('h3', null, '¿Se mantiene?'), el('span', { class: 'hint', id: 'decisionTally' }, tallyText(all))),
          d.status === 'vigente' ? el('div', { class: 'ctl-votebtns', role: 'group', 'aria-label': 'Tu voto' },
            el('button', { type: 'button', class: mine === 'mantener' ? 'primary' : 'ghost', 'aria-pressed': String(mine === 'mantener'), id: 'voteKeep', 'data-feedback-id': 'central.decision.votos.mantener', 'data-feedback-label': 'Se mantiene', onclick: () => void castVote(ctx, data, d, mine === 'mantener' ? null : 'mantener') }, icon('check', 18), DECISION_VOTE_LABELS.mantener),
            el('button', { type: 'button', class: mine === 'retirar' ? 'primary' : 'ghost', 'aria-pressed': String(mine === 'retirar'), id: 'voteDrop', 'data-feedback-id': 'central.decision.votos.retirar', 'data-feedback-label': 'Retirar', onclick: () => void castVote(ctx, data, d, mine === 'retirar' ? null : 'retirar') }, icon('close', 18), DECISION_VOTE_LABELS.retirar))
            : el('p', { class: 'hint' }, 'Solo se votan las decisiones vigentes.'),
          mine ? el('p', { class: 'hint' }, `Tu voto: ${DECISION_VOTE_LABELS[mine]}. Vuelve a tocarlo para quitarlo.`) : null,
          el('p', { class: 'hint' }, 'Los votos orientan; decide quien administra.')),
        el('section', { class: 'card personblock', id: 'decisionReview', 'data-feedback-id': 'central.decision.final', 'data-feedback-label': 'Decisión final' },
          el('h3', null, 'Decisión final'),
          d.reviewed_at ? el('p', { id: 'decisionReviewed' }, `${d.review_outcome ? DECISION_REVIEW_LABELS[d.review_outcome as 'mantener'] ?? d.review_outcome : 'Vuelta a vigente'} · ${nameOfUser(d.reviewed_by) ?? 'quien administra'}, ${fmtDay(d.reviewed_at)}${d.review_tally ? ` · con ${d.review_tally.mantener ?? 0} se mantiene y ${d.review_tally.retirar ?? 0} retirar` : ''}`)
            : el('p', { class: 'hint' }, 'Todavía sin decisión final.'),
          d.reviewed_at && (since.mantener || since.retirar) ? el('p', { class: 'hint' }, `Desde entonces: ${tallyText(since)}.`) : null,
          isAdmin && d.status === 'vigente' ? el('div', { class: 'ctl-votebtns' },
            el('button', { type: 'button', class: 'ghost', id: 'reviewKeep', 'data-feedback-id': 'central.decision.final.mantener', 'data-feedback-label': 'Mantener', onclick: () => void decide(d, 'mantener') }, icon('check', 18), 'Mantener'),
            el('button', { type: 'button', class: 'danger', id: 'reviewDrop', 'data-feedback-id': 'central.decision.final.retirar', 'data-feedback-label': 'Retirar', onclick: () => void decide(d, 'retirar') }, icon('close', 18), 'Retirar')) : null),
        trail.length > 1 ? el('section', { class: 'card personblock', 'data-feedback-id': 'central.decision.historia', 'data-feedback-label': 'Historia' },
          el('h3', null, 'Historia'),
          el('ol', { class: 'ctl-history' }, ...trail.map((t) => el('li', { 'aria-current': t.id === d.id ? 'true' : null },
            t.id === d.id ? el('strong', null, t.name) : el('a', { href: `#/decisiones/${t.id}`, 'data-feedback-ignore': '' }, t.name),
            el('span', { class: 'hint' }, ` · ${fmtDay(t.decided_on)} · ${statusLabel(t.status)}`))))) : null,
      );
    }
    async function load(): Promise<void> { data = await loadAll(client); paint(); }
    void load().then(() => main.querySelector<HTMLElement>('#decisionTitle')?.focus({ preventScroll: true }));
    const offs = [T.decisions, T.decisionVotes, T.people].map((t) => client.onTable(t, () => void load()));
    return () => offs.forEach((off) => off());
  };
}

// ---------------------------------------------------------------------------
// Editor (el de siempre)
// ---------------------------------------------------------------------------
function openDecisionEditor(ctx: ViewContext, d: Decision | null, data: Data, onCreated?: (id: string) => void): void {
  const { client, usage } = ctx;
  const rows = data.rows;
  const people = new Map(data.people.map((p) => [p.id, p.display_name]));
  let sheet: Sheet | null = null;
  const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive', 'data-feedback-id': 'central.decisiones.editar.error', 'data-feedback-label': 'Error del formulario' });
  const date = el('input', { id: 'dc-date', 'data-field-id': 'central.decisiones.date', 'data-field-entity': 'central.decisions', 'data-field-prop': 'decided_on', type: 'date', value: d?.decided_on ?? todayInMadrid() }) as HTMLInputElement;
  const name = el('input', { id: 'dc-name', 'data-field-id': 'central.decisiones.name', 'data-field-entity': 'central.decisions', 'data-field-prop': 'name', type: 'text', maxlength: '160', value: d?.name ?? '' }) as HTMLInputElement;
  const summary = el('textarea', { id: 'dc-summary', 'data-field-id': 'central.decisiones.summary', 'data-field-entity': 'central.decisions', 'data-field-prop': 'summary', rows: '4', maxlength: '2000' }) as HTMLTextAreaElement;
  summary.value = d?.summary ?? '';
  const technical = el('textarea', { id: 'dc-technical', 'data-field-id': 'central.decisiones.technical', 'data-field-entity': 'central.decisions', 'data-field-prop': 'technical', rows: '5', maxlength: '8000' }) as HTMLTextAreaElement;
  technical.value = d?.technical ?? '';
  const statusSel = el('select', { id: 'dc-status', 'data-field-id': 'central.decisiones.status', 'data-field-entity': 'central.decisions', 'data-field-prop': 'status' }, ...DECISION_STATUSES.map((s) => el('option', { value: s, selected: (d?.status ?? 'vigente') === s }, DECISION_STATUS_LABELS[s]))) as HTMLSelectElement;
  const others = rows.filter((r) => !r.deleted_at && r.id !== d?.id).sort((a, b) => b.decided_on.localeCompare(a.decided_on));
  const supersededBy = el('select', { id: 'dc-superseded', 'data-field-id': 'central.decisiones.superseded', 'data-field-entity': 'central.decisions', 'data-field-prop': 'superseded_by', 'data-feedback-ignore': '' }, el('option', { value: '' }, 'Elige la decisión nueva'),
    ...others.map((r) => el('option', { value: r.id, selected: d?.superseded_by === r.id }, `${r.code ?? ''} ${r.name}`))) as HTMLSelectElement;
  const supersededField = el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_sustituida_por', 'data-feedback-label': 'Sustituida por' }, el('span', null, 'Sustituida por'), supersededBy);
  const responsible = el('select', { id: 'dc-responsible', 'data-field-id': 'central.decisiones.responsible', 'data-field-entity': 'central.decisions', 'data-field-prop': 'responsible_person_id', 'data-feedback-ignore': '' }, el('option', { value: '' }, 'Sin responsable'),
    ...[...people].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([id, n]) => el('option', { value: id, selected: d?.responsible_person_id === id }, n))) as HTMLSelectElement;
  const scopeBoxes = DECISION_SCOPES.map((s) => el('input', { type: 'checkbox', value: s, 'data-feedback-id': 'central.decisiones.editar.area', 'data-feedback-label': 'Área afectada', checked: (d?.scopes ?? []).includes(s) }) as HTMLInputElement);
  const linkUrl = el('input', { id: 'dc-link', 'data-field-id': 'central.decisiones.link', 'data-field-entity': 'central.decisions', 'data-field-prop': 'link_url', 'data-feedback-ignore': '', type: 'url', maxlength: '500', placeholder: 'https://…', value: d?.link_url ?? '' }) as HTMLInputElement;
  const linkLabel = el('input', { id: 'dc-link-label', 'data-field-id': 'central.decisiones.link_label', 'data-field-entity': 'central.decisions', 'data-field-prop': 'link_label', type: 'text', maxlength: '120', placeholder: 'PR #123, documento, tarea…', value: d?.link_label ?? '' }) as HTMLInputElement;
  const sync = () => { supersededField.hidden = statusSel.value !== 'sustituida'; };
  sync();
  statusSel.addEventListener('change', sync);

  const values = (): Record<string, unknown> => ({
    decided_on: date.value, name: name.value.trim(), summary: summary.value.trim(), technical: text(technical.value), status: statusSel.value,
    superseded_by: statusSel.value === 'sustituida' ? supersededBy.value || null : null, responsible_person_id: responsible.value || null,
    scopes: scopeBoxes.filter((b) => b.checked).map((b) => b.value), link_url: text(linkUrl.value), link_label: text(linkLabel.value),
  });
  const changed = () => (d ? Object.fromEntries(Object.entries(values()).filter(([k, v]) => JSON.stringify(d[k] ?? null) !== JSON.stringify(v ?? null))) : values());
  const refresh = () => { const dirty = Object.keys(changed()).length > 0; guard.dirtyEditor = d ? dirty : name.value.trim() !== ''; sheet?.setFootHidden(d !== null && !dirty); };
  const save = el('button', { class: 'primary', type: 'submit', id: 'saveDecision', form: 'decisionForm', 'data-feedback-id': 'central.decisiones.editar.guardar', 'data-feedback-label': 'Guardar' }, 'Guardar') as HTMLButtonElement;
  const form = el('form', { novalidate: true, id: 'decisionForm', 'data-feedback-id': 'central.decisiones.editar.formulario', 'data-feedback-label': 'Formulario de la decisión', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
    event.preventDefault();
    error.textContent = '';
    const id = d?.id ?? crypto.randomUUID();
    const operations: RowOperation[] = d
      ? [{ op: 'update', table: T.decisions, id, expectedRevision: d.revision, fields: changed() }]
      : [{ op: 'insert', table: T.decisions, id, fields: values() }];
    const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' }, () => d ?? undefined);
    if (issue) { error.textContent = issue.message; error.scrollIntoView({ block: 'nearest' }); return; }
    save.disabled = true;
    try {
      await usage.run('central.decisiones.guardar', () => client.commit(operations));
      toast(!navigator.onLine ? 'Decisión guardada en este dispositivo. Se sincronizará cuando haya red.' : 'Decisión guardada.');
      guard.dirtyEditor = false;
      await sheet?.close(true);
      if (!d) onCreated?.(id);
    } catch (e) { error.textContent = describeError(e); } finally { save.disabled = false; }
  } },
  el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_nombre', 'data-feedback-label': 'Nombre' }, el('span', null, 'Nombre'), name, el('span', { class: 'muted small' }, 'En lenguaje llano: que lo entienda cualquiera sin contexto técnico.')),
  el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_resumen', 'data-feedback-label': 'Qué se decidió y por qué' }, el('span', null, 'Qué se decidió y por qué'), summary, el('span', { class: 'muted small' }, 'También en lenguaje llano, en pocas frases.')),
  el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_tecnica', 'data-feedback-label': 'Explicación técnica' }, el('span', null, 'Explicación técnica (opcional)'), technical, el('span', { class: 'muted small' }, 'Cómo se aplica, qué apps o tablas toca, alternativas descartadas.')),
  el('div', { class: 'fieldrow', 'data-feedback-id': 'central.decisiones.editar.fecha_estado', 'data-feedback-label': 'Fecha y estado' }, el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_fecha', 'data-feedback-label': 'Fecha' }, el('span', null, 'Fecha'), date), el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_estado', 'data-feedback-label': 'Estado' }, el('span', null, 'Estado'), statusSel)),
  supersededField,
  el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_responsable', 'data-feedback-label': 'Responsable' }, el('span', null, 'Responsable'), responsible),
  el('fieldset', { class: 'field scopes', 'data-feedback-id': 'central.decisiones.editar.areas', 'data-feedback-label': 'Apps o áreas afectadas' }, el('legend', null, 'Apps o áreas afectadas'),
    ...scopeBoxes.map((b) => el('label', { class: 'check' }, b, el('span', null, DECISION_SCOPE_LABELS[b.value] ?? b.value)))),
  el('div', { class: 'fieldrow', 'data-feedback-id': 'central.decisiones.editar.enlace_y_texto', 'data-feedback-label': 'Enlace' }, el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_enlace', 'data-feedback-label': 'Enlace' }, el('span', null, 'Enlace'), linkUrl), el('label', { class: 'field', 'data-feedback-id': 'central.decisiones.editar.campo_texto_enlace', 'data-feedback-label': 'Texto del enlace' }, el('span', null, 'Texto del enlace'), linkLabel)),
  error,
  d ? el('div', { class: 'zone', 'data-feedback-id': 'central.decisiones.editar.zona', 'data-feedback-label': 'Zona de peligro' }, el('button', { class: 'danger', type: 'button', id: 'deleteDecision', 'data-feedback-id': 'central.decisiones.editar.papelera', 'data-feedback-label': 'Enviar a papelera', onclick: async () => {
    if (!(await confirmDialog({ title: '¿Enviar la decisión a la papelera?', text: 'Si ya no vale, mejor márcala revocada o sustituida: así queda el rastro.', confirmLabel: 'Enviar a papelera', danger: true }))) return;
    try { await client.commit([{ op: 'delete', table: T.decisions, id: d.id, expectedRevision: d.revision }]); guard.dirtyEditor = false; await sheet?.close(true); toast('Decisión enviada a la papelera.'); ctx.navigate('#/decisiones'); }
    catch (e) { error.textContent = describeError(e); }
  } }, icon('trash', 18), 'Enviar a papelera')) : null);
  sheet = openSheet({
    title: d ? 'Editar decisión' : 'Nueva decisión', meta: d?.code ?? undefined, body: form,
    panelAttrs: { 'data-feedback-id': 'central.decisiones.editar', 'data-feedback-label': d ? 'Editar decisión' : 'Nueva decisión' },
    closeAttrs: { 'data-feedback-id': 'central.decisiones.editar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
    foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.decisiones.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, d ? 'Cerrar' : 'Cancelar'), save],
    footHidden: d !== null, initialFocus: name,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; sheet = null; },
  });
  // El código DEC_… va en la línea secundaria de la hoja.
  if (sheet) fbIgnoreWithin(sheet.element, '.sheet-body > .meta');
}


