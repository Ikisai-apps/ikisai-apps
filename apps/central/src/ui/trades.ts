import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, icon, openSheet, renderGroups, renderLevelStar, replace, toast, type Sheet } from '@ikisai/ui-kit';

/** El oficio principal de una ruta («Mantenimiento › Fontanería» → «Mantenimiento»). */
const path0 = (path: string) => path.split(' › ')[0]!;
import {
  AVAILABILITY_LABELS, TRADE_LEVEL_LABELS, TRADE_MAX_DEPTH, canSeeReserved, effectiveLevels, inheritedLevel, planTradeImport, validateOperations, type ActionLabel, type EffectiveLevel,
} from '@ikisai/domain-central';
import { T, describeError, type Mirror } from '../app/client.ts';
import type { Person } from './people.ts';
import type { ViewMount } from './shell.ts';
import { fbMark } from './feedback.ts';

export { effectiveLevels, inheritedLevel };

type Base = { id: string; revision: number; updated_at: string; deleted_at: string | null };
export type Trade = Mirror<Base & { parent_id: string | null; name: string; position: number; active: boolean; notes: string | null; source_label_id: string | null }>;
export type PersonTrade = Mirror<Base & { person_id: string; trade_id: string; level: number; note: string | null }>;

/** Árbol de oficios aplanado en orden (madre antes que hijas), con su profundidad (0 = raíz) y su ruta «Fontanería › ACS». */
export function tradeTree(trades: Trade[], includeInactive = false): Array<{ trade: Trade; depth: number; path: string }> {
  const alive = trades.filter((t) => !t.deleted_at && (includeInactive || t.active));
  const ids = new Set(alive.map((t) => t.id));
  const byParent = new Map<string, Trade[]>();
  for (const t of alive) {
    const key = t.parent_id && ids.has(t.parent_id) ? t.parent_id : '';
    byParent.set(key, [...(byParent.get(key) ?? []), t]);
  }
  const out: Array<{ trade: Trade; depth: number; path: string }> = [];
  const walk = (parent: string, depth: number, prefix: string) => {
    for (const t of (byParent.get(parent) ?? []).sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name, 'es'))) {
      const path = prefix ? `${prefix} › ${t.name}` : t.name;
      out.push({ trade: t, depth, path });
      if (depth < TRADE_MAX_DEPTH) walk(t.id, depth + 1, path);
    }
  };
  walk('', 0, '');
  return out;
}

/** El oficio y todos los que cuelgan de él (filtrar por «Fontanería» incluye «ACS»). */
export function tradeWithDescendants(trades: Trade[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of trades) if (!t.deleted_at && t.parent_id && out.has(t.parent_id) && !out.has(t.id)) { out.add(t.id); grew = true; }
  }
  return out;
}

/** Cobertura de un oficio (R7, con la herencia de la 1510): personas del directorio por su grado efectivo en él. */
export interface TradeCoverage { learners: number; knows: number; experts: number; atRisk: boolean; noExpert: boolean; onlyOutsiders: boolean }

/**
 * Misma regla que los indicadores de la migración 1510: directorio (activas, sin fusionar y con nivel de casa), oficios
 * activos y grado efectivo (lo del padre cuenta en los hijos; lo de un hijo no sube al padre). Capaz es Sabe o Experto. En
 * riesgo: una persona capaz o ninguna.
 */
export function tradeCoverage(trades: Trade[], capabilities: PersonTrade[], people: Person[]): Map<string, TradeCoverage> {
  const directory = new Map(people.filter((p) => !p.deleted_at && p.active && !p.merged_into && p.house_level).map((p) => [p.id, p]));
  const active = new Map(trades.filter((t) => !t.deleted_at && t.active).map((t) => [t.id, t]));
  const best = new Map<string, Map<string, number>>();
  for (const [person, levels] of effectiveLevels(trades, capabilities)) {
    if (!directory.has(person)) continue;
    for (const [trade, e] of levels) {
      const m = best.get(trade) ?? new Map<string, number>();
      m.set(person, e.level);
      best.set(trade, m);
    }
  }
  const out = new Map<string, TradeCoverage>();
  for (const id of active.keys()) {
    const levels = [...(best.get(id) ?? new Map<string, number>())];
    const capable = levels.filter(([, l]) => l >= 1);
    const learners = levels.filter(([, l]) => l === 0).length;
    const experts = levels.filter(([, l]) => l === 2).length;
    out.set(id, { learners, knows: capable.length - experts, experts, atRisk: capable.length <= 1, noExpert: learners > 0 && experts === 0,
      onlyOutsiders: capable.length > 0 && capable.every(([p]) => directory.get(p)!.house_level === 'outsider') });
  }
  return out;
}

