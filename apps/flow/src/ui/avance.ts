import { confirmDialog, createLanes, el, groupLanes, icon, replace, toast, type IconName, type Lanes } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { watchData, type Unit } from '../app/data.ts';
import type { ViewMount } from './shell.ts';

/**
 * «Avance por aplicaciones» (0937–0938, 0947; especificación de Core para la mudanza en AVANCE_EN_FLOW.md). Móvil primero.
 * 1. Cabecera: «Actualizado a las hh:mm».
 * 2. Caja general: % de hechas sobre el total sin backlog, «N hechas de T», contadores por estado y barra; con filtros, «V
 *    visibles de P por hacer de T». Al tocarla, el gráfico: dos paneles (total/hechas/pendientes; fusión/en marcha/backlog),
 *    banderas de los hitos cumplidos y los números del día.
 * 3. Fichas de agente (anillo por estados, %, recuentos, «depósito» proporcional al carril mayor, borde verde al 100 %): filtran.
 * 4. Chips de estado, urgencia y oficio con «n de total»; «o» en la fila, «y» entre filas.
 * 5. Hitos: numerados (número fijo aunque se filtre), ordenados por la urgencia de su paso pendiente más urgente (los completos
 *    al final); barra, «n de m», el primer paso sin hacer «bloquea»; pasos en cadena; leyenda que también filtra; tocar uno filtra.
 * 6. Carriles por agente (los vacíos no se pintan): urgencia → lo listo antes que lo «en espera» → hito y paso → orden.
 *    Una tarjeta con hito está «para hacer» solo si todos los pasos anteriores de su hito (sin backlog) están hechos; con el
 *    mismo número de paso no se bloquean. Con filtros, toda tarjeta abierta del carril (pase o no el filtro) cuyo paso
 *    anterior sin hacer no pasa el conjunto de filtros activos va plegada al final, con «bloqueada por: <tarjeta> (agente)»;
 *    si su bloqueador pasa los filtros, sale en su sitio con «en espera». Sin filtros no se pliega nada.
 * «Actualizado a las»: la hora del último cambio recibido.
 * Escribir: Pendiente / En curso / Hecha desde la tarjeta (`flow.board_card`; el carril lo decide el guard).
 */

type State = 'hecho' | 'pr' | 'curso' | 'pend' | 'backlog';
type BoardUnit = Omit<Unit, 'kind' | 'payload'> & { kind: string; class?: string; parent_id?: string | null; lane_key: string | null; prio: string | null;
  board_flag: string | null; updated_at?: string; payload: { ref?: string; url?: string; url_text?: string; steps?: string[]; note?: string; tipo?: string; paso?: number; orden?: number } | null };
interface Card {
  id: string; lane: string; title: string; state: State; recurring: boolean; prio: string | null; tipo: string | null; order: number;
  ref: string | null; url: string | null; urlText: string | null; steps: string[]; note: string | null; hito: string | null; paso: number | null; unit: BoardUnit;
  /** El primer paso sin hacer de su hito (lo que bloquea), si esta tarjeta espera a otro. */
  waitsFor: Card | null;
  /** Todos los pasos anteriores de su hito sin hacer. */
  waitsAll: Card[]; blocks: boolean;
}
interface Hito { id: string; title: string; orden: number; doneAt: string | null; steps: Card[]; number: number }
interface Snap { taken_at: string; hecho: number; pr: number; curso: number; pend: number; backlog: number; total: number; deleted_at: string | null; project_id: string }

