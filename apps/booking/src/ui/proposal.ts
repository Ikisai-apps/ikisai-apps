/** Bloque «Propuesta» de la ficha (docs/booking/API.md §15.2): versión vigente, acciones por estado e historial de versiones. */
import type { RejectedBatch, SyncClient, TableName } from '@ikisai/sync-client';
import { confirmDialog, el, icon, renderMoneyBreakdown, toast, type Child } from '@ikisai/ui-kit';
import { PROCEDURES } from '@ikisai/domain-booking';
import { CONDITIONS, PROPOSALS, PROPOSAL_LINES, TIERS, describeError, fullDay, today } from '../app/client.ts';
import { RATE_LABELS } from '../app/labels.ts';
import { currentProposal, eur, figures, isPast, lineAmounts, type Row } from '../app/rates.ts';

export interface ProposalData {
  /** Propuestas vivas de la reserva. */
  proposals: Row[];
  /** Líneas vivas de esas propuestas. */
  lines: Row[];
  conditions: Row[];
  tiers: Row[];
}

/** Lee del espejo lo necesario para el bloque; `null` si el rol no puede leer propuestas. */
export async function loadProposals(client: SyncClient, reservationId: string): Promise<ProposalData | null> {
  if (!client.bootstrap()?.tables.some((t) => t.table === PROPOSALS && t.readable)) return null;
  const live = async (table: TableName) => ((await client.list(table)) as Row[]).filter((r) => r.deleted_at === null);
  const proposals = (await live(PROPOSALS)).filter((p) => p.reservation_id === reservationId);
  const ids = new Set(proposals.map((p) => p.id));
  return { proposals, lines: (await live(PROPOSAL_LINES)).filter((l) => ids.has(l.proposal_id)), conditions: await live(CONDITIONS), tiers: await live(TIERS) };
}

/** Importes y estado de la propuesta vigente, para el resumen de la ficha. */
export function proposalSummary(data: ProposalData | null): string | null {
  const current = data ? currentProposal(data.proposals) : null;
  if (!data || !current) return null;
  const f = figures(current, data.lines.filter((l) => l.proposal_id === current.id), data.conditions.find((c) => c.id === current.conditions_id) ?? null);
  return `v${current.version} ${RATE_LABELS.status[current.status]?.toLowerCase()} · ${eur(f.total)}`;
}

// --- marcas de lotes pendientes (como la confirmación de reserva: `sync-client` no aplica un `call` en local)

const KEY = 'booking.proposalMarks';
type Kind = 'new' | 'send' | 'accept';
interface Mark { reservationId: string; proposalId: string; kind: Kind; requestId: string }

