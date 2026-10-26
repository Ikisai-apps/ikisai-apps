/**
 * Propuestas del equipo de Ikisai en la ficha del retiro (decisión de VG del 26-10-2026, migración 0703).
 *
 * - Dirección, como coorganizadora sin permiso propio (`renderTeamDraft`): lo que cambia en Experiencia y Ofertas se junta
 *   en un borrador; aquí ve cuántos cambios lleva, los envía de una vez («Enviar a quien organiza») o los descarta, y sigue
 *   las que ya envió, que puede retirar.
 * - Quien organiza (`renderTeamInbox`): las propuestas pendientes de su retiro, con lo que cambia cada una, «Aceptar» y
 *   «Descartar». Nada cambia hasta que acepta; al aceptar, el lote se aplica como un commit suyo.
 *
 * Enviar, aceptar y descartar necesitan red. Si las sugerencias no se pueden leer, la tarjeta no sale.
 */
import { el, replace, toast } from '@ikisai/ui-kit';
import type { RowOperation, Suggestion } from '@ikisai/sync-client';
import { t } from '../app/i18n.ts';
import { describeError } from '../app/client.ts';
import { dayLabel } from '../app/labels.ts';
import { clearDraft, describeChange, draftOf, onDraft, ownedBy, type ChangeWhat } from '../app/proposal-draft.ts';
import { OWNED_TABLES, proposalReservation, TABLES, TEAM_PROPOSAL_KIND } from '../../../../supabase/functions/_domain/organizers/mod.ts';
import { needsNet } from './common.ts';
import type { ViewContext } from './shell.ts';

type Mounted = HTMLElement & { destroy: () => void };

const WHAT: Record<ChangeWhat, () => string> = {
  experience: () => t('Qué ven tus asistentes'),
  material: () => t('Material'),
  question: () => t('Pregunta'),
  offer: () => t('Oferta'),
  other: () => t('Otro dato'),
};
const ACTION = { add: () => t('Añade'), change: () => t('Cambia'), remove: () => t('Quita') } as const;

async function knownRows(ctx: ViewContext): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const table of [TABLES.experiences, TABLES.materials, TABLES.questions, TABLES.offers] as const) {
    for (const row of await ctx.client.list(table).catch(() => [])) out.set(row.id, row);
  }
  return out;
}

function changeList(operations: readonly RowOperation[], rows: Map<string, Record<string, unknown>>): HTMLElement {
  return el('ul', { class: 'orgproposal-changes' }, ...operations.map((op) => {
    const c = describeChange(op, rows);
    return el('li', null, `${ACTION[c.action]()} · ${WHAT[c.what]()}`, c.name ? ` «${c.name}»` : '');
  }));
}

const count = (n: number) => (n === 1 ? t('1 cambio') : t('{n} cambios', { n }));