/** Colores con los tokens del kit (tienen su variante oscura); el azul de «fusión» no tiene token. */
const C = { ok: 'var(--ok,#497044)', warn: 'var(--warn,#c58b2a)', alert: 'var(--alert,#ae3f29)', muted: 'var(--muted,#616d64)', blue: 'var(--info,#3a7cc4)' };
const STATES: Array<[State, string, string, string]> = [
  ['hecho', C.ok, 'Hecho', '✔'], ['pr', C.blue, 'Fusión', '⤴'], ['curso', C.warn, 'Activa', '◐'], ['pend', C.muted, 'Pendiente', '○'], ['backlog', C.alert, 'Backlog', '⛔'],
];
const PRIOS: Array<[string, string, string, string]> = [
  ['urgente', 'Urgente', C.alert, '★'], ['importante', 'Importante', C.warn, '★'], ['secundario', 'Secundario', C.blue, '☆'], ['opcional', 'Opcional', C.muted, '·'], ['sin', 'Ninguna', C.ok, '–'],
];
const TIPOS: Array<[string, string, string, string]> = [
  ['arreglo', 'Arreglo', '🔧', C.alert], ['funcion', 'Función', '⚒', C.ok], ['prueba', 'Prueba', '🧪', C.blue], ['decision', 'Decisión', '🧭', C.warn], ['ajuste', 'Ajuste', '⚙', C.muted],
];
/** Leyenda de los hitos (también filtra). */
const LEGEND: Array<[string, string, string]> = [
  ['hecho', 'Hecho', C.ok], ['curso', 'En marcha', C.warn], ['pr', 'Esperando fusión', C.blue], ['pend', 'Pendiente', C.muted],
  ['bloquea', 'Bloquea', C.alert], ['espera', 'En espera', 'var(--warn-ink,#7a5414)'], ['urgente', 'Urgente', C.alert], ['tuyo', 'Tuyo', 'var(--ink)'],
];
/** Carriles y sus filas (Dirección y Núcleo, Generales; Específicas y Personas). */
const ROW1: Array<[string, string]> = [['victor', 'Víctor'], ['core', 'Core'], ['core_ops', 'Core Ops'], ['ui_kit', 'UI-kit'], ['central', 'Central'], ['flow', 'Flow']];
const ROW2: Array<[string, string]> = [['food', 'Food'], ['finance', 'Finance'], ['tasks', 'Tasks'], ['booking', 'Booking'], ['guests', 'Guests'], ['organizers', 'Organizers']];
const AGENTS = [...ROW1, ...ROW2];
/** Icono de cada carril (los del lanzador del kit). */
const AGENT_ICON: Record<string, IconName> = { victor: 'user', core: 'mark', core_ops: 'list', ui_kit: 'tag', central: 'grid', flow: 'board',
  food: 'chef', finance: 'invoice', tasks: 'tasks', booking: 'bed', guests: 'guest', organizers: 'organizer' };
/** Tecla Intro o espacio en un elemento con rol de botón. */
const onActivate = (fn: () => void) => (ev: Event) => { const e = ev as KeyboardEvent; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
const AGENT_NAME = new Map(AGENTS);
const agentName = (k: string) => AGENT_NAME.get(k) ?? k;
const FILTER_KEY = 'flow-avance-filtro';
const PRIO_RANK: Record<string, number> = { urgente: 0, importante: 1, secundario: 2, opcional: 3 };

interface Filters { ag: string[]; est: string[]; pr: string[]; tipo: string[]; ley: string[]; hito: string[] }
const EMPTY: Filters = { ag: [], est: [], pr: [], tipo: [], ley: [], hito: [] };
function readFilters(): Filters {
  try { const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as Partial<Filters> | null; if (f) return { ...EMPTY, ...f }; } catch { /* sin almacenamiento */ }
  return { ...EMPTY };
}
function saveFilters(f: Filters): void { try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* sin almacenamiento */ } }

function stateOf(u: BoardUnit): State {
  if (u.board_flag === 'backlog') return 'backlog';
  if (u.board_flag === 'pr') return 'pr';
  if (u.status === 'done' || u.kind === 'recurring') return 'hecho';
  return u.status === 'in_progress' ? 'curso' : 'pend';
}
const hhmm = (iso: string | null) => (iso ? new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(iso)) : '—');

