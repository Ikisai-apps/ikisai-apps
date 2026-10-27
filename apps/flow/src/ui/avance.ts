import { createLanes, el, groupLanes, replace, toast, type Lanes } from '@ikisai/ui-kit';
import { PROCEDURES } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { watchData, type Unit } from '../app/data.ts';
import type { ViewMount } from './shell.ts';

/**
 * «Avance por aplicaciones» (0937–0938; MUELA/equipo/feedback/flow/AVANCE_EN_FLOW.md): el tablero de los agentes como
 * flujo de Flow, copiado de la página del artefacto (v94).
 * 1. Caja general: porcentaje (hechas y en servicio sobre todo menos backlog), «N hechas de M», recuentos y barra.
 * 2. Discos por agente (anillo de estados, icono, porcentaje): conmutadores del filtro de carriles.
 * 3. Filas de estado, urgencia y oficio: conmutadores; dentro de la fila «o», entre filas «y»; lo que no cruza, atenuado.
 * 4. Pestañas / Lado a lado (`createLanes`) y carriles por agente (`groupLanes`) con sus tarjetas: urgencia, borde por
 *    estado, «Abrir ↗» y pasos al tocar. Quien puede escribir el carril cambia el estado desde la tarjeta.
 * Los filtros se recuerdan en el dispositivo. Sin fechas.
 */

type State = 'hecho' | 'pr' | 'curso' | 'pend' | 'backlog';
interface Card {
  id: string; lane: string; title: string; state: State; recurring: boolean; prio: string | null; tipo: string | null;
  order: number; ref: string | null; url: string | null; urlText: string | null; steps: string[]; note: string | null; unit: BoardUnit;
}
type BoardUnit = Omit<Unit, 'kind' | 'payload'> & { kind: string; lane_key: string | null; prio: string | null; board_flag: string | null;
  payload: { ref?: string; url?: string; url_text?: string; steps?: string[]; note?: string; tipo?: string } | null };

const STATES: Array<[State, string, string, string]> = [
  ['hecho', '#56663f', 'Hecho', '✔'], ['pr', '#3a7cc4', 'Fusión', '⤴'], ['curso', '#d19a3a', 'Activa', '◐'], ['pend', '#9a9a9a', 'Pendiente', '○'], ['backlog', '#c0392b', 'Backlog', '⛔'],
];
const PRIOS: Array<[string, string, string, string]> = [
  ['urgente', 'Urgente', '#c0392b', '★'], ['importante', 'Importante', '#e3a008', '★'], ['secundario', 'Secundario', '#3a7cc4', '☆'], ['opcional', 'Opcional', '#9a9a9a', '·'], ['sin', 'Ninguna', '#56663f', '–'],
];
const TIPOS: Array<[string, string, string, string]> = [
  ['arreglo', 'Arreglo', '🔧', '#c0392b'], ['funcion', 'Función', '⚒', '#56663f'], ['prueba', 'Prueba', '🧪', '#3a7cc4'], ['decision', 'Decisión', '🧭', '#d19a3a'], ['ajuste', 'Ajuste', '⚙', '#9a9a9a'],
];
/** Carriles conocidos: nombre y orden (filas del artefacto: Dirección, Núcleo, Generales, Específicas, Personas). */
const AGENTS: Array<[string, string]> = [
  ['victor', 'Víctor'], ['core', 'Core'], ['core_ops', 'Core Ops'], ['ui_kit', 'UI-kit'], ['central', 'Central'], ['flow', 'Flow'],
  ['food', 'Food'], ['finance', 'Finance'], ['tasks', 'Tasks'], ['booking', 'Booking'], ['guests', 'Guests'], ['organizers', 'Organizers'],
];
const AGENT_NAME = new Map(AGENTS);
const agentName = (k: string) => AGENT_NAME.get(k) ?? k;
const FILTER_KEY = 'flow-avance-filtro';