/** Dirección: el borrador de este retiro y lo que ya envió. */
export function renderTeamDraft(ctx: ViewContext, reservationId: string, title: string): Mounted {
  const box = el('section', { class: 'card orgcard orgproposal', id: 'teamProposal', 'data-feedback-id': 'organizers.retiro.propuesta_equipo', 'data-feedback-label': 'Propuesta del equipo' }) as Mounted;
  let alive = true;
  let releases: Array<() => void> = [];
  let sent: Suggestion[] = [];

  async function loadSent(): Promise<void> {
    try {
      const out = await ctx.client.suggestions({ scope: 'mine' });
      sent = out.items.filter((s) => s.status === 'pending' && proposalReservation(s) === reservationId);
    } catch {
      sent = [];
    }
    if (alive) void paint();
  }

  async function send(): Promise<void> {
    const draft = draftOf(reservationId);
    if (!draft) return;
    try {
      await ctx.client.suggest({
        kind: TEAM_PROPOSAL_KIND, requestId: draft.requestId, operations: draft.operations,
        summary: `Propuesta del equipo de Ikisai: ${draft.operations.length} ${draft.operations.length === 1 ? 'cambio' : 'cambios'} en «${title}»`.slice(0, 300),
        detail: { reservation_id: reservationId },
      });
      clearDraft(reservationId);
      toast(t('Propuesta enviada. La verá quien organiza el retiro.'));
      await loadSent();
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function withdraw(id: string): Promise<void> {
    try {
      await ctx.client.withdrawSuggestion(id);
      toast(t('Propuesta retirada.'));
      await loadSent();
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function paint(): Promise<void> {
    releases.forEach((off) => off());
    releases = [];
    const draft = draftOf(reservationId);
    const rows = await knownRows(ctx);
    if (!alive) return;
    const sendButton = el('button', { type: 'button', class: 'primary', id: 'teamProposalSend', 'data-feedback-id': 'organizers.retiro.propuesta_equipo.enviar', 'data-feedback-label': 'Enviar propuesta', onclick: () => void send() }, t('Enviar a quien organiza'));
    const dropButton = el('button', { type: 'button', class: 'ghost', id: 'teamProposalDrop', 'data-feedback-id': 'organizers.retiro.propuesta_equipo.descartar', 'data-feedback-label': 'Descartar cambios', onclick: () => clearDraft(reservationId) }, t('Descartar cambios'));
    if (draft) releases.push(needsNet(ctx, sendButton, t('Enviar la propuesta necesita conexión.')));
    replace(box,
      el('h3', null, t('Propuesta para quien organiza')),
      el('p', { class: 'muted small' }, t('Ves este retiro desde dirección. Lo que cambies en Experiencia y Ofertas no se guarda en el retiro: se junta en una propuesta y quien organiza la acepta o la descarta.')),
      draft ? el('div', { id: 'teamProposalDraft' },
        el('p', null, el('strong', null, t('Sin enviar: {cambios}', { cambios: count(draft.operations.length) }))),
        changeList(draft.operations, rows),
        el('div', { class: 'btnrow' }, sendButton, dropButton)) : null,
      sent.length ? el('div', { id: 'teamProposalSent' },
        el('h4', null, t('Enviadas, a la espera')),
        ...sent.map((s) => el('div', { class: 'orgproposal-item' },
          el('p', null, t('{fecha} · {cambios}', { fecha: dayLabel(s.createdAt), cambios: count(s.operations.length) })),
          changeList(s.operations, rows),
          el('button', { type: 'button', class: 'ghost', 'data-feedback-id': 'organizers.retiro.propuesta_equipo.retirar', 'data-feedback-label': 'Retirar propuesta', onclick: () => void withdraw(s.id) }, t('Retirar'))))) : null,
      !draft && !sent.length ? el('p', { class: 'small' }, t('Aún no hay cambios propuestos.')) : null);
  }

  const offDraft = onDraft((id) => { if (id === reservationId && alive) void paint(); });
  void loadSent();
  box.destroy = () => { alive = false; offDraft(); releases.forEach((off) => off()); };
  return box;
}

/** Quien organiza: las propuestas pendientes de su retiro. Sin ninguna (o sin poder leerlas), la tarjeta queda vacía. */
export function renderTeamInbox(ctx: ViewContext, reservationId: string): Mounted {
  const box = el('div', { id: 'teamInboxHost' }) as Mounted;
  let alive = true;
  let releases: Array<() => void> = [];

  async function decide(s: Suggestion, decision: 'approve' | 'reject'): Promise<void> {
    try {
      if (decision === 'approve') {
        // Lo nuevo en materiales y preguntas pasa a su biblioteca: el dueño es quien acepta (0700).
        await ctx.client.decideSuggestion(s.id, 'approve', { operations: ownedBy(s.operations, ctx.userId, OWNED_TABLES) });
        void ctx.client.sync().catch(() => undefined);
        toast(t('Cambios aceptados.'));
      } else {
        await ctx.client.decideSuggestion(s.id, 'reject');
        toast(t('Propuesta descartada.'));
      }
    } catch (error) {
      toast(describeError(error));
    }
    await load();
  }

  async function load(): Promise<void> {
    let items: Suggestion[] = [];
    try {
      items = (await ctx.client.suggestions({ scope: 'pending' })).items.filter((s) => proposalReservation(s) === reservationId);
    } catch {
      items = [];
    }
    const rows = await knownRows(ctx);
    if (!alive) return;
    releases.forEach((off) => off());
    releases = [];
    if (!items.length) { replace(box); return; }
    replace(box, el('section', { class: 'card orgcard orgproposal', id: 'teamInbox', 'data-feedback-id': 'organizers.retiro.propuestas_equipo', 'data-feedback-label': 'Propuestas del equipo' },
      el('h3', null, t('Propuestas del equipo de Ikisai')),
      el('p', { class: 'muted small' }, t('Dirección de Ikisai propone estos cambios en Experiencia y Ofertas. Nada cambia hasta que los aceptes.')),
      ...items.map((s) => {
        const accept = el('button', { type: 'button', class: 'primary', 'data-feedback-id': 'organizers.retiro.propuestas_equipo.aceptar', 'data-feedback-label': 'Aceptar propuesta', onclick: () => void decide(s, 'approve') }, t('Aceptar'));
        const reject = el('button', { type: 'button', class: 'ghost', 'data-feedback-id': 'organizers.retiro.propuestas_equipo.descartar', 'data-feedback-label': 'Descartar propuesta', onclick: () => void decide(s, 'reject') }, t('Descartar'));
        releases.push(needsNet(ctx, accept), needsNet(ctx, reject));
        return el('article', { class: 'orgproposal-item', dataset: { suggestion: s.id } },
          el('p', null, el('strong', null, t('De {nombre} · {fecha}', { nombre: s.author.name || t('dirección de Ikisai'), fecha: dayLabel(s.createdAt) }))),
          changeList(s.operations, rows),
          el('div', { class: 'btnrow' }, accept, reject));
      })));
  }

  void load();
  box.destroy = () => { alive = false; releases.forEach((off) => off()); };
  return box;
}
