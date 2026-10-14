/**
 * Cola de propuestas (O1, `ampliacion/RECURSOS.md` §14): sugerencias de personas (tareas, platos, «Apuntarme»,
 * feedback) que staff o dirección aprueban o descartan, y la vista «Mis propuestas» de quien propone.
 *
 * ```ts
 * const list = createProposalList({
 *   mode: 'review', source: { list: () => api.suggestions('pending') }, canDecide: role !== 'reader',
 *   kinds: { task: { label: 'Tarea' } },
 *   onApprove: (s, comment) => api.approve(s.id, comment), onReject: (s, comment) => api.reject(s.id, comment),
 *   renderDetail: (s) => taskPreview(s.detail),
 * });
 * ```
 *
 * - Aprobar, descartar y retirar **confirman siempre** con un diálogo; al aprobar o descartar, con un comentario
 *   opcional que verá quien lo propuso. No hay «Deshacer»: un aprobado se deshace desde el historial de la app.
 * - Escritorio (≥ 900 px): lista a la izquierda y detalle a la derecha; ↑ y ↓ cambian de propuesta y, al decidir, pasa
 *   sola a la siguiente pendiente. Móvil: los botones en la tarjeta y el detalle en una hoja.
 * - Con `source`, vuelve a leer al enfocar la ventana y tras cada decisión (o con `subscribe`, si lo da).
 * - No sustituye al revisor de feedback de Central ni a la revisión de propuestas de agentes (`openProposalReview`).
 */
