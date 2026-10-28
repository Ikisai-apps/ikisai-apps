import { confirmDialog, el, replace, toast } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { watchData, type Unit } from '../app/data.ts';
import { createAvanceOriginal, type OrigCard, type OrigHito, type OrigSnap } from './avance-original.ts';
import type { ViewMount } from './shell.ts';

/**
 * «Avance por aplicaciones» (0937–0947): la pantalla es la del artefacto original (VG, 28-10), en `avance-original.ts`, con los
 * datos del flujo. Aquí solo se traducen las unidades del tablero (tarjetas e hitos) y su historial a la forma del original,
 * y se escribe el estado con `flow.board_card` (el carril lo decide el guard; al marcar «Hecha», una nota opcional).
 * `#/p/<proyecto>/avance?carril=<agente>` (enlace de la ficha del agente en Central, #1148) entra filtrado por ese agente.
 */

type BoardUnit = Omit<Unit, 'kind' | 'payload'> & { kind: string; class?: string; parent_id?: string | null; lane_key: string | null; prio: string | null;
  board_flag: string | null; done_at?: string | null;
  payload: { ref?: string; url?: string; url_text?: string; steps?: string[]; note?: string; tipo?: string; paso?: number; orden?: number } | null };
interface Snap { taken_at: string; hecho: number; pr: number; curso: number; pend: number; backlog: number; total: number; deleted_at: string | null; project_id: string }

/** Agentes en el orden del original. */
const AGENTS: Array<[string, string]> = [['victor', 'Víctor'], ['core', 'Core'], ['core_ops', 'Core Ops'], ['ui_kit', 'UI-kit'], ['central', 'Central'], ['flow', 'Flow'],
  ['food', 'Food'], ['finance', 'Finance'], ['tasks', 'Tasks'], ['booking', 'Booking'], ['guests', 'Guests'], ['organizers', 'Organizers']];
const NAME = new Map(AGENTS);
const agentName = (lane: string) => NAME.get(lane) ?? lane;

function stateOf(u: BoardUnit): string {
  if (u.board_flag === 'backlog') return 'backlog';
  if (u.board_flag === 'pr') return 'pr';
  if (u.status === 'done' || u.kind === 'recurring') return 'hecho';
  return u.status === 'in_progress' ? 'curso' : 'pend';
}
const STATUS: Record<string, 'pending' | 'in_progress' | 'done'> = { pend: 'pending', curso: 'in_progress', hecho: 'done' };

export const mountAvance: ViewMount = ({ main, client, projectId }) => {
  const role = client.bootstrap()?.membership.role;
  const canEdit = role !== 'reader';
  // Enlace desde Central: entra con el filtro de ese agente (el original guarda sus filtros en el dispositivo).
  const linked = new URLSearchParams(location.hash.split('?')[1] ?? '').get('carril');
  if (linked && NAME.has(linked)) {
    try { localStorage.setItem('avance-car-filtro', JSON.stringify({ ag: { [agentName(linked)]: true }, est: {}, pr: {}, tipo: {}, hito: {}, flag: {} })); } catch { /* sin almacenamiento */ }
  }
  const hora = el('span', { class: 'hora' });
  const swSlot = el('span', { class: 'swslot' });
  const host = el('section', { class: 'car', 'aria-label': 'Carriles: el trabajo que le queda a cada agente' });
  replace(main, el('div', { class: 'avance-orig', 'data-feedback-id': 'flow.avance', 'data-feedback-label': 'Avance' },
    el('div', { class: 'top' }, hora, swSlot), host));

  let units: BoardUnit[] = [];
  let history: Snap[] = [];
  const view = createAvanceOriginal(host, hora, swSlot, canEdit, (uid, estado) => void setState(uid, estado));

  function paint(): void {
    const board = units.filter((u) => u.column_key === 'avance' && !u.deleted_at);
    const cards: OrigCard[] = board.filter((u) => u.kind === 'card' || u.kind === 'recurring').map((u) => {
      const p = u.payload ?? {};
      return { id: u.id.slice(0, 8), uid: u.id, agente: agentName(u.lane_key ?? ''), estado: stateOf(u), nombre: u.label ?? '', nota: p.note ?? null, ref: p.ref ?? null,
        url: p.url ?? null, urlTexto: p.url_text ?? null, pasos: Array.isArray(p.steps) ? p.steps : [], prio: u.kind === 'recurring' ? null : u.prio, tipo: p.tipo ?? null,
        recurrente: u.kind === 'recurring', orden: u.idx ?? 0, hito: u.parent_id ? { id: u.parent_id, paso: typeof p.paso === 'number' ? p.paso : null } : null };
    });
    const hitos: OrigHito[] = board.filter((u) => u.class === 'objective')
      .map((u, i) => ({ id: u.id, nombre: u.label ?? 'Hito', orden: u.payload?.orden ?? i + 1, done_at: u.done_at ? Date.parse(u.done_at) : null }));
    const hist: OrigSnap[] = history.map((s) => ({ t: Date.parse(s.taken_at), hecho: s.hecho, pr: s.pr, curso: s.curso, pend: s.pend, backlog: s.backlog, total: s.total }))
      .sort((a, b) => a.t - b.t);
    const present = new Set(cards.map((c) => c.agente));
    const agentes = [...AGENTS.map(([, n]) => n).filter((n) => present.has(n)), ...[...present].filter((n) => !AGENTS.some(([, m]) => m === n))];
    view.setData(cards, hitos, hist, agentes);
  }

  async function setState(uid: string, estado: string): Promise<void> {
    const u = units.find((x) => x.id === uid);
    const status = STATUS[estado];
    if (!u || !status) return;
    if (!isOnline(client)) { toast('Cambiar una tarjeta necesita conexión.'); return; }
    let note: string | null = null;
    if (status === 'done') {
      const input = el('textarea', { rows: '3', maxlength: '1000', 'aria-label': 'Nota (opcional)', placeholder: 'Qué se ha hecho, dónde verlo…' }) as HTMLTextAreaElement;
      if (!(await confirmDialog({ title: 'Marcar como hecha', text: u.label ?? '', confirmLabel: 'Hecha', body: el('label', null, 'Nota (opcional)', input) }))) return;
      note = input.value.trim() || null;
    }
    try {
      await callProcedure(client, PROCEDURES.boardCard, { project_id: projectId, card_id: u.id, lane_key: u.lane_key, status,
        ...(status === 'done' ? { flag: null } : {}), ...(note ? { note } : {}) });
      void client.sync();
    } catch (error) { toast(describeError(error)); }
  }

  async function loadHistory(): Promise<void> {
    try { history = ((await client.list(TABLES.boardHistory)) as unknown as Snap[]).filter((s) => s.project_id === projectId && !s.deleted_at); }
    catch { history = []; }
    paint();
  }
  const off = watchData(client, (d) => { units = d.units as unknown as BoardUnit[]; paint(); }, projectId ?? undefined);
  const offHistory = client.onTable(TABLES.boardHistory, () => void loadHistory());
  void loadHistory();
  return () => { off(); offHistory(); };
};