const count = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
/** «1 aprende · 2 saben · 1 experto»; vacío si nadie del directorio sabe hacerlo. */
export const coverageText = (c: TradeCoverage) => [count(c.learners, 'aprende', 'aprenden'), count(c.knows, 'sabe', 'saben'), count(c.experts, 'experto', 'expertos')].filter(Boolean).join(' · ');

export const levelLabel = (level: number) => TRADE_LEVEL_LABELS[level as 0 | 1 | 2] ?? String(level);
/** Estrella de solo lectura con el nivel de una capacidad. */
export const levelStar = (level: number) => renderLevelStar(level, 3, `Nivel: ${levelLabel(level)}`);

export async function loadTrades(client: SyncClient): Promise<{ trades: Trade[]; capabilities: PersonTrade[] }> {
  const [trades, capabilities] = await Promise.all([client.list(T.trades, { includeDeleted: true }), client.list(T.personTrades)]);
  return { trades: trades as unknown as Trade[], capabilities: (capabilities as unknown as PersonTrade[]).filter((c) => !c.deleted_at) };
}

async function commitTrades(client: SyncClient, operations: RowOperation[], ok: string): Promise<boolean> {
  const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' });
  if (issue) { toast(issue.message); return false; }
  try {
    await client.commit(operations);
    toast(!navigator.onLine ? `${ok} Se sincronizará cuando haya red.` : ok);
    return true;
  } catch (e) { toast(describeError(e)); return false; }
}

/**
 * Oficios (fase P1, RECURSOS.md §13.3): catálogo en árbol de hasta tres niveles y, en cada oficio, quién sabe hacerlo con su
 * nivel (estrella) y su disponibilidad. Lo gestionan el owner y el editor con ámbito `people`; el resto lo ve.
 */
/** Sin tildes ni mayúsculas, para buscar. */
const fold = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Barra de cobertura (076): Experto, Sabe y Aprende, sobre un mínimo de dos capaces; la raya marca ese mínimo. */
function coverageBar(c: TradeCoverage): HTMLElement {
  const total = Math.max(4, c.experts + c.knows + c.learners);
  const seg = (n: number, kind: string) => (n ? el('span', { class: `ctl-cov ${kind}`, style: `width:${(n / total) * 100}%` }) : null);
  return el('span', { class: 'ctl-covbar', 'aria-hidden': 'true' }, seg(c.experts, 'experto'), seg(c.knows, 'sabe'), seg(c.learners, 'aprende'),
    el('span', { class: 'ctl-covmin', style: `left:${(2 / total) * 100}%` }));
}