function readMarks(): Mark[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Mark[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeMarks(marks: Mark[]): void {
  try {
    if (marks.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(marks));
  } catch {
    /* sin almacenamiento: no hay marca, pero la cola sigue funcionando */
  }
}
const settled = (mark: Mark, proposals: Row[]): boolean => {
  const p = proposals.find((x) => x.id === mark.proposalId);
  return mark.kind === 'new' ? !!p : !!p && (mark.kind === 'send' ? p.status !== 'borrador' : p.status === 'aceptada');
};

export interface MarkState { pending: Mark[]; rejected: Array<{ mark: Mark; batch: RejectedBatch }> }

/** Marcas de esta reserva que siguen esperando al servidor y las que el servidor rechazó. Retira las ya reflejadas o huérfanas. */
export async function loadMarks(client: SyncClient, reservationId: string, proposals: Row[]): Promise<MarkState> {
  const all = readMarks();
  const rejectedBatches = await client.rejected();
  const idle = client.status().pendingCommands === 0;
  const keep: Mark[] = [];
  const state: MarkState = { pending: [], rejected: [] };
  for (const mark of all) {
    if (mark.reservationId !== reservationId) { keep.push(mark); continue; }
    if (settled(mark, proposals)) continue;
    const batch = rejectedBatches.find((b) => b.requestId === mark.requestId);
    if (batch) { state.rejected.push({ mark, batch }); keep.push(mark); continue; }
    if (idle) continue;
    state.pending.push(mark);
    keep.push(mark);
  }
  if (keep.length !== all.length) writeMarks(keep);
  return state;
}

export const hasProposalMarks = (reservationId: string): boolean => readMarks().some((m) => m.reservationId === reservationId);

/** Mensaje de un fallo al enviar o aceptar. */
function explain(error: unknown): string {
  return (error as { code?: string } | null)?.code === 'INVALID_TRANSITION' ? 'La propuesta ya no está en el estado esperado: actualiza la ficha.' : describeError(error);
}

export interface ProposalBlockOptions {
  client: SyncClient;
  reservation: Row;
  data: ProposalData;
  marks: MarkState;
  editable: boolean;
  navigate(hash: string): void;
  /** Vuelve a pintar la ficha. */
  refresh(): void;
}

const doc = (id: string) => `#/propuesta/${id}/documento`;

export function renderProposalBlock(options: ProposalBlockOptions): HTMLElement {
  const { client, reservation, data, marks, editable, navigate } = options;
  const current = currentProposal(data.proposals);
  // Un borrador más reciente que la versión vigente (nueva versión en curso): se edita y se envía desde aquí.
  const nextDraft = current && current.status !== 'borrador'
    ? data.proposals.filter((p) => p.status === 'borrador' && Number(p.version) > Number(current.version)).sort((a, b) => Number(b.version) - Number(a.version))[0] ?? null : null;
  const linesOf = (p: Row) => data.lines.filter((l) => l.proposal_id === p.id);
  const conditionsOf = (p: Row) => data.conditions.find((c) => c.id === p.conditions_id) ?? null;

  async function launch(kind: Kind, procedure: string, args: Record<string, unknown>, proposalId: string, message: string): Promise<void> {
    try {
      const { requestId } = await client.commit([{ op: 'call', procedure, args }]);
      writeMarks([...readMarks().filter((m) => m.proposalId !== proposalId || m.kind !== kind), { reservationId: reservation.id, proposalId, kind, requestId }]);
      toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`);
      options.refresh();
    } catch (error) {
      toast(explain(error));
    }
  }

  async function startNew(from: Row | null): Promise<void> {
    const proposalId = crypto.randomUUID();
    await launch('new', PROCEDURES.newProposalVersion, { reservation_id: reservation.id, proposal_id: proposalId, ...(from ? { from_proposal_id: from.id } : {}) }, proposalId,
      from ? 'Nueva versión creada.' : 'Propuesta creada.');
  }

  async function send(p: Row): Promise<void> {
    await launch('send', PROCEDURES.sendProposal, { proposal_id: p.id, expectedRevision: p.revision }, p.id, 'Propuesta marcada como enviada.');
  }

  async function accept(p: Row): Promise<void> {
    const f = figures(p, linesOf(p), conditionsOf(p));
    const go = await confirmDialog({
      title: 'Aceptar propuesta',
      text: `Al aceptar la versión ${p.version} se fijan en la reserva el importe final (${eur(f.total)}) y la señal requerida (${eur(f.deposit_amount)}), y las demás versiones pasan a «sustituida».`,
      confirmLabel: 'Aceptar propuesta',
    });
    if (go) await launch('accept', PROCEDURES.acceptProposal, { proposal_id: p.id, expectedRevision: p.revision }, p.id, 'Propuesta aceptada.');
  }

  async function close(p: Row, status: 'rechazada' | 'caducada'): Promise<void> {
    const go = await confirmDialog({
      title: status === 'rechazada' ? 'Marcar como rechazada' : 'Marcar como caducada',
      text: `La versión ${p.version} se queda como ${status} y no se puede volver a enviar. Podrás crear una nueva versión.`,
      confirmLabel: status === 'rechazada' ? 'Marcar rechazada' : 'Marcar caducada',
    });
    if (!go) return;
    try {
      await client.commit([{ op: 'update', table: PROPOSALS, id: p.id, expectedRevision: p.revision, fields: { status, decided_at: new Date().toISOString() } }]);
      toast(navigator.onLine ? `Propuesta marcada como ${status}.` : `Propuesta marcada como ${status}. Se enviará al reconectar.`);
    } catch (error) {
      toast(describeError(error));
    }
  }

  const button = (id: string, text: string, onclick: () => void, kind = 'ghost small', ...icons: Child[]) => el('button', { class: kind, type: 'button', id, onclick }, ...icons, text);

  // --- cuerpo
  const body: Child[] = [];
  for (const { mark, batch } of marks.rejected) {
    body.push(el('div', { class: 'banner alert', role: 'alert', dataset: { role: 'proposalRejected' } },
      el('span', null, `No se pudo ${mark.kind === 'new' ? 'crear la propuesta' : mark.kind === 'send' ? 'enviar la propuesta' : 'aceptar la propuesta'}: ${explain(batch.error)}`),
      el('button', { class: 'ghost small', type: 'button', onclick: async () => {
        await client.discardRejected(mark.requestId);
        writeMarks(readMarks().filter((m) => m.requestId !== mark.requestId));
        options.refresh();
      } }, 'Entendido')));
  }
  if (marks.pending.length > 0) {
    body.push(el('p', null, el('span', { class: 'chip pending', id: 'proposalPendingChip' },
      marks.pending.some((m) => m.kind === 'new') ? 'Propuesta pendiente de enviar al servidor' : 'Cambio de propuesta pendiente de enviar')));
  }

  if (!current) {
    body.push(el('p', { class: 'hint' }, 'Todavía no hay propuesta para esta reserva.'));
  } else {
    const f = figures(current, linesOf(current), conditionsOf(current));
    const lines = linesOf(current).sort((a, b) => Number(a.position) - Number(b.position));
    const amounts = lineAmounts(lines);
    const expired = current.status === 'enviada' && isPast(current.valid_until, today());
    body.push(
      el('div', { class: 'chips' },
        el('span', { class: `chip${current.status === 'aceptada' ? ' ok' : current.status === 'borrador' ? ' pending' : ''}`, id: 'proposalStatus', dataset: { status: current.status } }, `v${current.version} · ${RATE_LABELS.status[current.status]}`),
        el('span', { class: 'chip', id: 'proposalNature' }, RATE_LABELS.nature[current.nature]),
        current._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null),
      expired ? el('p', { class: 'banner alert', id: 'proposalExpired', role: 'alert' }, `La propuesta era válida hasta el ${fullDay(current.valid_until)} y sigue enviada: márcala como caducada o crea una nueva versión.`) : null,
      lines.length === 0 ? el('p', { class: 'hint' }, 'Sin líneas todavía: edita la propuesta y sugiere las del tarifario.') : (() => {
        const breakdown = renderMoneyBreakdown({
          totalLabel: f.live ? 'Total (en vivo)' : 'Total', total: f.total, sort: false, max: 4,
          lines: lines.map((l) => ({ id: l.id, label: String(l.description), amount: amounts.get(l.id) ?? 0 })),
        });
        breakdown.querySelector('.mb-total .mb-amount')?.setAttribute('id', 'proposalTotal');
        return breakdown;
      })(),
      el('dl', { class: 'kv' },
        el('dt', null, 'Señal'), el('dd', { id: 'proposalDeposit' }, eur(f.deposit_amount)),
        el('dt', null, 'IVA'), el('dd', null, f.includesVat ? `Incluido (${f.vatRate} %)` : `${eur(f.vat_amount)} (${f.vatRate} %), no incluido`),
        el('dt', null, 'Condiciones'), el('dd', null, conditionsOf(current)?.name ?? 'Sin elegir'),
        el('dt', null, 'Válida hasta'), el('dd', null, current.valid_until ? fullDay(current.valid_until) : '—')),
    );
  }

  if (nextDraft) {
    const df = figures(nextDraft, linesOf(nextDraft), conditionsOf(nextDraft));
    body.push(el('p', { class: 'hint', id: 'proposalDraft' }, `La versión ${nextDraft.version} está en borrador (${eur(df.total)}). Hasta que la marques enviada, la vigente sigue siendo la versión ${current!.version}.`));
  }
  const actions: Child[] = [];
  if (editable && nextDraft) {
    actions.push(button('editProposal', `Editar versión ${nextDraft.version}`, () => navigate(`#/propuesta/${nextDraft.id}`), 'primary small', icon('edit', 16)),
      button('sendProposal', `Marcar enviada la versión ${nextDraft.version}`, () => void send(nextDraft)));
  }
  if (editable) {
    if (!current) actions.push(button('createProposal', 'Crear propuesta', () => void startNew(null), 'primary small', icon('plus', 16)));
    else if (current.status === 'borrador') {
      actions.push(button('editProposal', 'Editar', () => navigate(`#/propuesta/${current.id}`), 'primary small', icon('edit', 16)),
        button('sendProposal', 'Marcar enviada', () => void send(current)));
    } else {
      if (current.status === 'enviada') {
        actions.push(button('acceptProposal', 'Aceptada', () => void accept(current)), button('rejectProposal', 'Rechazada', () => void close(current, 'rechazada')),
          button('expireProposal', 'Caducada', () => void close(current, 'caducada')));
      }
      if (!nextDraft) actions.push(button('newVersion', 'Nueva versión', () => void startNew(current), current.status === 'enviada' ? 'ghost small' : 'primary small'));
    }
  }
  if (current) actions.push(button('viewDocument', 'Ver documento', () => navigate(doc(current.id))));

  const older = data.proposals.filter((p) => p.id !== current?.id).sort((a, b) => Number(b.version) - Number(a.version));
  const history = older.length === 0 ? null : el('details', { class: 'more-panel', id: 'proposalHistory' },
    el('summary', null, `Historial de versiones (${older.length})`),
    el('ul', { class: 'list' }, older.map((p) => {
      const f = figures(p, linesOf(p), conditionsOf(p));
      return el('li', { class: 'row', dataset: { version: String(p.version) } },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, `Versión ${p.version}`), el('span', { class: 'chip' }, RATE_LABELS.status[p.status]), el('span', null, eur(f.total))),
        el('div', { class: 'row-meta' }, p.sent_at ? `Enviada el ${fullDay(String(p.sent_at).slice(0, 10))}` : 'Sin enviar', ' · ',
          el('a', { href: doc(p.id) }, 'Ver documento', el('span', { class: 'vh' }, ` de la versión ${p.version}`))));
    })));

  return el('article', { class: 'card', id: 'blockProposal' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Propuesta')),
    body, actions.length ? el('div', { class: 'choices', style: 'margin-top:10px' }, actions) : null, history);
}
