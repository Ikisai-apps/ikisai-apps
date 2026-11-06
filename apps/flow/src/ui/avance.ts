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
  payload: { ref?: string; url?: string; url_text?: string; steps?: string[]; note?: string; tipo?: string; paso?: number; orden?: number; apps?: string[] } | null };
interface Snap { taken_at: string; hecho: number; pr: number; curso: number; pend: number; backlog: number; total: number; deleted_at: string | null; project_id: string }

/** Agentes en el orden del original. */
const AGENTS: Array<[string, string]> = [['victor', 'Víctor'], ['core', 'Core'], ['core_ops', 'Core Ops'], ['ui_kit', 'UI-kit'], ['central', 'Central'], ['flow', 'Flow'],
  ['food', 'Food'], ['finance', 'Finance'], ['tasks', 'Tasks'], ['booking', 'Booking'], ['guests', 'Guests'], ['organizers', 'Organizers']];
const NAME = new Map(AGENTS);
const agentName = (lane: string) => NAME.get(lane) ?? lane;
/** Aplicación de cada dominio (enlaces de apertura de las tarjetas): `ven` es la puerta de Guests e `invoices`, Finance. */
const HOST_APP: Record<string, string> = { flow: 'flow', food: 'food', finance: 'finance', invoices: 'finance', tasks: 'tasks', booking: 'booking',
  guests: 'guests', ven: 'guests', organizers: 'organizers', central: 'central' };
/**
 * Aplicaciones que nombra el texto de una tarjeta (fl-32, VG 06-11): «Flow», «Food», «Finance»… como palabra suelta.
 * Es una propuesta: la tarjeta sale «adivinada» hasta que alguien la confirme.
 */
const GUESS: Array<[RegExp, string]> = [[/\bflow\b/i, 'flow'], [/\bfood\b/i, 'food'], [/\bfinance\b|\bfacturas?\b/i, 'finance'], [/\btasks\b/i, 'tasks'],
  [/\bbooking\b/i, 'booking'], [/\bguests\b|\bven\b/i, 'guests'], [/\borganizers\b/i, 'organizers'], [/\bcentral\b/i, 'central'], [/\bui-?kit\b|\bkit\b/i, 'ui_kit']];
function guessedApps(texts: Array<string | undefined>): string[] {
  const text = texts.filter(Boolean).join(' · ');
  return GUESS.filter(([re]) => re.test(text)).map(([, app]) => app);
}