import { el, replace, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { toast } from '../toast.ts';
import { confirmDialog } from '../overlay/dialog.ts';
import { openSheet } from '../overlay/sheet.ts';
import { relativeTime } from '../agents/agents.ts';

/** Estados de una sugerencia del núcleo («sugerencias» en la API, para no chocar con las de agentes). */
export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface ProposalItem {
  id: string;
  app?: string | null;
  /** Tipo propio de la app: 'task', 'dish', 'join', 'feedback'… */
  kind: string;
  /** Qué se propone, en una línea. */
  summary: string;
  /** Libre: lo que la app necesita para pintar el detalle (`renderDetail`). */
  detail?: unknown;
  author: { id: string; name: string };
  created_at: string;
  status: SuggestionStatus;
  comment?: string | null;
  decided_by?: { id?: string; name: string } | null;
  decided_at?: string | null;
  /** Lo creado al aprobar (ids); el enlace lo construye la app con `link`. */
  result?: unknown;
}

export interface ProposalSource {
  list(): Promise<ProposalItem[]>;
  /** Avisa cuando cambian; sin él, se vuelve a leer al enfocar la ventana y tras decidir. */
  subscribe?(listener: (items: ProposalItem[]) => void): () => void;
}

export interface ProposalListOptions {
  /** `review`: para quien decide. `mine`: lo que he propuesto. */
  mode: 'review' | 'mine';
  items?: ProposalItem[];
  source?: ProposalSource;
  /** Nombre visible de cada tipo («Tarea», «Plato», «Apuntarme»). */
  kinds?: Record<string, { label: string; icon?: string }>;
  /** Nombre visible de cada app («Tasks»). */
  apps?: Record<string, string>;
  /** Sin permiso, `review` es solo de lectura. Por defecto, sí si hay `onApprove` u `onReject`. */
  canDecide?: boolean;
  onApprove?: (item: ProposalItem, comment: string | null) => Promise<void> | void;
  onReject?: (item: ProposalItem, comment: string | null) => Promise<void> | void;
  /** «Retirar» una pendiente propia (modo `mine`). */
  onWithdraw?: (item: ProposalItem) => Promise<void> | void;
  /** Botón «Proponer» (modo `mine`). */
  onCreate?: () => void;
  /** Lo que la app enseña de la propuesta (detalle de escritorio y hoja del móvil). */
  renderDetail?: (item: ProposalItem) => Child;
  /** Enlace a lo creado al aprobar («Ver la tarea»). */
  link?: (item: ProposalItem) => { label: string; href: string } | null;
  /** Pestaña inicial en `review`; por defecto, pendientes. */
  status?: 'pending' | 'approved' | 'rejected';
  title?: string;
  emptyText?: string;
  label?: string;
  /** Marca de feedback y uso (`PROPOSAL_LIST_MARKS` para sus partes). */
  feedbackId?: string;
  now?: () => Date;
}

export interface ProposalList {
  element: HTMLElement;
  setItems(items: ProposalItem[]): void;
  refresh(): Promise<void>;
  destroy(): void;
}

/** Marcas de feedback de las partes de la cola (`feedbackId` + sufijo). */
export const PROPOSAL_LIST_MARKS = {
  tab: ['estado', 'Estado de las propuestas'],
  kind: ['tipo', 'Tipo de propuesta'],
  open: ['abrir', 'Ver propuesta'],
  approve: ['aprobar', 'Aprobar propuesta'],
  reject: ['descartar', 'Descartar propuesta'],
  withdraw: ['retirar', 'Retirar propuesta'],
  create: ['proponer', 'Proponer'],
} as const;

const STATUS_TEXT: Record<SuggestionStatus, string> = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Descartada', withdrawn: 'Retirada' };
const STATUS_TONE: Record<SuggestionStatus, string> = { pending: 'pending', approved: 'approved', rejected: 'trash', withdrawn: 'trash' };
const TABS: { status: 'pending' | 'approved' | 'rejected'; label: string }[] = [
  { status: 'pending', label: 'Pendientes' }, { status: 'approved', label: 'Aprobadas' }, { status: 'rejected', label: 'Descartadas' },
];
const WIDE = '(min-width: 900px)';

export function suggestionStatusChip(status: SuggestionStatus): HTMLElement {
  return el('span', { class: `chip status ${STATUS_TONE[status]}`, dataset: { status } }, el('span', null, kt(STATUS_TEXT[status])));
}

export function createProposalList(options: ProposalListOptions): ProposalList {
  const mode = options.mode;
  const now = options.now ?? (() => new Date());
  const canDecide = options.canDecide ?? !!(options.onApprove || options.onReject);
  const base = options.feedbackId;
  const mark = (key: keyof typeof PROPOSAL_LIST_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${PROPOSAL_LIST_MARKS[key][0]}`, 'data-feedback-label': PROPOSAL_LIST_MARKS[key][1] } : {});
  let items: ProposalItem[] = options.items?.slice() ?? [];
  let tab: 'pending' | 'approved' | 'rejected' = options.status ?? 'pending';
  let kindFilter: string | null = null;
  let selected: string | null = null;
  const busy = new Set<string>();

  const kindLabel = (kind: string) => kt(options.kinds?.[kind]?.label ?? kind);
  const appLabel = (app?: string | null) => (app ? options.apps?.[app] ?? app : null);
  const wide = () => typeof matchMedia === 'function' && matchMedia(WIDE).matches;
  const fullDate = (iso: string) => new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

  const head = el('div', { class: 'pl-head' });
  const filters = el('div', { class: 'pl-filters' });
  const list = el('ul', { class: 'pl-list', 'aria-label': options.label ?? kt(mode === 'mine' ? 'Mis propuestas' : 'Propuestas') });
  const detail = mode === 'review' ? el('section', { class: 'pl-detail', 'aria-label': kt('Propuesta elegida'), 'aria-live': 'polite' }) : null;
  const element = el('section', {
    class: `proposals ${mode}`, dataset: { mode },
    ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label ?? kt(mode === 'mine' ? 'Mis propuestas' : 'Propuestas') } : {}),
  }, head, filters, el('div', { class: 'pl-split' }, list, detail));

  // --- Datos -------------------------------------------------------------------------------------------------
  async function refresh(): Promise<void> {
    if (!options.source) { paint(); return; }
    try { items = await options.source.list(); } catch (error) { toast(kt('No se han podido cargar las propuestas: {message}', { message: (error as Error)?.message ?? '' })); }
    paint();
  }
  const offSource = options.source?.subscribe?.((next) => { items = next; paint(); });
  const onFocus = () => { void refresh(); };
  if (options.source && !options.source.subscribe) window.addEventListener('focus', onFocus);

  const forTab = () => items.filter((i) => i.status === tab);
  const visible = () => forTab().filter((i) => !kindFilter || i.kind === kindFilter).sort((a, b) => (tab === 'pending' ? a.created_at.localeCompare(b.created_at) : (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at)));

  // --- Decidir -----------------------------------------------------------------------------------------------
  async function decide(item: ProposalItem, approve: boolean): Promise<void> {
    const run = approve ? options.onApprove : options.onReject;
    if (!run || busy.has(item.id)) return;
    const comment = el('textarea', { id: 'proposalComment', rows: '3', placeholder: kt('Lo verá quien lo propuso') }) as HTMLTextAreaElement;
    const ok = await confirmDialog({
      title: approve ? kt('¿Aprobar esta propuesta?') : kt('¿Descartar esta propuesta?'),
      text: item.summary,
      body: el('label', { class: 'field' }, el('span', null, kt('Comentario (opcional)')), comment),
      confirmLabel: approve ? kt('Aprobar') : kt('Descartar'),
      danger: !approve,
    });
    if (!ok) return;
    const text = comment.value.trim() || null;
    const order = visible().map((i) => i.id);
    const wasSelected = selected === item.id;
    busy.add(item.id);
    paint();
    try {
      await run(item, text);
      items = items.map((i) => (i.id === item.id ? { ...i, status: approve ? 'approved' : 'rejected', comment: text, decided_at: now().toISOString() } : i));
      toast(approve ? kt('Propuesta aprobada.') : kt('Propuesta descartada.'));
      // En escritorio, pasa sola a la siguiente pendiente.
      if (wasSelected) {
        const at = order.indexOf(item.id);
        const rest = visible().map((i) => i.id).filter((id) => id !== item.id);
        selected = rest.find((id) => order.indexOf(id) > at) ?? rest[rest.length - 1] ?? null;
      }
    } catch (error) {
      toast(kt('No se ha guardado: {message}', { message: (error as Error)?.message ?? '' }));
    } finally {
      busy.delete(item.id);
    }
    paint();
    if (options.source) void refresh();
    if (selected && wide()) list.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected)}"] .pl-open`)?.focus();
  }

  async function withdraw(item: ProposalItem): Promise<void> {
    if (!options.onWithdraw || busy.has(item.id)) return;
    const ok = await confirmDialog({ title: kt('¿Retirar esta propuesta?'), text: item.summary, confirmLabel: kt('Retirar'), danger: true });
    if (!ok) return;
    busy.add(item.id);
    paint();
    try {
      await options.onWithdraw(item);
      items = items.map((i) => (i.id === item.id ? { ...i, status: 'withdrawn' } : i));
      toast(kt('Propuesta retirada.'));
    } catch (error) {
      toast(kt('No se ha guardado: {message}', { message: (error as Error)?.message ?? '' }));
    } finally {
      busy.delete(item.id);
    }
    paint();
    if (options.source) void refresh();
  }

  // --- Piezas ------------------------------------------------------------------------------------------------
  const decisionButtons = (item: ProposalItem): HTMLElement | null => {
    if (mode !== 'review' || item.status !== 'pending' || !canDecide) return null;
    const disabled = busy.has(item.id) ? true : null;
    return el('div', { class: 'pl-actions' },
      options.onReject ? el('button', { type: 'button', class: 'ghost danger-text', disabled, ...mark('reject'), 'aria-label': `${kt('Descartar')}: ${item.summary}`, onclick: () => void decide(item, false) }, kt('Descartar')) : null,
      options.onApprove ? el('button', { type: 'button', class: 'primary', disabled, ...mark('approve'), 'aria-label': `${kt('Aprobar')}: ${item.summary}`, onclick: () => void decide(item, true) }, kt('Aprobar')) : null,
    );
  };

  const quote = (item: ProposalItem): HTMLElement | null => (item.comment
    ? el('p', { class: 'pl-quote' }, `«${item.comment}»`, item.decided_by?.name ? el('span', { class: 'pl-quote-by' }, ` · ${item.decided_by.name}`) : null)
    : null);

  const meta = (item: ProposalItem) => [mode === 'review' ? item.author.name : null, relativeTime(item.created_at, now()), appLabel(item.app)].filter(Boolean).join(' · ');

  function card(item: ProposalItem): HTMLElement {
    const link = item.status === 'approved' ? options.link?.(item) ?? null : null;
    const own = mode === 'mine' && item.status === 'pending' && options.onWithdraw
      ? el('div', { class: 'pl-actions' }, el('button', { type: 'button', class: 'ghost', disabled: busy.has(item.id) ? true : null, ...mark('withdraw'), 'aria-label': `${kt('Retirar')}: ${item.summary}`, onclick: () => void withdraw(item) }, kt('Retirar')))
      : null;
    return el('li', { class: `pl-card${selected === item.id ? ' on' : ''}${busy.has(item.id) ? ' busy' : ''}`, dataset: { id: item.id, status: item.status, kind: item.kind } },
      el('div', { class: 'pl-top' }, el('span', { class: 'chip small' }, el('span', null, kindLabel(item.kind))), suggestionStatusChip(item.status)),
      el('button', {
        type: 'button', class: 'pl-open', ...mark('open'), 'aria-current': selected === item.id ? 'true' : null,
        onclick: () => open(item), onkeydown: (e: Event) => step(e as KeyboardEvent, item),
      }, el('strong', { class: 'pl-summary' }, item.summary), el('span', { class: 'pl-meta' }, meta(item))),
      quote(item),
      link ? el('a', { class: 'linkbtn pl-link', href: link.href }, link.label, icon('chevronRight', 16)) : null,
      decisionButtons(item),
      own,
    );
  }

  function open(item: ProposalItem): void {
    if (mode === 'review' && wide()) { selected = item.id; paint(); list.querySelector<HTMLElement>(`[data-id="${CSS.escape(item.id)}"] .pl-open`)?.focus(); return; }
    if (!options.renderDetail) return;
    const actions = decisionButtons(item);
    const sheet = openSheet({ title: kindLabel(item.kind), body: detailBody(item, false), ...(actions ? { foot: Array.from(actions.childNodes) } : {}) });
    // Al decidir desde la hoja, se cierra.
    sheet.foot?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { void sheet.close(true); }, { capture: true }));
  }

  function step(e: KeyboardEvent, item: ProposalItem): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const ids = visible().map((i) => i.id);
    const next = ids[ids.indexOf(item.id) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    if (mode === 'review' && wide()) { selected = next; paint(); }
    list.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"] .pl-open`)?.focus();
  }

  function detailBody(item: ProposalItem, withActions: boolean): HTMLElement {
    return el('div', { class: 'pl-detail-body', dataset: { id: item.id } },
      el('div', { class: 'pl-top' }, el('span', { class: 'chip small' }, el('span', null, kindLabel(item.kind))), suggestionStatusChip(item.status)),
      el('h3', { class: 'pl-detail-title' }, item.summary),
      el('p', { class: 'pl-meta' }, [item.author.name, fullDate(item.created_at), appLabel(item.app)].filter(Boolean).join(' · ')),
      options.renderDetail ? el('div', { class: 'pl-detail-app' }, options.renderDetail(item)) : null,
      quote(item),
      withActions ? decisionButtons(item) : null,
      withActions && item.status === 'pending' && canDecide ? el('p', { class: 'hint' }, kt('↑ ↓ cambian de propuesta. Al decidir, pasa a la siguiente.')) : null,
    );
  }

  // --- Pintar ------------------------------------------------------------------------------------------------
  function paint(): void {
    replace(head,
      options.title ? el('h2', { class: 'pl-title' }, options.title) : null,
      mode === 'mine' && options.onCreate ? el('button', { type: 'button', class: 'primary', ...mark('create'), onclick: () => options.onCreate?.() }, icon('plus', 18), kt('Proponer')) : null,
    );
    if (mode === 'review') {
      const pending = items.filter((i) => i.status === 'pending').length;
      const kinds = [...new Set(forTab().map((i) => i.kind).concat(Object.keys(options.kinds ?? {})))];
      if (kindFilter && !kinds.includes(kindFilter)) kindFilter = null;
      replace(filters,
        el('div', { class: 'segmented pl-tabs', role: 'group', 'aria-label': kt('Estado') },
          ...TABS.map((t) => el('button', {
            type: 'button', class: tab === t.status ? 'on' : '', 'aria-pressed': String(tab === t.status), dataset: { status: t.status }, ...mark('tab'),
            onclick: () => { tab = t.status; selected = null; paint(); },
          }, kt(t.label), t.status === 'pending' && pending ? el('span', { class: 'pl-count' }, String(pending)) : null))),
        kinds.length > 1 ? el('div', { class: 'pl-kinds', role: 'group', 'aria-label': kt('Tipo') },
          el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(!kindFilter), ...mark('kind'), onclick: () => { kindFilter = null; paint(); } }, kt('Todas')),
          ...kinds.map((k) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(kindFilter === k), dataset: { kind: k }, ...mark('kind'), onclick: () => { kindFilter = k; paint(); } }, kindLabel(k)))) : null,
      );
      const rows = visible();
      if (selected && !rows.some((i) => i.id === selected)) selected = null;
      if (!selected && rows.length) selected = rows[0]!.id;
      replace(list, ...(rows.length ? rows.map(card) : [el('li', { class: 'empty pl-empty' }, options.emptyText ?? kt(tab === 'pending' ? 'No hay propuestas pendientes.' : tab === 'approved' ? 'Aún no hay propuestas aprobadas.' : 'No hay propuestas descartadas.'))]));
      const current = rows.find((i) => i.id === selected);
      if (detail) replace(detail, current ? detailBody(current, true) : el('p', { class: 'hint' }, kt('Elige una propuesta.')));
      return;
    }
    replace(filters);
    const mine = items.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
    const pending = mine.filter((i) => i.status === 'pending');
    const done = mine.filter((i) => i.status !== 'pending');
    const group = (title: string, rows: ProposalItem[]) => (rows.length ? [el('li', { class: 'pl-group' }, title), ...rows.map(card)] : []);
    replace(list, ...(mine.length
      ? [...group(kt('Pendientes'), pending), ...group(kt('Resueltas'), done)]
      : [el('li', { class: 'empty pl-empty' }, options.emptyText ?? kt('Aún no has propuesto nada.'))]));
  }

  paint();
  if (options.source) void refresh();

  return {
    element,
    setItems(next) { items = next.slice(); paint(); },
    refresh,
    destroy() { offSource?.(); window.removeEventListener('focus', onFocus); element.remove(); },
  };
}