export const mountTrades: ViewMount = ({ main, client, navigate, isAdmin }) => {
  const canManage = canSeeReserved(client.bootstrap()?.membership);
  let trades: Trade[] = [];
  let capabilities: PersonTrade[] = [];
  let people: Person[] = [];
  let showArchived = false;
  let query = '';
  // Chips (Bloque 2, MUELA-076): En riesgo (`?riesgo`, como hasta ahora: una persona capaz o ninguna, o solo outsiders),
  // Sin experto (`?sinexperto`) y Solo outsiders (`?outsiders`). Desde el panel se llega con el filtro puesto.
  type Flag = 'riesgo' | 'sinexperto' | 'outsiders';
  const linked = location.hash.split('?')[1] ?? '';
  let flag: Flag | null = linked === 'riesgo' || linked === 'sinexperto' || linked === 'outsiders' ? linked : null;
  const host = el('div', { id: 'tradeList', 'data-feedback-id': 'central.oficios.lista', 'data-feedback-label': 'Lista de oficios' });
  const flagChip = (value: Flag, id: string, label: string) => el('button', { type: 'button', class: 'filterchip', id, 'aria-pressed': String(flag === value), dataset: { flag: value },
    'data-feedback-id': 'central.oficios.filtro', 'data-feedback-label': 'Filtro de oficios', onclick: () => { flag = flag === value ? null : value; paint(); } }, label);
  const riskBox = el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'Cobertura', id: 'tradesChips', hidden: true },
    flagChip('riesgo', 'tradesRisk', 'En riesgo'), flagChip('sinexperto', 'tradesNoExpert', 'Sin experto'), flagChip('outsiders', 'tradesOutsiders', 'Solo outsiders'));
  const search = el('input', { type: 'search', id: 'tradesSearch', placeholder: 'Buscar oficio', 'aria-label': 'Buscar oficio', 'data-feedback-id': 'central.oficios.buscar', 'data-feedback-label': 'Buscar oficio',
    oninput: (e: Event) => { query = fold((e.target as HTMLInputElement).value.trim()); paint(); } });
  replace(main,
    el('a', { href: '#/personas', class: 'backlink', 'data-feedback-id': 'central.oficios.volver', 'data-feedback-label': 'Volver a Personas' }, '← Personas'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.oficios.cabecera', 'data-feedback-label': 'Cabecera de Oficios' }, el('div', null, el('h2', null, 'Oficios'),
      el('p', null, 'Qué sabe hacer cada persona: fontanería, electricidad, pintura… Toca un oficio para ver quién sabe hacerlo.'))),
    el('div', { class: 'ctl-searchrow' }, search),
    riskBox,
    el('div', { class: 'toolbar', 'data-feedback-id': 'central.oficios.barra', 'data-feedback-label': 'Barra de oficios' },
      el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'tradesArchived', 'data-feedback-id': 'central.oficios.mostrar_archivados', 'data-feedback-label': 'Mostrar archivados',
        onchange: (e: Event) => { showArchived = (e.target as HTMLInputElement).checked; paint(); } }), el('span', null, 'Mostrar archivados')),
      isAdmin ? el('button', { class: 'ghost', type: 'button', id: 'importTrades', 'data-feedback-id': 'central.oficios.importar', 'data-feedback-label': 'Importar de Tasks', onclick: () => void openImport() }, icon('download', 16), 'Importar de Tasks') : null),
    host,
    canManage ? el('button', { class: 'fab', type: 'button', id: 'newTrade', 'data-feedback-id': 'central.oficios.nuevo', 'data-feedback-label': 'Nuevo oficio', onclick: () => openEditor(null) }, icon('plus'), 'Nuevo oficio') : null);

  /** Capacidades puestas en el oficio (las que impiden mandarlo a la papelera). */
  const direct = (id: string) => capabilities.filter((c) => c.trade_id === id && people.some((p) => p.id === c.person_id && !p.deleted_at));
  /** Quién sabe hacerlo: lo puesto y lo heredado de un antepasado (1510). En un oficio archivado, solo lo puesto. */
  const whoKnows = (id: string, levels: Map<string, Map<string, EffectiveLevel>>): Array<{ person: Person; level: number; from: string | null; note: string | null }> => {
    const notes = new Map(direct(id).map((c) => [c.person_id, c]));
    return people.filter((p) => !p.deleted_at).flatMap((p) => {
      const e = levels.get(p.id)?.get(id);
      if (e) return [{ person: p, level: e.level, from: e.inherited ? e.from : null, note: notes.get(p.id)?.note ?? null }];
      const c = notes.get(p.id);
      return c ? [{ person: p, level: c.level, from: null, note: c.note }] : [];
    });
  };

  function paint(): void {
    // Sin niveles de casa (P1 sin aplicar) no hay directorio: la lista queda como antes de R7.
    const levelsOn = people.some((p) => p.house_level);
    riskBox.hidden = !levelsOn;
    const cov = levelsOn ? tradeCoverage(trades, capabilities, people) : new Map<string, TradeCoverage>();
    const levels = effectiveLevels(trades, capabilities);
    const flagged = (t: Trade) => {
      const c = cov.get(t.id);
      if (!c) return false;
      return flag === 'riesgo' ? c.atRisk || c.onlyOutsiders : flag === 'sinexperto' ? c.noExpert : c.onlyOutsiders;
    };
    for (const b of riskBox.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.flag === flag));
    const byFlag = levelsOn && flag !== null;
    const filtering = byFlag || !!query;
    const tree = tradeTree(trades, showArchived).filter((x) => (!byFlag || flagged(x.trade)) && (!query || fold(x.path).includes(query)));
    if (byFlag && !tree.length) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.oficios.sin_riesgo', 'data-feedback-label': 'Ningún oficio en riesgo' },
        el('strong', null, flag === 'riesgo' ? 'Ningún oficio en riesgo' : flag === 'sinexperto' ? 'Todos los oficios tienen experto' : 'Ningún oficio solo con outsiders'),
        flag === 'riesgo' ? 'Todos tienen al menos dos personas capaces y alguna de la casa.' : ''));
      return;
    }
    if (query && !tree.length) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.oficios.sin_resultados', 'data-feedback-label': 'Ningún oficio coincide' }, el('strong', null, 'Ningún oficio coincide'), 'Cambia la búsqueda.'));
      return;
    }
    if (!tree.length) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.oficios.vacio', 'data-feedback-label': 'Sin oficios' }, el('strong', null, 'Todavía no hay oficios'),
        canManage ? 'Crea el primero con «Nuevo oficio».' : 'Los crea quien gestiona personas.'));
      return;
    }
    const row = ({ trade: t, depth, path }: (typeof tree)[number]) => {
      const n = whoKnows(t.id, levels).length;
      const c = t.active ? cov.get(t.id) : undefined;
      const flags = c ? [c.atRisk ? el('span', { class: 'chip alert' }, 'En riesgo') : null, c.noExpert ? el('span', { class: 'chip warn' }, 'Sin experto') : null,
        c.onlyOutsiders ? el('span', { class: 'chip warn' }, 'Solo outsiders') : null].filter(Boolean) : [];
      // Filtrando, cada fila va suelta: la ruta completa dice de dónde cuelga.
      return el('li', null, el('button', { class: 'personrow traderow', type: 'button', 'data-trade': t.id, style: `padding-left:${12 + (filtering ? 0 : depth) * 20}px`, 'data-feedback-id': 'central.oficios.lista.fila', 'data-feedback-label': 'Oficio', onclick: () => openTrade(t) },
        el('span', { class: 'accountname' }, filtering ? path : t.name),
        el('span', { class: 'muted accountmeta' }, n === 1 ? '1 persona' : `${n} personas`),
        c ? coverageBar(c) : null,
        c && coverageText(c) ? el('span', { class: 'muted small tradecoverage', 'data-feedback-id': 'central.oficios.lista.cobertura', 'data-feedback-label': 'Cobertura por nivel' }, coverageText(c)) : null,
        flags.length ? el('span', { class: 'chips tradeflags', 'data-feedback-id': 'central.oficios.lista.avisos', 'data-feedback-label': 'Avisos de cobertura' }, ...flags) : null,
        t.active ? null : el('span', { class: 'chips' }, el('span', { class: 'chip' }, 'Archivado'))));
    };
    // Bloque 2 (VG): un grupo por oficio principal con el resumen de lo peor, y el árbol (con su sangría) dentro.
    const groups: Array<{ key: string; title: string; items: typeof tree }> = [];
    for (const x of tree) {
      const root = path0(x.path);
      const last = groups[groups.length - 1];
      if (last && last.key === root) last.items.push(x); else groups.push({ key: root, title: root, items: [x] });
    }
    const toneOf = (x: (typeof tree)[number]) => { const c = x.trade.active ? cov.get(x.trade.id) : undefined; return !c ? null : c.atRisk ? 'alert' as const : c.noExpert || c.onlyOutsiders ? 'warn' as const : levelsOn ? 'ok' as const : null; };
    const view = renderGroups({
      label: 'Oficios', feedbackId: 'central.oficios.lista.grupos',
      groups: groups.map((g) => {
        const risk = g.items.filter((x) => toneOf(x) === 'alert').length;
        const warn = g.items.filter((x) => toneOf(x) === 'warn').length;
        return { key: g.key, title: g.title, items: g.items, open: filtering || undefined,
          summary: levelsOn ? [risk ? `${risk} en riesgo` : '', warn ? `${warn} con aviso` : ''].filter(Boolean).join(' · ') || 'cubiertos' : `${g.items.length} ${g.items.length === 1 ? 'oficio' : 'oficios'}` };
      }),
      toneOf, row,
    });
    replace(host, el('div', { class: 'accounts tradetree', 'aria-label': 'Oficios', 'data-feedback-id': 'central.oficios.lista.filas', 'data-feedback-label': 'Oficios' }, view.element));
  }

  /** Madres posibles: no él mismo ni sus descendientes, y sin pasar de tres niveles contando lo que cuelga de él. */
  function parentOptions(t: Trade | null): HTMLElement[] {
    const tree = tradeTree(trades, true);
    const own = t ? tradeWithDescendants(trades, t.id) : new Set<string>();
    const height = t ? Math.max(0, ...tree.filter((x) => own.has(x.trade.id)).map((x) => x.depth)) - (tree.find((x) => x.trade.id === t.id)?.depth ?? 0) : 0;
    return [el('option', { value: '', selected: !t?.parent_id }, 'Ninguna (oficio principal)'),
      ...tree.filter((x) => !own.has(x.trade.id) && x.depth + 1 + height < TRADE_MAX_DEPTH)
        .map((x) => el('option', { value: x.trade.id, selected: t?.parent_id === x.trade.id }, x.path))];
  }

  function openEditor(t: Trade | null, parentId?: string): void {
    let sheet: Sheet | null = null;
    const name = el('input', { id: 'tr-name', 'data-field-id': 'central.oficios.name', type: 'text', maxlength: '80', required: true, value: t?.name ?? '' }) as HTMLInputElement;
    const parent = el('select', { id: 'tr-parent', 'data-field-id': 'central.oficios.parent' }, ...parentOptions(t)) as HTMLSelectElement;
    if (parentId) parent.value = parentId;
    const notes = el('textarea', { id: 'tr-notes', 'data-field-id': 'central.oficios.notes', rows: '2', maxlength: '500' }) as HTMLTextAreaElement;
    notes.value = t?.notes ?? '';
    const save = el('button', { class: 'primary', type: 'button', id: 'saveTrade', 'data-feedback-id': 'central.oficios.editar.guardar', 'data-feedback-label': 'Guardar', onclick: async () => {
      const fields = { name: name.value.trim(), parent_id: parent.value || null, notes: notes.value.trim() || null };
      if (!fields.name) { toast('Escribe el nombre del oficio.'); name.focus(); return; }
      const ops: RowOperation[] = t ? [{ op: 'update', table: T.trades, id: t.id, expectedRevision: t.revision, fields }]
        : [{ op: 'insert', table: T.trades, id: crypto.randomUUID(), fields: { ...fields, position: Date.now() / 1000 } }];
      if (await commitTrades(client, ops, t ? 'Oficio guardado.' : 'Oficio creado.')) await sheet?.close(true);
    } }, 'Guardar');
    sheet = openSheet({
      title: t ? 'Editar oficio' : 'Nuevo oficio',
      body: el('div', { 'data-feedback-id': 'central.oficios.editar.formulario', 'data-feedback-label': 'Formulario del oficio' },
        el('label', { class: 'field', 'data-feedback-id': 'central.oficios.editar.campo_nombre', 'data-feedback-label': 'Nombre' }, el('span', null, 'Nombre'), name),
        el('label', { class: 'field', 'data-feedback-id': 'central.oficios.editar.campo_madre', 'data-feedback-label': 'Dentro de' }, el('span', null, 'Dentro de'), parent,
          el('span', { class: 'muted small' }, 'Hasta tres niveles: «Fontanería › ACS».')),
        el('label', { class: 'field', 'data-feedback-id': 'central.oficios.editar.campo_notas', 'data-feedback-label': 'Notas' }, el('span', null, 'Notas (opcional)'), notes)),
      panelAttrs: { 'data-feedback-id': 'central.oficios.editar', 'data-feedback-label': 'Editar oficio' },
      closeAttrs: { 'data-feedback-id': 'central.oficios.editar.cerrar', 'data-feedback-label': 'Cerrar' },
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.oficios.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save],
      initialFocus: name,
    });
  }

  function openTrade(t: Trade): void {
    let sheet: Sheet | null = null;
    const path = tradeTree(trades, true).find((x) => x.trade.id === t.id)?.path ?? t.name;
    const paths = new Map(tradeTree(trades, true).map((x) => [x.trade.id, x.path]));
    const caps = whoKnows(t.id, effectiveLevels(trades, capabilities))
      .sort((a, b) => (b.level - a.level) || a.person.display_name.localeCompare(b.person.display_name, 'es'));
    const hasChildren = trades.some((x) => !x.deleted_at && x.parent_id === t.id);
    const actions = canManage ? el('div', { class: 'zone', 'data-feedback-id': 'central.oficios.ficha.acciones', 'data-feedback-label': 'Acciones del oficio' },
      el('button', { class: 'ghost', type: 'button', id: 'editTrade', 'data-feedback-id': 'central.oficios.ficha.editar', 'data-feedback-label': 'Editar oficio', onclick: () => { void sheet?.close(); openEditor(t); } }, icon('edit', 16), 'Editar'),
      t.active ? el('button', { class: 'ghost', type: 'button', id: 'addSubtrade', 'data-feedback-id': 'central.oficios.ficha.anadir_dentro', 'data-feedback-label': 'Añadir dentro', onclick: () => { void sheet?.close(); openEditor(null, t.id); } }, icon('plus', 16), 'Añadir dentro') : null,
      el('button', { class: 'ghost', type: 'button', id: 'archiveTrade', 'data-feedback-id': 'central.oficios.ficha.archivar', 'data-feedback-label': 'Archivar o reactivar', onclick: async () => {
        if (await commitTrades(client, [{ op: 'update', table: T.trades, id: t.id, expectedRevision: t.revision, fields: { active: !t.active } }], t.active ? 'Oficio archivado.' : 'Oficio reactivado.')) await sheet?.close(true);
      } }, t.active ? 'Archivar' : 'Reactivar'),
      !hasChildren && !direct(t.id).length ? el('button', { class: 'danger', type: 'button', id: 'deleteTrade', 'data-feedback-id': 'central.oficios.ficha.papelera', 'data-feedback-label': 'Enviar a la papelera', onclick: async () => {
        if (!(await confirmDialog({ title: `¿Enviar «${t.name}» a la papelera?`, text: 'Nadie lo tiene como capacidad. Se puede restaurar.', confirmLabel: 'Enviar a papelera', danger: true }))) return;
        if (await commitTrades(client, [{ op: 'delete', table: T.trades, id: t.id, expectedRevision: t.revision }], 'Oficio en la papelera.')) await sheet?.close(true);
      } }, 'Papelera') : null) : null;
    sheet = openSheet({
      title: path,
      body: el('div', { id: 'tradeSheet', 'data-feedback-id': 'central.oficios.ficha', 'data-feedback-label': 'Ficha del oficio' },
        t.notes ? el('p', { class: 'muted' }, t.notes) : null,
        el('div', { class: 'sectionlabel', 'data-feedback-id': 'central.oficios.ficha.quien', 'data-feedback-label': 'Quién sabe hacerlo' }, 'Quién sabe hacerlo'),
        caps.length ? el('ul', { class: 'accounts', id: 'tradePeople' }, ...caps.map(({ person: p, level, from, note }) => el('li', null,
          el('button', { class: 'personrow', type: 'button', 'data-person': p.id, ...(from ? { 'data-inherited': '' } : {}), 'data-feedback-id': 'central.oficios.ficha.persona', 'data-feedback-label': 'Persona que sabe hacerlo', onclick: () => { void sheet?.close(); navigate(`#/personas/${p.id}`); } },
            el('span', { class: 'accountname' }, levelStar(level), ' ', el('span', { 'data-feedback-ignore': '' }, p.display_name)),
            el('span', { class: 'muted accountmeta' }, [levelLabel(level), from ? `por ${paths.get(from) ?? ''}` : '', AVAILABILITY_LABELS[p.availability as keyof typeof AVAILABILITY_LABELS], p.active ? '' : 'inactiva'].filter(Boolean).join(' · ')),
            note ? el('span', { class: 'muted small', 'data-feedback-ignore': '' }, note) : null))))
          : el('p', { class: 'muted' }, 'Nadie todavía. Se añade desde la ficha de cada persona.'),
        actions),
      panelAttrs: { 'data-feedback-id': 'central.oficios.ficha.hoja', 'data-feedback-label': 'Oficio' },
      closeAttrs: { 'data-feedback-id': 'central.oficios.ficha.cerrar', 'data-feedback-label': 'Cerrar' },
    });
  }

  /**
   * Importar desde la familia «Tipo: Acción» de Tasks, con vista previa (solo dirección). Las repetidas entre áreas son un solo
   * oficio; lo que ya existe no se duplica; las archivadas en Tasks salen desmarcadas. Las etiquetas de Tasks no se tocan.
   */
  async function openImport(): Promise<void> {
    if (!navigator.onLine) { toast('Importar de Tasks necesita conexión.'); return; }
    let labels: ActionLabel[];
    try { labels = (await client.api<{ rows: ActionLabel[] }>('/read/tasks.action_labels', { method: 'POST', json: { limit: 2000 } })).rows; } catch (e) { toast(describeError(e)); return; }
    const plan = planTradeImport(labels, trades);
    if (!plan.length) { toast('Tasks no tiene etiquetas de «Tipo: Acción».'); return; }
    let sheet: Sheet | null = null;
    const boxes = new Map<string, HTMLInputElement>();
    const rows = plan.map((n) => {
      const box = el('input', { type: 'checkbox', id: `imp-${n.labelIds[0]}`, 'data-key': n.key, checked: !n.existingId && !n.archived, disabled: !!n.existingId }) as HTMLInputElement;
      boxes.set(n.key, box);
      return el('label', { class: 'check importrow', style: `padding-left:${n.depth * 20}px`, 'data-feedback-id': 'central.oficios.importar.fila', 'data-feedback-label': 'Oficio que se importa' }, box,
        el('span', null, n.name),
        n.existingId ? el('span', { class: 'chip' }, 'Ya existe') : null,
        n.archived ? el('span', { class: 'chip' }, 'Archivada en Tasks') : null,
        n.areas > 1 ? el('span', { class: 'chip' }, `En ${n.areas} áreas`) : null);
    });
    // Marcar una hija marca su madre (no puede quedar suelta).
    for (const n of plan) boxes.get(n.key)!.addEventListener('change', () => {
      let parent = n.parentKey;
      while (parent && boxes.get(n.key)!.checked) { const b = boxes.get(parent); if (b && !b.disabled) b.checked = true; parent = plan.find((x) => x.key === parent)?.parentKey ?? null; }
    });
    const apply = el('button', { class: 'primary', type: 'button', id: 'applyImport', 'data-feedback-id': 'central.oficios.importar.aplicar', 'data-feedback-label': 'Importar los marcados', onclick: async () => {
      const ids = new Map<string, string>();
      for (const n of plan) if (n.existingId) ids.set(n.key, n.existingId);
      const ops: RowOperation[] = [];
      for (const n of plan) {
        if (n.existingId || !boxes.get(n.key)!.checked) continue;
        const id = crypto.randomUUID();
        ids.set(n.key, id);
        ops.push({ op: 'insert', table: T.trades, id, fields: { name: n.name, parent_id: n.parentKey ? ids.get(n.parentKey) ?? null : null, position: n.position, source_label_id: n.sourceLabelId } });
      }
      if (!ops.length) { toast('No hay nada marcado para importar.'); return; }
      apply.disabled = true;
      const ok = await commitTrades(client, ops, ops.length === 1 ? '1 oficio importado.' : `${ops.length} oficios importados.`);
      apply.disabled = false;
      if (ok) await sheet?.close(true);
    } }, 'Importar los marcados') as HTMLButtonElement;
    sheet = openSheet({
      title: 'Importar oficios de Tasks',
      body: el('div', { id: 'importPreview', 'data-feedback-id': 'central.oficios.importar.contenido', 'data-feedback-label': 'Vista previa de la importación' },
        el('p', { class: 'muted' }, 'Desde la familia «Tipo: Acción» de Tasks. Las repetidas entre áreas son un solo oficio. Lo que ya existe no se duplica, y las etiquetas de Tasks no cambian.'),
        ...rows),
      panelAttrs: { 'data-feedback-id': 'central.oficios.importar.hoja', 'data-feedback-label': 'Importar oficios' },
      closeAttrs: { 'data-feedback-id': 'central.oficios.importar.cerrar', 'data-feedback-label': 'Cerrar' },
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.oficios.importar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), apply],
    });
  }

  async function load(): Promise<void> {
    ({ trades, capabilities } = await loadTrades(client));
    people = ((await client.list(T.people)) as unknown as Person[]).filter((p) => !p.deleted_at);
    paint();
  }
  void load();
  const offs = [T.trades, T.personTrades, T.people].map((t) => client.onTable(t, () => void load()));
  return () => offs.forEach((off) => off());
};

/** Marca de feedback fija para la estrella editable (el catálogo solo recoge literales). */
export function markLevelStar(node: Element | null): Element | null {
  return fbMark(node, 'central.persona.oficios.nivel', 'Nivel del oficio');
}