/** Aplicaciones a las que llevan los enlaces de una tarjeta (el de apertura y los de sus pasos y nota), en orden y sin repetir. */
function linkedApps(texts: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const t of texts) for (const m of (t ?? '').matchAll(/https:\/\/([a-z0-9-]+)\.ikisai\.com/g)) {
    const app = HOST_APP[m[1]!];
    if (app && !out.includes(app)) out.push(app);
  }
  return out;
}

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
    // Cabecera del original: título, la hora pequeña arriba a la derecha y el conmutador como submenú.
    el('header', { class: 'top' }, el('h1', null, 'Avance por aplicación'), el('span', { class: 'lft' }, swSlot), hora), host));

  let units: BoardUnit[] = [];
  let history: Snap[] = [];
  // «Tuyas» (tres toques en los pasos de los hitos): los carriles de la persona; owner sin carriles declarados, el de Víctor.
  const lanes = ((client.bootstrap()?.membership.scopes ?? {}) as { lanes?: string[] }).lanes ?? (role === 'owner' ? ['victor'] : []);
  const view = createAvanceOriginal(host, hora, swSlot, canEdit, (uid, estado) => void setState(uid, estado), lanes.map(agentName), (uid) => void setApps(uid), (uid, from, to) => void moveApp(uid, from, to), (uid) => void confirmApps(uid));

  function paint(): void {
    // Como `flow.board_counts`: todas las tarjetas e hitos del proyecto, estén en la columna que estén.
    const board = units.filter((u) => (!projectId || u.project_id === projectId) && !u.deleted_at);
    const cards: OrigCard[] = board.filter((u) => u.kind === 'card' || u.kind === 'recurring').map((u) => {
      const p = u.payload ?? {};
      return { id: u.id.slice(0, 8), uid: u.id, agente: agentName(u.lane_key ?? ''), estado: stateOf(u), nombre: u.label ?? '', nota: p.note ?? null, ref: p.ref ?? null,
        url: p.url ?? null, urlTexto: p.url_text ?? null, pasos: Array.isArray(p.steps) ? p.steps : [], prio: u.kind === 'recurring' ? null : u.prio, tipo: p.tipo ?? null,
        recurrente: u.kind === 'recurring', orden: u.idx ?? 0, hito: u.parent_id ? { id: u.parent_id, paso: typeof p.paso === 'number' ? p.paso : null } : null,
        ...appsOf(u) };
    });
    const hitos: OrigHito[] = board.filter((u) => u.class === 'objective')
      .map((u, i) => ({ id: u.id, nombre: u.label ?? 'Hito', orden: u.payload?.orden ?? i + 1, done_at: u.done_at ? Date.parse(u.done_at) : null }));
    const hist: OrigSnap[] = history.map((s) => ({ t: Date.parse(s.taken_at), hecho: s.hecho, pr: s.pr, curso: s.curso, pend: s.pend, backlog: s.backlog, total: s.total }))
      .sort((a, b) => a.t - b.t);
    const present = new Set(cards.flatMap((c) => [c.agente, ...(c.apps ?? [])]));
    const agentes = [...AGENTS.map(([, n]) => n).filter((n) => present.has(n)), ...[...present].filter((n) => !AGENTS.some(([, m]) => m === n))];
    view.setData(cards, hitos, hist, agentes);
  }

  /**
   * Vista «Por app» (VG, 28-10): las tareas de la persona van a las aplicaciones puestas a mano o, si no, a las de sus enlaces;
   * sin ninguna, se quedan en su carril. Las de los agentes, en el suyo salvo que se pongan a mano.
   */
  function appsOf(u: BoardUnit): { apps: string[]; appsManual: boolean; appsGuessed: boolean } {
    const p = u.payload ?? {};
    if (Array.isArray(p.apps) && p.apps.length) return { apps: p.apps.map(agentName), appsManual: true, appsGuessed: false };
    const steps = Array.isArray(p.steps) ? p.steps : [];
    const own = lanes.includes(u.lane_key ?? '');
    const linked = own ? linkedApps([p.url, p.note, ...steps]) : [];
    if (linked.length) return { apps: linked.map(agentName), appsManual: false, appsGuessed: false };
    // Sin aplicación ni enlaces: se adivina por el texto (fl-32); si no se adivina, en el carril de su dueño.
    const guessed = own ? guessedApps([u.label ?? undefined, p.note, ...steps]) : [];
    if (guessed.length) return { apps: guessed.map(agentName), appsManual: false, appsGuessed: true };
    return { apps: [agentName(u.lane_key ?? '')], appsManual: false, appsGuessed: false };
  }

  /** Confirmar de un toque la aplicación adivinada: queda puesta a mano. */
  async function confirmApps(uid: string): Promise<void> {
    const u = units.find((x) => x.id === uid);
    if (!u) return;
    if (!isOnline(client)) { toast('Cambiar una tarjeta necesita conexión.'); return; }
    const keyOf = new Map(AGENTS.map(([k, n]) => [n, k]));
    try {
      await callProcedure(client, PROCEDURES.boardCard, { project_id: projectId, card_id: u.id, lane_key: u.lane_key, apps: appsOf(u).apps.map((n) => keyOf.get(n) ?? n) });
      void client.sync();
    } catch (error) { toast(describeError(error)); }
  }

  /** Arrastrar una tarea tuya de un carril de aplicación a otro (fl-20): sale de `from` y entra en `to`; queda puesta a mano. */
  async function moveApp(uid: string, from: string, to: string): Promise<void> {
    const u = units.find((x) => x.id === uid);
    if (!u) return;
    if (!isOnline(client)) { toast('Cambiar una tarjeta necesita conexión.'); return; }
    const keyOf = new Map(AGENTS.map(([k, n]) => [n, k]));
    const next = [...appsOf(u).apps.filter((n) => n !== from && n !== to), to].map((n) => keyOf.get(n) ?? n);
    try {
      await callProcedure(client, PROCEDURES.boardCard, { project_id: projectId, card_id: u.id, lane_key: u.lane_key, apps: next });
      void client.sync();
    } catch (error) { toast(describeError(error)); }
  }

  /** Elegir a mano en qué aplicaciones se hace una tarea tuya (ninguna marcada: vuelve a lo que digan sus enlaces). */
  async function setApps(uid: string): Promise<void> {
    const u = units.find((x) => x.id === uid);
    if (!u) return;
    if (!isOnline(client)) { toast('Cambiar una tarjeta necesita conexión.'); return; }
    const current = Array.isArray(u.payload?.apps) ? u.payload!.apps! : [];
    const boxes = AGENTS.filter(([k]) => !lanes.includes(k)).map(([k, n]) => {
      const box = el('input', { type: 'checkbox', value: k, checked: current.includes(k) }) as HTMLInputElement;
      return { box, row: el('label', { class: 'apps-row' }, box, ' ', n) };
    });
    const none = el('input', { type: 'checkbox', value: 'none', checked: current.length === 1 && lanes.includes(current[0]!) }) as HTMLInputElement;
    const body = el('div', { class: 'apps-pick' }, el('p', { class: 'muted small' }, 'Sin ninguna marcada, va a las aplicaciones de sus enlaces o a la adivinada por el texto.'),
      el('label', { class: 'apps-row' }, none, ' ', 'Ninguna: se queda en mi carril'), ...boxes.map((b) => b.row));
    if (!(await confirmDialog({ title: 'Aplicaciones de la tarea', text: u.label ?? '', confirmLabel: 'Guardar', body }))) return;
    const apps = none.checked ? [u.lane_key ?? 'victor'] : boxes.filter((b) => b.box.checked).map((b) => b.box.value);
    try {
      await callProcedure(client, PROCEDURES.boardCard, { project_id: projectId, card_id: u.id, lane_key: u.lane_key, apps: apps.length ? apps : null });
      void client.sync();
    } catch (error) { toast(describeError(error)); }
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