interface Filters { ag: string[]; est: string[]; pr: string[]; tipo: string[] }
function readFilters(): Filters {
  try { const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as Filters | null; if (f && Array.isArray(f.ag)) return { ag: f.ag, est: f.est ?? [], pr: f.pr ?? [], tipo: f.tipo ?? [] }; } catch { /* sin almacenamiento */ }
  return { ag: [], est: [], pr: [], tipo: [] };
}
function saveFilters(f: Filters): void { try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* sin almacenamiento */ } }

function toCard(u: BoardUnit): Card {
  const recurring = u.kind === 'recurring';
  const state: State = u.board_flag === 'backlog' ? 'backlog' : u.board_flag === 'pr' ? 'pr' : u.status === 'done' || recurring ? 'hecho' : u.status === 'in_progress' ? 'curso' : 'pend';
  const p = u.payload ?? {};
  return { id: u.id, lane: u.lane_key ?? '', title: u.label ?? '', state, recurring, prio: recurring ? null : u.prio, tipo: p.tipo ?? null, order: u.idx ?? 0,
    ref: p.ref ?? null, url: typeof p.url === 'string' && /^https:\/\//.test(p.url) ? p.url : null, urlText: p.url_text ?? null,
    steps: Array.isArray(p.steps) ? p.steps : [], note: p.note ?? null, unit: u };
}

const PRIO_RANK: Record<string, number> = { urgente: 0, importante: 1, secundario: 2, opcional: 3 };
const rank = (c: Card) => (c.state === 'backlog' ? 9 : PRIO_RANK[c.prio ?? ''] ?? 5);

