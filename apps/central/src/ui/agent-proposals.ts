/**
 * Inicio › Propuestas de tus agentes (X1, vg-51; núcleo 0120, migración 1528). Un agente no entra en Central: propone desde su
 * app cambios en su propia ficha (misión, dónde trabaja y notas) y aquí decide su responsable o el owner. «Aplicar» lo aplica en
 * el acto con quien decide como autor del cambio; «Descartar» la cierra. Solo sale si hay alguna esperando. Necesita red.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { el, replace, toast, type Usage } from '@ikisai/ui-kit';
import { agentProposalChanges, agentProposalIssue, pendingAgentProposals, type AgentProposal, type AgentRow } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';

type Card = AgentRow & { mission?: string | null; work_areas?: string | null; notes?: string | null; deleted_at?: string | null };

export function mountAgentProposals(host: HTMLElement, client: SyncClient, usage: Usage, alive: () => boolean): void {
  const send = {
    aplicar: (id: string) => usage.run('central.inicio.propuestas.aplicar', () => client.api(`/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST' })),
    descartar: (id: string) => usage.run('central.inicio.propuestas.descartar', () => client.api(`/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST' })),
  };

  async function paint(): Promise<void> {
    let items: AgentProposal[] = [];
    try { items = pendingAgentProposals((await client.api<{ items: AgentProposal[] }>('/proposals?status=pending')).items ?? []); } catch { /* sin red o sin propuestas: no sale */ }
    if (!alive()) return;
    if (!items.length) { replace(host); host.hidden = true; return; }
    const agents = ((await client.list(T.agents)) as unknown as Card[]).filter((a) => !a.deleted_at);
    if (!alive()) return;
    host.hidden = false;
    replace(host,
      el('div', { class: 'blockhead' }, el('h3', null, 'Propuestas de tus agentes')),
      el('p', { class: 'muted small' }, 'Un agente propone cambios en su ficha. Al aplicarlos, quedan con tu nombre.'),
      el('ul', { class: 'list' }, ...items.map((p) => {
        const card = agents.find((a) => a.user_id === p.userId) ?? null;
        const issue = agentProposalIssue(p.operations, p.userId, agents);
        const changes = agentProposalChanges(p, card as Record<string, unknown> | null);
        const apply = el('button', { class: 'primary small', type: 'button', disabled: !!issue || !changes.length, 'data-feedback-id': 'central.inicio.propuestas.aplicar', 'data-feedback-label': 'Aplicar la propuesta', onclick: () => void decide(p, 'aplicar', card) }, 'Aplicar');
        const drop = el('button', { class: 'ghost small', type: 'button', 'data-feedback-id': 'central.inicio.propuestas.descartar', 'data-feedback-label': 'Descartar la propuesta', onclick: () => void decide(p, 'descartar', card) }, 'Descartar');
        return el('li', { class: 'ctl-proposal', 'data-proposal': p.id },
          el('strong', null, card ? `${card.display_name} propone cambiar su ficha` : 'Un agente sin ficha en Central'),
          changes.length ? el('dl', { class: 'small' }, ...changes.flatMap((c) => [
            el('dt', null, c.label, c.uncertain ? el('span', { class: 'chip warn' }, 'Por confirmar') : null),
            el('dd', null, c.before ? el('del', { class: 'muted' }, c.before) : null, c.before ? ' ' : null, c.after ? el('ins', null, c.after) : el('em', { class: 'muted' }, 'vacío')),
          ])) : el('p', { class: 'muted small' }, 'No cambia nada de lo que ya hay.'),
          issue ? el('p', { class: 'hint warn' }, `No se puede aplicar: ${issue}.`) : null,
          el('div', { class: 'actions' }, apply, drop));
      })));
  }

  async function decide(p: AgentProposal, how: keyof typeof send, card: Card | null): Promise<void> {
    if (!navigator.onLine) { toast('Decidir una propuesta necesita conexión.'); return; }
    try {
      await send[how](p.id);
      toast(how === 'aplicar' ? `Aplicado en la ficha de ${card?.display_name ?? 'el agente'}.` : 'Propuesta descartada.');
    } catch (e) { toast(describeError(e)); }
    await paint();
  }

  host.hidden = true;
  void paint();
}