/** Curva suave (Catmull-Rom → Bézier) de una serie de puntos ya escalados. */
function smooth(points: Array<[number, number]>): string {
  if (!points.length) return '';
  let d = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!, p1 = points[i]!, p2 = points[i + 1]!, p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]!.toFixed(1)},${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)},${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export const mountAvance: ViewMount = ({ main, client, projectId }) => {
  let cards: Card[] = [];
  let hitos: Hito[] = [];
  let history: Snap[] = [];
  let updatedAt: string | null = null;
  let filters = readFilters();
  // `?carril=<agente>` (enlace de la ficha del agente en Central, #1148): entra filtrado por ese carril.
  const linked = new URLSearchParams(location.hash.split('?')[1] ?? '').get('carril');
  if (linked && /^[a-z][a-z0-9_]{1,30}$/.test(linked)) filters = { ag: [linked], est: [], pr: [], tipo: [], ley: [], hito: [] };
  /** Ficha de cada agente en Central (`central.agent_lanes_projection`): carril → id de la ficha. */
  let agentIds = new Map<string, string>();
  if (projectId) {
    void client.api<{ rows: Array<{ flow_project: string; flow_lane: string; agent_id: string; active: boolean }> }>(`/read/central.agent_lanes_projection?flow_project=${projectId}&limit=100`)
      .then((r) => { agentIds = new Map((r.rows ?? []).filter((a) => a.active !== false).map((a) => [a.flow_lane, a.agent_id])); paint(); }).catch(() => undefined);
  }
  let chartOpen = false;
  const open = new Set<string>();
  const role = client.bootstrap()?.membership.role;
  const scopes = (client.bootstrap()?.membership.scopes ?? {}) as { lanes?: string[] };
  /** «Tuyo»: los carriles de la persona (owner sin carriles declarados: el de Víctor). */
  const mine = new Set(scopes.lanes ?? (role === 'owner' ? ['victor'] : []));

  const head = el('div', { class: 'avance-head', 'data-feedback-id': 'flow.avance', 'data-feedback-label': 'Avance' });
  const hitosHost = el('section', { class: 'avance-hitos', 'aria-label': 'Hitos' });
  const host = el('div', { class: 'avance-lanes' });
  let lanes: Lanes | null = null;
  replace(main, el('section', { class: 'avance' }, head, hitosHost, host));

  const has = (g: keyof Filters, k: string) => filters[g].includes(k);
  const toggle = (g: keyof Filters, k: string) => {
    filters = { ...filters, [g]: has(g, k) ? filters[g].filter((x) => x !== k) : [...filters[g], k] };
    saveFilters(filters); paint();
  };
  const anyFilter = () => Object.values(filters).some((v) => v.length);
  /** Marcas de la leyenda que tiene una tarjeta. */
  /** Lo que la bloquea: el primer paso anterior que no pasa los filtros activos, si lo hay; si no, el primero. */
  const blockerOf = (c: Card) => (anyFilter() && c.waitsAll.find((b) => !passEx(b, null))) || c.waitsFor;
  /** Con filtros, bloqueada «por fuera»: algún paso anterior sin hacer de su hito no pasa el conjunto de filtros activos. */
  const outside = (c: Card) => c.state !== 'hecho' && anyFilter() && c.waitsAll.some((b) => !passEx(b, null));
  const marks = (c: Card) => [c.state, ...(c.blocks ? ['bloquea'] : []), ...(c.waitsFor ? ['espera'] : []), ...(c.prio === 'urgente' ? ['urgente'] : []), ...(mine.has(c.lane) ? ['tuyo'] : [])];
  const passEx = (c: Card, skip: keyof Filters | null) =>
    (skip === 'est' || !filters.est.length || filters.est.includes(c.state))
    && (skip === 'pr' || !filters.pr.length || filters.pr.includes(c.prio ?? 'sin'))
    && (skip === 'tipo' || !filters.tipo.length || filters.tipo.includes(c.tipo ?? 'sin'))
    && (skip === 'ag' || !filters.ag.length || filters.ag.includes(c.lane))
    && (skip === 'ley' || !filters.ley.length || marks(c).some((m) => filters.ley.includes(m)))
    && (skip === 'hito' || !filters.hito.length || (c.hito !== null && filters.hito.includes(c.hito)));

  function counts(list: Card[]): Record<State, number> {
    const n: Record<State, number> = { hecho: 0, pr: 0, curso: 0, pend: 0, backlog: 0 };
    for (const c of list) n[c.state] += 1;
    return n;
  }
  const bar = (n: Record<State, number>, total: number) => el('span', { class: 'avance-bar', 'aria-hidden': 'true' },
    ...STATES.filter(([k]) => n[k]).map(([k, color]) => el('i', { style: `width:${(100 * n[k]) / (total || 1)}%;background:${color}` })));

  function chip(group: keyof Filters, key: string, color: string, label: string, glyph: string, inFilter: number, total: number): HTMLElement {
    return el('button', { type: 'button', class: `avance-chip${inFilter ? '' : ' is-off'}`, style: `--c:${color}`, 'aria-pressed': String(has(group, key)),
      title: anyFilter() ? `${label}: ${inFilter} con los filtros, ${total} en total` : label, onclick: () => toggle(group, key) },
      el('span', { class: 'g' }, glyph), el('strong', null, anyFilter() ? `${inFilter}` : `${total}`, anyFilter() ? el('span', { class: 'de' }, ` de ${total}`) : null),
      el('small', null, label));
  }

  function disc(lane: string, maxN: number): HTMLElement {
    const list = cards.filter((c) => c.lane === lane);
    const n = counts(list);
    const scope = (list.length - n.backlog) || 1;
    const pct = Math.round((100 * n.hecho) / scope);
    let acc = 0;
    const stops = STATES.map(([k, color]) => { const from = acc; acc += (100 * n[k]) / (list.length || 1); return `${color} ${from.toFixed(2)}% ${acc.toFixed(2)}%`; }).join(',');
    const inFilter = cards.filter((c) => c.lane === lane && passEx(c, 'ag')).length;
    // «Depósito»: lo hecho y lo que hay en juego, proporcionales al carril más grande.
    const dH = (100 * n.hecho) / maxN, dT = (100 * (list.length - n.backlog)) / maxN;
    const tank = `background:linear-gradient(to top,color-mix(in srgb,${C.ok} 40%,transparent) 0 ${dH.toFixed(1)}%,color-mix(in srgb,${C.warn} 28%,transparent) ${dH.toFixed(1)}% ${dT.toFixed(1)}%,transparent ${dT.toFixed(1)}% 100%)`;
    return el('button', { type: 'button', class: `avance-disc${inFilter ? '' : ' is-off'}${pct === 100 && list.length ? ' is-full' : ''}`, style: tank,
      'aria-pressed': String(has('ag', lane)), onclick: () => toggle('ag', lane),
      title: `${agentName(lane)}: ${n.hecho} hechas, ${n.pr} esperando fusión, ${n.curso} en marcha, ${n.pend} pendientes${n.backlog ? `, ${n.backlog} en backlog` : ''}` },
      el('span', { class: 'ring', style: `background:conic-gradient(${stops})` }, el('span', { class: 'in' }, icon(AGENT_ICON[lane] ?? 'grid', 24))),
      el('span', { class: 'dt' }, el('span', { class: 'nm' }, agentName(lane)), el('b', null, `${pct}%`),
        el('small', null, anyFilter() ? `${inFilter} de ${list.length}` : `✔${n.hecho} ○${list.length - n.backlog - n.hecho}${n.backlog ? ` ⛔${n.backlog}` : ''}`)));
  }

  function chart(): HTMLElement {
    const now = cards.length ? counts(cards) : null;
    const series: Snap[] = [...history].sort((a, b) => a.taken_at.localeCompare(b.taken_at));
    if (now) series.push({ taken_at: new Date().toISOString(), ...now, total: cards.length, deleted_at: null, project_id: projectId ?? '' });
    if (series.length < 2) return el('p', { class: 'muted small' }, 'Aún no hay historial para el gráfico.');
    const W = 320, H = 90, t0 = Date.parse(series[0]!.taken_at), t1 = Date.parse(series.at(-1)!.taken_at) || t0 + 1;
    const x = (t: string) => ((Date.parse(t) - t0) / ((t1 - t0) || 1)) * W;
    const panel = (keys: Array<[keyof Snap, string]>) => {
      const max = Math.max(1, ...series.flatMap((s) => keys.map(([k]) => Number(s[k]))));
      const y = (v: number) => H - (v / max) * (H - 6) - 3;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'avance-chart'); svg.setAttribute('aria-hidden', 'true');
      const defs = document.createElementNS(svg.namespaceURI, 'defs'); svg.append(defs);
      keys.forEach(([k, color], i) => {
        const pts = series.map((s) => [x(s.taken_at), y(Number(s[k]))] as [number, number]);
        const grad = document.createElementNS(svg.namespaceURI, 'linearGradient');
        grad.setAttribute('id', `avg-${String(k)}-${i}`); grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0'); grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
        for (const [offset, opacity] of [['0', '.35'], ['1', '0']] as const) {
          const stop = document.createElementNS(svg.namespaceURI, 'stop') as SVGElement;
          stop.setAttribute('offset', offset); stop.style.stopColor = color; stop.setAttribute('stop-opacity', opacity);
          grad.append(stop);
        }
        defs.append(grad);
        const line = smooth(pts);
        const area = document.createElementNS(svg.namespaceURI, 'path');
        area.setAttribute('d', `${line} L${pts.at(-1)![0].toFixed(1)},${H} L${pts[0]![0].toFixed(1)},${H} Z`); area.setAttribute('fill', `url(#avg-${String(k)}-${i})`);
        const path = document.createElementNS(svg.namespaceURI, 'path') as SVGElement;
        path.setAttribute('d', line); path.setAttribute('fill', 'none'); path.style.stroke = color; path.setAttribute('stroke-width', '2');
        svg.append(area, path);
      });
      // Banderas de los hitos cumplidos.
      for (const h of hitos.filter((h) => h.doneAt && Date.parse(h.doneAt) >= t0)) {
        const fx = x(h.doneAt!);
        const line = document.createElementNS(svg.namespaceURI, 'line') as SVGElement;
        for (const [k, v] of [['x1', fx], ['x2', fx], ['y1', 0], ['y2', H]] as const) line.setAttribute(k, String(v));
        line.style.stroke = C.ok; line.setAttribute('stroke-dasharray', '2 2');
        const label = document.createElementNS(svg.namespaceURI, 'text') as SVGElement;
        label.setAttribute('x', String(fx + 2)); label.setAttribute('y', '9'); label.setAttribute('font-size', '8'); label.style.fill = C.ok;
        label.textContent = `⚑ ${h.number}. ${h.title.length > 18 ? `${h.title.slice(0, 17)}…` : h.title}`;
        const tip = document.createElementNS(svg.namespaceURI, 'title'); tip.textContent = `${h.number}. ${h.title}`; label.append(tip);
        svg.append(line, label);
      }
      return svg;
    };
    const last = series.at(-1)!;
    const at = (ms: number) => [...series].reverse().find((s) => Date.parse(s.taken_at) <= Date.parse(last.taken_at) - ms) ?? series[0]!;
    const d24 = at(24 * 3600e3), d7 = at(7 * 24 * 3600e3);
    const days7 = Math.max(1, (Date.parse(last.taken_at) - Date.parse(d7.taken_at)) / (24 * 3600e3));
    // Un solo gráfico (VG, 27-10): por hacer, esperando fusión, en marcha y backlog, con las banderas de los hitos cumplidos.
    const SERIES: Array<[keyof Snap, string, string]> = [['pend', C.muted, 'Por hacer'], ['pr', C.blue, 'Esperando fusión'], ['curso', C.warn, 'En marcha'], ['backlog', C.alert, 'Backlog']];
    const legend = el('p', { class: 'avance-chart-legend small' }, ...SERIES.map(([, color, label]) => el('span', null, el('i', { style: `background:${color}` }), label)));
    const pend24 = last.pend - d24.pend;
    // Números en un bloque compacto: uno grande (hechas en 24 h y el ritmo), dos pequeños y una fila fina.
    const stats = el('div', { class: 'avance-stats' },
      el('div', { class: 'avance-stat-big' }, el('b', null, String(last.hecho - d24.hecho)), el('span', null, 'hechas en 24 h'),
        el('small', null, `${((last.hecho - d7.hecho) / days7).toFixed(1)} al día (7 d)`)),
      el('div', { class: 'avance-stat-side' },
        el('div', null, el('b', null, String(last.pr)), el('span', null, `esperando fusión · máx. ${Math.max(...series.map((s) => s.pr))}`)),
        el('div', null, el('b', null, String(last.curso)), el('span', null, 'en marcha'))),
      el('p', { class: 'avance-stat-row small' },
        `Pendientes en 24 h ${pend24 >= 0 ? '+' : ''}${pend24} · Hitos cumplidos ${hitos.filter((h) => h.doneAt).length} · Tareas en total ${cards.length} · Fotos ${history.length}`));
    return el('div', { class: 'avance-chart-box' }, panel(SERIES.map(([k, color]) => [k, color])), legend, stats);
  }

  async function setState(c: Card, status: 'pending' | 'in_progress' | 'done'): Promise<void> {
    if (!isOnline(client)) { toast('Cambiar una tarjeta necesita conexión.'); return; }
    // Al cerrar, una nota opcional (VG: «con una nota opcional»).
    let note: string | null = null;
    if (status === 'done') {
      const input = el('textarea', { rows: '3', maxlength: '1000', 'aria-label': 'Nota (opcional)', placeholder: 'Qué se ha hecho, dónde verlo…' }) as HTMLTextAreaElement;
      const ok = await confirmDialog({ title: 'Marcar como hecha', text: c.title, confirmLabel: 'Hecha', body: el('label', null, 'Nota (opcional)', input) });
      if (!ok) return;
      note = input.value.trim() || null;
    }
    try {
      await callProcedure(client, PROCEDURES.boardCard, { project_id: projectId, card_id: c.id, lane_key: c.lane, status,
        ...(status === 'done' ? { flag: null } : {}), ...(note ? { note } : {}) });
      void client.sync();
    } catch (error) { toast(describeError(error)); }
  }

  const hitoOf = (id: string | null) => hitos.find((h) => h.id === id) ?? null;
  /** Abrir o cerrar una tarjeta repinta solo esa tarjeta (sin rehacer los carriles: no se pierde el foco ni el desplazamiento). */
  const cardNodes = new Map<string, HTMLElement>();
  function toggleCard(c: Card): void {
    if (open.has(c.id)) open.delete(c.id); else open.add(c.id);
    const old = cardNodes.get(c.id);
    const fresh = cardEl(c);
    if (old?.isConnected) { old.replaceWith(fresh); (fresh.querySelector('.avance-card-title') as HTMLElement | null)?.focus(); }
  }
  function cardEl(c: Card): HTMLElement {
    const isOpen = open.has(c.id);
    const tipo = TIPOS.find(([k]) => k === c.tipo);
    const h = hitoOf(c.hito);
    const decision = c.tipo === 'decision';
    // El contenedor no es un botón (lleva enlaces y botones dentro): el título es el botón que abre y cierra.
    const node = el('div', { class: `avance-card is-${c.recurring ? 'activo' : c.state}${c.waitsFor ? ' is-waiting' : ''}${mine.has(c.lane) ? ' is-mine' : ''}` },
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('div', null,
        tipo ? el('span', { class: 'avance-tipo', style: `--c:${tipo[3]}`, title: tipo[1] }, tipo[2]) : null,
        c.prio === 'urgente' ? el('span', { class: 'avance-prio p-urgente' }, '★ Urgente') : null,
        el('button', { type: 'button', class: 'avance-card-title', 'aria-expanded': String(isOpen), onclick: () => toggleCard(c) }, `${c.recurring ? '⟳ ' : ''}${c.title}`),
        c.note || c.ref ? el('div', { class: 'n' }, [c.note, c.ref].filter(Boolean).join(' · ')) : null,
        c.url ? el('div', { class: 'n' }, el('a', { href: c.url, target: '_blank', rel: 'noopener' }, `${c.urlText ?? 'Abrir'} ↗`)) : null,
        h ? el('div', { class: 'n avance-hito-line' }, `⛳ ${h.number}. ${h.title}${c.paso ? ` · paso ${c.paso}` : ''}`) : null,
        c.waitsFor ? el('div', { class: 'n avance-wait' }, `⏳ en espera · bloqueada por: «${blockerOf(c)!.title}» (${agentName(blockerOf(c)!.lane)})`) : null,
        c.steps.length ? (isOpen
          ? el(decision ? 'ul' : 'ol', { class: `avance-steps${decision ? ' is-decision' : ''}` }, ...c.steps.map((s) => el('li', null, s)))
          : el('div', { class: 'hint' }, decision ? 'Toca el título para ver las preguntas' : 'Toca el título para ver los pasos')) : null,
        isOpen && !c.recurring ? el('div', { class: 'avance-acts' },
          ...([['pending', 'Pendiente'], ['in_progress', 'En curso'], ['done', 'Hecha']] as const).map(([s, label]) =>
            el('button', { type: 'button', class: 'ghost', 'aria-pressed': String(c.unit.status === s), onclick: () => void setState(c, s) }, label))) : null));
    cardNodes.set(c.id, node);
    return node;
  }

  function hitosEl(): HTMLElement[] {
    if (!hitos.length) return [];
    const urgency = (h: Hito) => { const pend = h.steps.filter((s) => s.state !== 'hecho' && s.state !== 'backlog'); return pend.length ? Math.min(...pend.map((s) => PRIO_RANK[s.prio ?? ''] ?? 5)) : 99; };
    const ordered = [...hitos].sort((a, b) => urgency(a) - urgency(b) || a.orden - b.orden);
    return [
      el('h2', { class: 'avance-section' }, 'Hitos'),
      el('div', { class: 'avance-legend', role: 'group', 'aria-label': 'Leyenda (filtra)' },
        ...LEGEND.map(([k, label, color]) => el('button', { type: 'button', class: 'avance-legend-item', style: `--c:${color}`, 'aria-pressed': String(has('ley', k)), onclick: () => toggle('ley', k) },
          el('i', { 'aria-hidden': 'true' }), label))),
      ...ordered.map((h) => {
        const live = h.steps.filter((s) => s.state !== 'backlog');
        const done = live.filter((s) => s.state === 'hecho').length;
        return el('div', { class: `avance-hito${h.doneAt ? ' is-done' : ''}`, role: 'button', tabindex: '0', 'aria-pressed': String(has('hito', h.id)),
          onclick: () => toggle('hito', h.id), onkeydown: onActivate(() => toggle('hito', h.id)) },
          el('div', { class: 'avance-hito-head' }, el('strong', null, `${h.number}. ${h.title}`), el('small', null, `${done} de ${live.length}`)),
          el('span', { class: 'avance-bar' }, el('i', { style: `width:${(100 * done) / (live.length || 1)}%;background:${C.ok}` })),
          el('ol', { class: 'avance-chain' }, ...h.steps.map((s) => el('li', {
            class: `is-${s.state}${s.blocks ? ' is-blocking' : ''}${s.waitsFor ? ' is-waiting' : ''}${mine.has(s.lane) ? ' is-mine' : ''}${passEx(s, 'hito') ? '' : ' is-filtered'}`,
            title: `${s.paso ?? '·'}. ${s.title} (${agentName(s.lane)})${s.blocks ? ' · bloquea' : ''}${s.waitsFor ? ' · en espera' : ''}` },
            s.state === 'hecho' ? '✔' : String(s.paso ?? '·'), s.prio === 'urgente' ? el('span', { class: 'star' }, '★') : null,
            s.blocks ? el('small', { class: 'blk' }, 'bloquea') : null))));
      }),
    ];
  }

  function paint(): void {
    const all = counts(cards);
    const scope = (cards.length - all.backlog) || 1;
    const shown = cards.filter((c) => passEx(c, null));
    const lanesKeys = AGENTS.map(([k]) => k).filter((k) => cards.some((c) => c.lane === k)).concat([...new Set(cards.map((c) => c.lane))].filter((k) => !AGENT_NAME.has(k)));
    const maxN = Math.max(1, ...lanesKeys.map((k) => cards.filter((c) => c.lane === k).length));
    const nE: Record<string, number> = {}, nP: Record<string, number> = {}, nT: Record<string, number> = {}, tP: Record<string, number> = {}, tT: Record<string, number> = {};
    for (const c of cards) {
      const p = c.prio ?? 'sin', t = c.tipo ?? 'sin';
      tP[p] = (tP[p] ?? 0) + 1; tT[t] = (tT[t] ?? 0) + 1;
      if (passEx(c, 'est')) nE[c.state] = (nE[c.state] ?? 0) + 1;
      if (passEx(c, 'pr')) nP[p] = (nP[p] ?? 0) + 1;
      if (passEx(c, 'tipo')) nT[t] = (nT[t] ?? 0) + 1;
    }
    const toDo = cards.filter((c) => c.state !== 'hecho' && c.state !== 'backlog').length;
    const row = (agents: Array<[string, string]>) => el('div', { class: 'avance-discs-row' }, ...agents.filter(([k]) => lanesKeys.includes(k)).map(([k]) => disc(k, maxN)));
    replace(head,
      el('p', { class: 'avance-updated muted small' }, `Actualizado a las ${hhmm(updatedAt)}`),
      el('div', { class: 'avance-total', role: 'button', tabindex: '0', 'aria-expanded': String(chartOpen), 'aria-label': 'Estado del proyecto (toca para ver el gráfico)',
        onclick: () => { chartOpen = !chartOpen; paint(); }, onkeydown: onActivate(() => { chartOpen = !chartOpen; paint(); }) },
        el('div', { class: 'gl' }, el('b', null, `${Math.round((100 * all.hecho) / scope)}%`), el('span', { class: 'gt' }, `${all.hecho} hechas de ${scope}`),
          el('span', { class: 'gc' }, ...STATES.map(([k, color, label, glyph]) => el('em', { style: `color:${color}`, title: label }, glyph, el('u', null, String(all[k])))))),
        anyFilter() ? el('div', { class: 'gv muted small' }, `${shown.length} visibles de ${toDo} por hacer de ${cards.length}`) : null,
        bar(all, cards.length), chartOpen ? chart() : null),
      el('div', { class: 'avance-discs', 'aria-label': 'Resumen por agente' }, row(ROW1), row(ROW2),
        ...(lanesKeys.some((k) => !AGENT_NAME.has(k)) ? [el('div', { class: 'avance-discs-row' }, ...lanesKeys.filter((k) => !AGENT_NAME.has(k)).map((k) => disc(k, maxN)))] : [])),
      // Con un solo agente elegido, su ficha en Central.
      filters.ag.length === 1 && agentIds.get(filters.ag[0]!) ? el('p', { class: 'avance-agent-link small' },
        el('a', { href: `https://central.ikisai.com/#/accesos/agentes?agente=${encodeURIComponent(agentIds.get(filters.ag[0]!)!)}`, target: '_blank', rel: 'noopener' },
          `Ficha de ${agentName(filters.ag[0]!)} en Central ↗`)) : null,
      el('div', { class: 'avance-filters' },
        el('div', { class: 'fgrp' }, el('small', { class: 'fl' }, 'Estado'), el('div', { class: 'frow', role: 'group', 'aria-label': 'Filtrar por estado' },
          ...STATES.map(([k, color, label, glyph]) => chip('est', k, color, label, glyph, nE[k] ?? 0, all[k])))),
        el('div', { class: 'fgrp' }, el('small', { class: 'fl' }, 'Urgencia'), el('div', { class: 'frow', role: 'group', 'aria-label': 'Filtrar por urgencia' },
          ...PRIOS.map(([k, label, color, glyph]) => chip('pr', k, color, label, glyph, nP[k] ?? 0, tP[k] ?? 0)))),
        el('div', { class: 'fgrp' }, el('small', { class: 'fl' }, 'Oficio'), el('div', { class: 'frow', role: 'group', 'aria-label': 'Filtrar por oficio' },
          ...TIPOS.map(([k, label, glyph, color]) => chip('tipo', k, color, label, glyph, nT[k] ?? 0, tT[k] ?? 0))))));
    replace(hitosHost, ...hitosEl());

    // Orden del carril: urgencia → listas antes que «en espera» → hito y paso → orden.
    const hitoOrden = (c: Card) => hitoOf(c.hito)?.orden ?? 9999;
    const sorted = [...shown].sort((a, b) => (a.state === 'backlog' ? 9 : PRIO_RANK[a.prio ?? ''] ?? 5) - (b.state === 'backlog' ? 9 : PRIO_RANK[b.prio ?? ''] ?? 5)
      || Number(!!a.waitsFor) - Number(!!b.waitsFor) || hitoOrden(a) - hitoOrden(b) || (a.paso ?? 0) - (b.paso ?? 0) || a.order - b.order);
    // En los carriles van también las bloqueadas por fuera que no pasan el filtro (van plegadas).
    const laneItems = [...sorted, ...cards.filter((c) => outside(c) && !passEx(c, null))];
    const visibleLanes = lanesKeys.filter((k) => laneItems.some((c) => c.lane === k));
    const lanesData = groupLanes(laneItems, {
      key: (c) => c.lane, order: visibleLanes, hideEmpty: true, title: (k) => agentName(k), emptyText: 'Nada.',
      mount: (body, items) => {
        // Arriba, las que pasan los filtros y no están bloqueadas por fuera. Plegadas al final, todas las abiertas del carril
        // (pasen o no el filtro) cuyo bloqueador no pasa los filtros: cuanto más estrecho el filtro, más plegadas (VG, 27-10).
        const pending = items.filter((c) => c.state !== 'hecho' && passEx(c, null) && !outside(c));
        const blocked = items.filter(outside);
        replace(body, el('p', { class: 'muted small' }, `${pending.filter((c) => c.state !== 'backlog' && !c.waitsFor).length} por hacer`),
          ...pending.map(cardEl),
          ...items.filter((c) => c.state === 'hecho' && passEx(c, null)).map(cardEl),
          blocked.length ? el('details', { class: 'avance-blocked', 'data-feedback-id': 'flow.avance.bloqueadas' },
            el('summary', null, `Bloqueadas (${blocked.length})`), ...blocked.map(cardEl)) : null);
      },
    });
    if (!lanes) {
      lanes = createLanes({ label: 'Carriles del Avance', storageKey: 'flow-avance-vista', lanes: lanesData, feedbackId: 'flow.avance.carriles' });
      host.append(lanes.element);
    } else {
      lanes.setLanes(lanesData);
      lanes.refresh();
    }
    // Con filtros, el carril elegido puede quedar fuera: se elige el del agente tocado o el primero que se ve.
    const sel = lanes.selected();
    const want = filters.ag.length === 1 && visibleLanes.includes(filters.ag[0]!) ? filters.ag[0]! : sel && visibleLanes.includes(sel) ? sel : visibleLanes[0];
    if (want && want !== sel) lanes.select(want);
  }

  function load(units: BoardUnit[]): void {
    const board = units.filter((u) => u.column_key === 'avance' && !u.deleted_at);
    const hitoUnits = board.filter((u) => u.class === 'objective');
    const cardUnits = board.filter((u) => u.kind === 'card' || u.kind === 'recurring');
    updatedAt = new Date().toISOString(); // la hora del último cambio recibido (VG, 27-10), no la de la fila
    cards = cardUnits.map((u) => {
      const p = u.payload ?? {};
      return { id: u.id, lane: u.lane_key ?? '', title: u.label ?? '', state: stateOf(u), recurring: u.kind === 'recurring', prio: u.kind === 'recurring' ? null : u.prio,
        tipo: p.tipo ?? null, order: u.idx ?? 0, ref: p.ref ?? null, url: typeof p.url === 'string' && /^https:\/\//.test(p.url) ? p.url : null, urlText: p.url_text ?? null,
        steps: Array.isArray(p.steps) ? p.steps : [], note: p.note ?? null, hito: u.parent_id ?? null, paso: typeof p.paso === 'number' ? p.paso : null, unit: u,
        waitsFor: null, waitsAll: [], blocks: false } as Card;
    });
    // Hitos numerados por su orden (número fijo aunque se filtre); el primer paso sin hacer bloquea, los de detrás esperan.
    hitos = hitoUnits.sort((a, b) => (a.payload?.orden ?? 0) - (b.payload?.orden ?? 0)).map((u, i) => {
      const steps = cards.filter((c) => c.hito === u.id).sort((a, b) => (a.paso ?? 0) - (b.paso ?? 0) || a.order - b.order);
      const live = steps.filter((s) => s.state !== 'backlog');
      // Una tarjeta está «para hacer» solo si todos los pasos anteriores de su hito (sin backlog) están hechos (VG, 27-10);
      // los pasos con el mismo número no se bloquean entre sí. Bloquean los pendientes del paso más bajo.
      const open = live.filter((s) => s.state !== 'hecho');
      const minPaso = open.length ? Math.min(...open.map((s) => s.paso ?? 0)) : null;
      for (const s of open) {
        if ((s.paso ?? 0) === minPaso) s.blocks = true;
        else { s.waitsAll = open.filter((b) => (b.paso ?? 0) < (s.paso ?? 0)); s.waitsFor = s.waitsAll[0] ?? null; }
      }
      return { id: u.id, title: u.label ?? '', orden: u.payload?.orden ?? i + 1, doneAt: u.done_at ?? null, steps, number: i + 1 };
    });
  }

  const off = watchData(client, (d) => { load(d.units as unknown as BoardUnit[]); paint(); }, projectId ?? undefined);
  const offHistory = client.onTable(TABLES.boardHistory, () => void loadHistory());
  async function loadHistory(): Promise<void> {
    try { history = ((await client.list(TABLES.boardHistory)) as unknown as Snap[]).filter((s) => s.project_id === projectId && !s.deleted_at); }
    catch { history = []; }
    paint();
  }
  void loadHistory();
  return () => { off(); offHistory(); lanes?.destroy(); };
};
