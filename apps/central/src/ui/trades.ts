import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, icon, openSheet, renderLevelStar, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { AVAILABILITY_LABELS, TRADE_LEVEL_LABELS, TRADE_MAX_DEPTH, canSeeReserved, planTradeImport, validateOperations, type ActionLabel } from '@ikisai/domain-central';
import { T, describeError, type Mirror } from '../app/client.ts';
import type { Person } from './people.ts';
import type { ViewMount } from './shell.ts';
import { fbMark } from './feedback.ts';

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
export const mountTrades: ViewMount = ({ main, client, navigate, isAdmin }) => {
  const canManage = canSeeReserved(client.bootstrap()?.membership);
  let trades: Trade[] = [];
  let capabilities: PersonTrade[] = [];
  let people: Person[] = [];
  let showArchived = false;
  const host = el('div', { id: 'tradeList', 'data-feedback-id': 'central.oficios.lista', 'data-feedback-label': 'Lista de oficios' });
  replace(main,
    el('a', { href: '#/personas', class: 'backlink', 'data-feedback-id': 'central.oficios.volver', 'data-feedback-label': 'Volver a Personas' }, '← Personas'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.oficios.cabecera', 'data-feedback-label': 'Cabecera de Oficios' }, el('div', null, el('h2', null, 'Oficios'),
      el('p', null, 'Qué sabe hacer cada persona: fontanería, electricidad, pintura… Toca un oficio para ver quién sabe hacerlo.'))),
    el('div', { class: 'toolbar', 'data-feedback-id': 'central.oficios.barra', 'data-feedback-label': 'Barra de oficios' },
      el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'tradesArchived', 'data-feedback-id': 'central.oficios.mostrar_archivados', 'data-feedback-label': 'Mostrar archivados',
        onchange: (e: Event) => { showArchived = (e.target as HTMLInputElement).checked; paint(); } }), el('span', null, 'Mostrar archivados')),
      isAdmin ? el('button', { class: 'ghost', type: 'button', id: 'importTrades', 'data-feedback-id': 'central.oficios.importar', 'data-feedback-label': 'Importar de Tasks', onclick: () => void openImport() }, icon('download', 16), 'Importar de Tasks') : null),
    host,
    canManage ? el('button', { class: 'fab', type: 'button', id: 'newTrade', 'data-feedback-id': 'central.oficios.nuevo', 'data-feedback-label': 'Nuevo oficio', onclick: () => openEditor(null) }, icon('plus'), 'Nuevo oficio') : null);

  const whoKnows = (id: string) => capabilities.filter((c) => c.trade_id === id && people.some((p) => p.id === c.person_id && !p.deleted_at));

  function paint(): void {
    const tree = tradeTree(trades, showArchived);
    if (!tree.length) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.oficios.vacio', 'data-feedback-label': 'Sin oficios' }, el('strong', null, 'Todavía no hay oficios'),
        canManage ? 'Crea el primero con «Nuevo oficio».' : 'Los crea quien gestiona personas.'));
      return;
    }
    replace(host, el('ul', { class: 'accounts tradetree', 'aria-label': 'Oficios', 'data-feedback-id': 'central.oficios.lista.filas', 'data-feedback-label': 'Oficios' },
      ...tree.map(({ trade: t, depth }) => {
        const n = whoKnows(t.id).length;
        return el('li', null, el('button', { class: 'personrow traderow', type: 'button', 'data-trade': t.id, style: `padding-left:${12 + depth * 20}px`, 'data-feedback-id': 'central.oficios.lista.fila', 'data-feedback-label': 'Oficio', onclick: () => openTrade(t) },
          el('span', { class: 'accountname' }, t.name),
          el('span', { class: 'muted accountmeta' }, n === 1 ? '1 persona' : `${n} personas`),
          t.active ? null : el('span', { class: 'chips' }, el('span', { class: 'chip' }, 'Archivado'))));
      })));
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
    const name = el('input', { id: 'tr-name', type: 'text', maxlength: '80', required: true, value: t?.name ?? '' }) as HTMLInputElement;
    const parent = el('select', { id: 'tr-parent' }, ...parentOptions(t)) as HTMLSelectElement;
    if (parentId) parent.value = parentId;
    const notes = el('textarea', { id: 'tr-notes', rows: '2', maxlength: '500' }) as HTMLTextAreaElement;
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
    const caps = whoKnows(t.id).map((c) => ({ c, p: people.find((p) => p.id === c.person_id)! }))
      .sort((a, b) => (b.c.level - a.c.level) || a.p.display_name.localeCompare(b.p.display_name, 'es'));
    const hasChildren = trades.some((x) => !x.deleted_at && x.parent_id === t.id);
    const actions = canManage ? el('div', { class: 'zone', 'data-feedback-id': 'central.oficios.ficha.acciones', 'data-feedback-label': 'Acciones del oficio' },
      el('button', { class: 'ghost', type: 'button', id: 'editTrade', 'data-feedback-id': 'central.oficios.ficha.editar', 'data-feedback-label': 'Editar oficio', onclick: () => { void sheet?.close(); openEditor(t); } }, icon('edit', 16), 'Editar'),
      t.active ? el('button', { class: 'ghost', type: 'button', id: 'addSubtrade', 'data-feedback-id': 'central.oficios.ficha.anadir_dentro', 'data-feedback-label': 'Añadir dentro', onclick: () => { void sheet?.close(); openEditor(null, t.id); } }, icon('plus', 16), 'Añadir dentro') : null,
      el('button', { class: 'ghost', type: 'button', id: 'archiveTrade', 'data-feedback-id': 'central.oficios.ficha.archivar', 'data-feedback-label': 'Archivar o reactivar', onclick: async () => {
        if (await commitTrades(client, [{ op: 'update', table: T.trades, id: t.id, expectedRevision: t.revision, fields: { active: !t.active } }], t.active ? 'Oficio archivado.' : 'Oficio reactivado.')) await sheet?.close(true);
      } }, t.active ? 'Archivar' : 'Reactivar'),
      !hasChildren && !caps.length ? el('button', { class: 'danger', type: 'button', id: 'deleteTrade', 'data-feedback-id': 'central.oficios.ficha.papelera', 'data-feedback-label': 'Enviar a la papelera', onclick: async () => {
        if (!(await confirmDialog({ title: `¿Enviar «${t.name}» a la papelera?`, text: 'Nadie lo tiene como capacidad. Se puede restaurar.', confirmLabel: 'Enviar a papelera', danger: true }))) return;
        if (await commitTrades(client, [{ op: 'delete', table: T.trades, id: t.id, expectedRevision: t.revision }], 'Oficio en la papelera.')) await sheet?.close(true);
      } }, 'Papelera') : null) : null;
    sheet = openSheet({
      title: path,
      body: el('div', { id: 'tradeSheet', 'data-feedback-id': 'central.oficios.ficha', 'data-feedback-label': 'Ficha del oficio' },
        t.notes ? el('p', { class: 'muted' }, t.notes) : null,
        el('div', { class: 'sectionlabel', 'data-feedback-id': 'central.oficios.ficha.quien', 'data-feedback-label': 'Quién sabe hacerlo' }, 'Quién sabe hacerlo'),
        caps.length ? el('ul', { class: 'accounts', id: 'tradePeople' }, ...caps.map(({ c, p }) => el('li', null,
          el('button', { class: 'personrow', type: 'button', 'data-person': p.id, 'data-feedback-id': 'central.oficios.ficha.persona', 'data-feedback-label': 'Persona que sabe hacerlo', onclick: () => { void sheet?.close(); navigate(`#/personas/${p.id}`); } },
            el('span', { class: 'accountname' }, levelStar(c.level), ' ', el('span', { 'data-feedback-ignore': '' }, p.display_name)),
            el('span', { class: 'muted accountmeta' }, [levelLabel(c.level), AVAILABILITY_LABELS[p.availability as keyof typeof AVAILABILITY_LABELS], p.active ? '' : 'inactiva'].filter(Boolean).join(' · ')),
            c.note ? el('span', { class: 'muted small', 'data-feedback-ignore': '' }, c.note) : null))))
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