export const mountAvance: ViewMount = ({ main, client, projectId }) => {
  let cards: Card[] = [];
  let filters = readFilters();
  const open = new Set<string>();
  const head = el('div', { class: 'avance-head', 'data-feedback-id': 'flow.avance', 'data-feedback-label': 'Avance' });
  const host = el('div', { class: 'avance-lanes' });
  let lanes: Lanes | null = null;
  replace(main, el('section', { class: 'avance' }, head, host));

  const has = (g: keyof Filters, k: string) => filters[g].includes(k);
  const toggle = (g: keyof Filters, k: string) => {
    filters = { ...filters, [g]: has(g, k) ? filters[g].filter((x) => x !== k) : [...filters[g], k] };
    saveFilters(filters); paint();
  };
  const passEx = (c: Card, skip: keyof Filters | null) =>
    (skip === 'est' || !filters.est.length || filters.est.includes(c.state))
    && (skip === 'pr' || !filters.pr.length || filters.pr.includes(c.prio ?? 'sin'))
    && (skip === 'tipo' || !filters.tipo.length || filters.tipo.includes(c.tipo ?? 'sin'))
    && (skip === 'ag' || !filters.ag.length || filters.ag.includes(c.lane));
  const anyFilter = () => !!(filters.ag.length || filters.est.length || filters.pr.length || filters.tipo.length);

  function counts(list: Card[]): Record<State, number> {
    const n: Record<State, number> = { hecho: 0, pr: 0, curso: 0, pend: 0, backlog: 0 };
    for (const c of list) n[c.state] += 1;
    return n;
  }
  const bar = (n: Record<State, number>, total: number) => el('span', { class: 'avance-bar', 'aria-hidden': 'true' },
    ...STATES.filter(([k]) => n[k]).map(([k, color]) => el('i', { style: `width:${(100 * n[k]) / (total || 1)}%;background:${color}` })));

  function chip(group: keyof Filters, key: string, color: string, label: string, glyph: string, inFilter: number, total: number): HTMLElement {
    const on = has(group, key);
    return el('button', { type: 'button', class: `avance-chip${inFilter ? '' : ' is-off'}`, style: `--c:${color}`, 'aria-pressed': String(on),
      title: anyFilter() ? `${label}: ${inFilter} con los filtros, ${total} en total` : label, onclick: () => toggle(group, key) },
      el('span', { class: 'g' }, glyph), el('strong', null, anyFilter() ? `${inFilter}` : `${total}`, anyFilter() ? el('span', { class: 'de' }, ` de ${total}`) : null),
      el('small', null, label));
  }

  function disc(lane: string): HTMLElement {
    const mine = cards.filter((c) => c.lane === lane);
    const n = counts(mine);
    const scope = (mine.length - n.backlog) || 1;
    const pct = Math.round((100 * n.hecho) / scope);
    let acc = 0;
    const stops = STATES.map(([k, color]) => { const from = acc; acc += (100 * n[k]) / (mine.length || 1); return `${color} ${from.toFixed(2)}% ${acc.toFixed(2)}%`; }).join(',');
    const inFilter = cards.filter((c) => c.lane === lane && passEx(c, 'ag')).length;
    return el('button', { type: 'button', class: `avance-disc${inFilter ? '' : ' is-off'}`, 'aria-pressed': String(has('ag', lane)), onclick: () => toggle('ag', lane),
      title: `${agentName(lane)}: ${n.hecho} hechas, ${n.pr} esperando fusión, ${n.curso} en marcha, ${n.pend} pendientes${n.backlog ? `, ${n.backlog} en backlog` : ''}` },
      el('span', { class: 'ring', style: `background:conic-gradient(${stops})` }, el('span', { class: 'in' }, agentName(lane).slice(0, 2))),
      el('span', { class: 'dt' }, el('span', { class: 'nm' }, agentName(lane)), el('b', null, `${pct}%`),
        el('small', null, anyFilter() ? `${inFilter} de ${mine.length}` : `✔${n.hecho} ○${mine.length - n.backlog - n.hecho}${n.backlog ? ` ⛔${n.backlog}` : ''}`)));
  }

  async function setState(c: Card, status: 'pending' | 'in_progress' | 'done'): Promise<void> {
    if (!isOnline(client)) { toast('Cambiar una tarjeta necesita conexión.'); return; }
    try {
      await callProcedure(client, PROCEDURES.boardCard, { project_id: projectId, card_id: c.id, lane_key: c.lane, status, ...(status === 'done' ? { flag: null } : {}) });
      void client.sync();
    } catch (error) { toast(describeError(error)); }
  }

  function cardEl(c: Card): HTMLElement {
    const isOpen = open.has(c.id);
    const tipo = TIPOS.find(([k]) => k === c.tipo);
    const prio = PRIOS.find(([k]) => k === c.prio);
    const body = el('div', null,
      tipo ? el('span', { class: 'avance-tipo', style: `--c:${tipo[3]}` }, `${tipo[2]} ${tipo[1]}`) : null,
      prio ? el('span', { class: `avance-prio p-${prio[0]}` }, `${prio[3]} ${prio[1]}`) : null,
      el('b', null, `${c.recurring ? '⟳ ' : ''}${c.title}`),
      c.note || c.ref ? el('div', { class: 'n' }, [c.note, c.ref].filter(Boolean).join(' · ')) : null,
      c.url ? el('div', { class: 'n' }, el('a', { href: c.url, target: '_blank', rel: 'noopener', onclick: (e: Event) => e.stopPropagation() }, `${c.urlText ?? 'Abrir'} ↗`)) : null,
      c.steps.length ? (isOpen ? el('ol', { class: 'avance-steps' }, ...c.steps.map((s) => el('li', null, s))) : el('div', { class: 'hint' }, 'Toca para ver los pasos')) : null,
      isOpen && !c.recurring ? el('div', { class: 'avance-acts' },
        ...([['pending', 'Pendiente'], ['in_progress', 'En curso'], ['done', 'Hecha']] as const).map(([s, label]) =>
          el('button', { type: 'button', class: 'ghost', 'aria-pressed': String(c.unit.status === s),
            onclick: (e: Event) => { e.stopPropagation(); void setState(c, s); } }, label))) : null);
    return el('div', { class: `avance-card is-${c.recurring ? 'activo' : c.state}`, role: 'button', tabindex: '0', 'aria-expanded': String(isOpen),
      onclick: () => { if (open.has(c.id)) open.delete(c.id); else open.add(c.id); paint(); },
      onkeydown: (ev: Event) => { const e = ev as KeyboardEvent; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } } },
      el('span', { class: 'dot', 'aria-hidden': 'true' }), body);
  }

  function paint(): void {
    const all = counts(cards);
    const scope = (cards.length - all.backlog) || 1;
    const shown = cards.filter((c) => passEx(c, null)).sort((a, b) => rank(a) - rank(b) || a.order - b.order);
    const lanesKeys = [...new Set([...AGENTS.map(([k]) => k).filter((k) => cards.some((c) => c.lane === k)), ...cards.map((c) => c.lane)])];
    const nE: Record<string, number> = {}, nP: Record<string, number> = {}, nT: Record<string, number> = {}, tP: Record<string, number> = {}, tT: Record<string, number> = {};
    for (const c of cards) {
      const p = c.prio ?? 'sin', t = c.tipo ?? 'sin';
      tP[p] = (tP[p] ?? 0) + 1; tT[t] = (tT[t] ?? 0) + 1;
      if (passEx(c, 'est')) nE[c.state] = (nE[c.state] ?? 0) + 1;
      if (passEx(c, 'pr')) nP[p] = (nP[p] ?? 0) + 1;
      if (passEx(c, 'tipo')) nT[t] = (nT[t] ?? 0) + 1;
    }
    replace(head,
      el('div', { class: 'avance-total', 'aria-label': 'Estado del proyecto' },
        el('div', { class: 'gl' }, el('b', null, `${Math.round((100 * all.hecho) / scope)}%`), el('span', { class: 'gt' }, `${all.hecho} hechas de ${scope}`),
          el('span', { class: 'gc' }, ...STATES.map(([k, color, label, glyph]) => el('em', { style: `color:${color}`, title: label }, glyph, el('u', null, String(all[k])))))),
        bar(all, cards.length)),
      el('div', { class: 'avance-discs', 'aria-label': 'Resumen por agente' }, ...lanesKeys.map(disc)),
      el('div', { class: 'avance-filters' },
        el('div', { class: 'fgrp' }, el('small', { class: 'fl' }, 'Estado'), el('div', { class: 'frow', role: 'group', 'aria-label': 'Filtrar por estado' },
          ...STATES.map(([k, color, label, glyph]) => chip('est', k, color, label, glyph, nE[k] ?? 0, all[k])))),
        el('div', { class: 'fgrp' }, el('small', { class: 'fl' }, 'Urgencia'), el('div', { class: 'frow', role: 'group', 'aria-label': 'Filtrar por urgencia' },
          ...PRIOS.map(([k, label, color, glyph]) => chip('pr', k, color, label, glyph, nP[k] ?? 0, tP[k] ?? 0)))),
        el('div', { class: 'fgrp' }, el('small', { class: 'fl' }, 'Oficio'), el('div', { class: 'frow', role: 'group', 'aria-label': 'Filtrar por oficio' },
          ...TIPOS.map(([k, label, glyph, color]) => chip('tipo', k, color, label, glyph, nT[k] ?? 0, tT[k] ?? 0))))));

    const visibleLanes = lanesKeys.filter((k) => !filters.ag.length || filters.ag.includes(k));
    const lanesData = groupLanes(shown.filter((c) => visibleLanes.includes(c.lane)), {
      key: (c) => c.lane, order: visibleLanes, hideEmpty: anyFilter(), title: (k) => agentName(k), emptyText: anyFilter() ? 'Nada con estos filtros.' : 'Nada.',
      mount: (body, items) => {
        const pending = items.filter((c) => c.state !== 'hecho');
        replace(body, el('p', { class: 'muted small' }, `${pending.filter((c) => c.state !== 'backlog').length} por hacer`),
          ...pending.map(cardEl), ...items.filter((c) => c.state === 'hecho').map(cardEl));
      },
    });
    if (!lanes) {
      lanes = createLanes({ label: 'Carriles del Avance', storageKey: 'flow-avance-vista', lanes: lanesData, feedbackId: 'flow.avance.carriles' });
      host.append(lanes.element);
    } else {
      lanes.setLanes(lanesData);
      lanes.refresh();
    }
  }

  const off = watchData(client, (d) => {
    cards = (d.units as unknown as BoardUnit[]).filter((u) => u.column_key === 'avance' && (u.kind === 'card' || u.kind === 'recurring')).map(toCard);
    paint();
  }, projectId ?? undefined);
  return () => { off(); lanes?.destroy(); };
};
