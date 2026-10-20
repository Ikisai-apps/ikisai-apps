/**
 * Cola de propuestas (O1, `ampliacion/RECURSOS.md` §14): sugerencias de personas (tareas, platos, «Apuntarme»,
 * feedback) que staff o dirección aprueban o descartan, y la vista «Mis propuestas» de quien propone.
 *
 * ```ts
 * const source = createSuggestionSource(client, { scope: 'all' });   // sync-client 0.7.0
 * const list = createProposalList({
 *   mode: 'review', source, canDecide: role === 'editor' || role === 'owner',
 *   onApprove: source.approve, onReject: source.reject,
 *   renderDetail: (s) => (s.kind === 'task' ? taskPreview(s.detail) : source.renderPreview(s)),
 * });
 * ```
 *
 * - Por defecto, aprobar, descartar y retirar **confirman** con un diálogo; al aprobar o descartar, con un comentario
 *   opcional que verá quien lo propuso. Un aprobado se deshace desde el historial de la app.
 * - Con `confirm: false` (Tasks, tanda 29) se decide al momento: el comentario opcional va en la propia tarjeta y, con
 *   `undoMs`, la decisión espera ese rato con «Deshacer» en el aviso y en la tarjeta antes de llamar a `onApprove` u
 *   `onReject`. Retirar sigue confirmando.
 * - Escritorio (≥ 900 px): lista a la izquierda y detalle a la derecha; ↑ y ↓ cambian de propuesta y, al decidir, pasa
 *   sola a la siguiente pendiente. Móvil: los botones en la tarjeta y el detalle en una hoja.
 * - Con `source`, vuelve a leer al enfocar la ventana y tras cada decisión (o con `subscribe`, si lo da).
 * - No sustituye al revisor de feedback de Central ni a la revisión de propuestas de agentes (`openProposalReview`).
 */
import { el, replace, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { toast, toastWithAction } from '../toast.ts';
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
  /** Nombre del tipo que da el servidor («Tarea»); `kinds` manda si lo trae. */
  label?: string | null;
  /** Qué se propone, en una línea. */
  summary: string;
  /** Libre: lo que la app necesita para pintar el detalle (`renderDetail`). */
  detail?: unknown;
  author: { id: string; name: string };
  createdAt: string;
  status: SuggestionStatus;
  comment?: string | null;
  decidedBy?: { id?: string; name: string } | null;
  decidedAt?: string | null;
  /** Lo creado al aprobar (ids); el enlace lo construye la app con `link`. */
  result?: unknown;
}

/** Forma de la 0.33.0 (snake_case); se sigue aceptando. */
export type LegacyProposalItem = Omit<ProposalItem, 'createdAt' | 'decidedBy' | 'decidedAt'> & {
  created_at: string;
  decided_by?: { id?: string; name: string } | null;
  decided_at?: string | null;
};

export type ProposalInput = ProposalItem | LegacyProposalItem;

/** Pasa una propuesta en camelCase (la API de sugerencias) o en snake_case (0.33.0) a la forma del componente. */
export function normalizeProposal(raw: ProposalInput): ProposalItem {
  if ('createdAt' in raw && raw.createdAt) return raw;
  const { created_at, decided_by, decided_at, ...rest } = raw as LegacyProposalItem;
  return { ...rest, createdAt: created_at, decidedBy: decided_by ?? null, decidedAt: decided_at ?? null };
}

export interface ProposalSource {
  list(): Promise<ProposalInput[]>;
  /** Avisa cuando cambian; sin él, se vuelve a leer al enfocar la ventana y tras decidir. */
  subscribe?(listener: (items: ProposalInput[]) => void): () => void;
  /** Pendientes que dice el servidor (si la lista viene cortada); sin él, se cuentan. */
  pendingCount?(): number | null;
}

export interface ProposalListOptions {
  /** `review`: para quien decide. `mine`: lo que he propuesto. */
  mode: 'review' | 'mine';
  items?: ProposalInput[];
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
  /**
   * Lo que la app enseña de la propuesta (detalle de escritorio y hoja del móvil). Puede ser una promesa: p. ej.
   * `source.renderPreview` de `createSuggestionSource`, con el antes y después del lote.
   */
  renderDetail?: (item: ProposalItem) => Child | Promise<Child>;
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
  /**
   * `false`: aprobar y descartar sin diálogo; el comentario se escribe en la tarjeta (o en el detalle). Por defecto
   * `true`, como siempre.
   */
  confirm?: boolean;
  /**
   * Con `confirm: false`: cuánto se espera (ms) antes de guardar, con «Deshacer» mientras tanto. Si se destruye la
   * lista en ese rato, se guarda al momento. Por defecto 0 (al momento, sin «Deshacer»).
   */
  undoMs?: number;
}

export interface ProposalList {
  element: HTMLElement;
  setItems(items: ProposalInput[]): void;
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
  comment: ['comentario', 'Comentario para quien lo propuso'],
  undo: ['deshacer', 'Deshacer la decisión'],
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
  let items: ProposalItem[] = (options.items ?? []).map(normalizeProposal);
  let tab: 'pending' | 'approved' | 'rejected' = options.status ?? 'pending';
  let kindFilter: string | null = null;
  let selected: string | null = null;
  const busy = new Set<string>();
  const ask = options.confirm !== false;
  /** Comentarios escritos en la tarjeta (con `confirm: false`), por propuesta; sobreviven a repintar. */
  const drafts = new Map<string, string>();
  /** Decisiones a la espera de «Deshacer»: la propuesta tal como estaba y el guardado pendiente. */
  const waiting = new Map<string, { before: ProposalItem; timer: ReturnType<typeof setTimeout>; save: () => void }>();

  const kindLabel = (kind: string) => kt(options.kinds?.[kind]?.label ?? items.find((i) => i.kind === kind && i.label)?.label ?? kind);
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
    try { items = keepWaiting((await options.source.list()).map(normalizeProposal)); } catch (error) { toast(kt('No se han podido cargar las propuestas: {message}', { message: (error as Error)?.message ?? '' })); }
    paint();
  }
  /** Lo que aún espera «Deshacer» se ve decidido aunque el servidor todavía lo tenga pendiente. */
  function keepWaiting(next: ProposalItem[]): ProposalItem[] {
    if (!waiting.size) return next;
    const local = new Map(items.filter((i) => waiting.has(i.id)).map((i) => [i.id, i]));
    return next.map((i) => local.get(i.id) ?? i);
  }
  const offSource = options.source?.subscribe?.((next) => { items = keepWaiting(next.map(normalizeProposal)); paint(); });
  const onFocus = () => { void refresh(); };
  if (options.source && !options.source.subscribe) window.addEventListener('focus', onFocus);

  const forTab = () => items.filter((i) => i.status === tab);
  const visible = () => forTab().filter((i) => !kindFilter || i.kind === kindFilter).sort((a, b) => (tab === 'pending' ? a.createdAt.localeCompare(b.createdAt) : (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)));

  // --- Decidir -----------------------------------------------------------------------------------------------
  /** En escritorio, tras decidir, pasa sola a la siguiente pendiente. */
  function moveOn(id: string, order: string[]): void {
    const at = order.indexOf(id);
    const rest = visible().map((i) => i.id).filter((x) => x !== id);
    selected = rest.find((x) => order.indexOf(x) > at) ?? rest[rest.length - 1] ?? null;
  }
  const decided = (item: ProposalItem, approve: boolean, text: string | null): ProposalItem => ({ ...item, status: approve ? 'approved' : 'rejected', comment: text, decidedAt: now().toISOString() });

  async function decide(item: ProposalItem, approve: boolean): Promise<void> {
    const run = approve ? options.onApprove : options.onReject;
    if (!run || busy.has(item.id) || waiting.has(item.id)) return;
    let text: string | null;
    if (ask) {
      const comment = el('textarea', { id: 'proposalComment', rows: '3', placeholder: kt('Lo verá quien lo propuso') }) as HTMLTextAreaElement;
      const ok = await confirmDialog({
        title: approve ? kt('¿Aprobar esta propuesta?') : kt('¿Descartar esta propuesta?'),
        text: item.summary,
        body: el('label', { class: 'field' }, el('span', null, kt('Comentario (opcional)')), comment),
        confirmLabel: approve ? kt('Aprobar') : kt('Descartar'),
        danger: !approve,
      });
      if (!ok) return;
      text = comment.value.trim() || null;
    } else text = drafts.get(item.id)?.trim() || null;
    const order = visible().map((i) => i.id);
    const wasSelected = selected === item.id;
    const ms = ask ? 0 : options.undoMs ?? 0;
    if (ms > 0) { later(item, approve, text, run, ms, wasSelected ? order : null); return; }
    busy.add(item.id);
    paint();
    try {
      await run(item, text);
      drafts.delete(item.id);
      items = items.map((i) => (i.id === item.id ? decided(i, approve, text) : i));
      toast(approve ? kt('Propuesta aprobada.') : kt('Propuesta descartada.'));
      if (wasSelected) moveOn(item.id, order);
    } catch (error) {
      toast(kt('No se ha guardado: {message}', { message: (error as Error)?.message ?? '' }));
    } finally {
      busy.delete(item.id);
    }
    paint();
    if (options.source) void refresh();
    if (selected && wide()) list.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected)}"] .pl-open`)?.focus();
  }

  /** Decisión con «Deshacer»: se ve ya decidida y se guarda al acabar el plazo; deshacer la devuelve a pendientes. */
  function later(item: ProposalItem, approve: boolean, text: string | null, run: NonNullable<ProposalListOptions['onApprove']>, ms: number, order: string[] | null): void {
    const save = () => {
      const w = waiting.get(item.id);
      if (!w) return;
      clearTimeout(w.timer);
      waiting.delete(item.id);
      drafts.delete(item.id);
      undos.delete(item.id);
      if (element.isConnected) paint();
      void Promise.resolve().then(() => run(item, text)).then(() => { if (options.source) void refresh(); }, (error: unknown) => {
        items = items.map((i) => (i.id === item.id ? w.before : i));
        drafts.set(item.id, text ?? '');
        toast(kt('No se ha guardado: {message}', { message: (error as Error)?.message ?? '' }));
        paint();
      });
    };
    const undo = () => {
      const w = waiting.get(item.id);
      if (!w) return;
      clearTimeout(w.timer);
      waiting.delete(item.id);
      undos.delete(item.id);
      items = items.map((i) => (i.id === item.id ? w.before : i));
      selected = item.id;
      paint();
      toast(kt('Decisión deshecha.'));
      list.querySelector<HTMLElement>(`[data-id="${CSS.escape(item.id)}"] .pl-open`)?.focus();
    };
    waiting.set(item.id, { before: item, timer: setTimeout(save, ms), save });
    items = items.map((i) => (i.id === item.id ? decided(i, approve, text) : i));
    if (order) moveOn(item.id, order);
    paint();
    toastWithAction(approve ? kt('Propuesta aprobada.') : kt('Propuesta descartada.'), { label: kt('Deshacer'), onClick: undo }, ms);
    undos.set(item.id, undo);
  }
  /** «Deshacer» de cada decisión a la espera (también en su tarjeta, en Aprobadas o Descartadas). */
  const undos = new Map<string, () => void>();

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
    const note = ask ? null : el('label', { class: 'field pl-comment' }, el('span', null, kt('Comentario (opcional)')),
      el('textarea', {
        rows: '2', placeholder: kt('Lo verá quien lo propuso'), disabled, ...mark('comment'), 'aria-label': `${kt('Comentario (opcional)')}: ${item.summary}`,
        oninput: (e: Event) => { drafts.set(item.id, (e.target as HTMLTextAreaElement).value); },
      }, drafts.get(item.id) ?? ''));
    const buttons = el('div', { class: 'pl-actions' },
      options.onReject ? el('button', { type: 'button', class: 'ghost danger-text', disabled, ...mark('reject'), 'aria-label': `${kt('Descartar')}: ${item.summary}`, onclick: () => void decide(item, false) }, kt('Descartar')) : null,
      options.onApprove ? el('button', { type: 'button', class: 'primary', disabled, ...mark('approve'), 'aria-label': `${kt('Aprobar')}: ${item.summary}`, onclick: () => void decide(item, true) }, kt('Aprobar')) : null,
    );
    return note ? el('div', { class: 'pl-decide' }, note, buttons) : buttons;
  };

  /** Mientras la decisión espera, la tarjeta dice que aún se puede deshacer. */
  const undoLine = (item: ProposalItem): HTMLElement | null => (waiting.has(item.id)
    ? el('p', { class: 'pl-undo', role: 'status' }, kt('Aún se puede deshacer.'), ' ',
      el('button', { type: 'button', class: 'linkbtn', ...mark('undo'), 'aria-label': `${kt('Deshacer')}: ${item.summary}`, onclick: () => undos.get(item.id)?.() }, kt('Deshacer')))
    : null);

  const quote = (item: ProposalItem): HTMLElement | null => (item.comment
    ? el('p', { class: 'pl-quote' }, `«${item.comment}»`, item.decidedBy?.name ? el('span', { class: 'pl-quote-by' }, ` · ${item.decidedBy.name}`) : null)
    : null);

  const meta = (item: ProposalItem) => [mode === 'review' ? item.author.name : null, relativeTime(item.createdAt, now()), appLabel(item.app)].filter(Boolean).join(' · ');

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
      undoLine(item),
      link ? el('a', { class: 'linkbtn pl-link', href: link.href }, link.label, icon('chevronRight', 16)) : null,
      decisionButtons(item),
      own,
    );
  }

  function open(item: ProposalItem): void {
    if (mode === 'review' && wide()) { selected = item.id; paint(); list.querySelector<HTMLElement>(`[data-id="${CSS.escape(item.id)}"] .pl-open`)?.focus(); return; }
    if (!options.renderDetail) return;
    const decision = decisionButtons(item);
    const actions = decision?.classList.contains('pl-actions') ? decision : decision?.querySelector('.pl-actions') ?? null;
    const note = decision?.querySelector('.pl-comment') ?? null;
    const body = detailBody(item, false);
    if (note) body.append(note);
    const sheet = openSheet({ title: kindLabel(item.kind), body, ...(actions ? { foot: Array.from(actions.childNodes) } : {}) });
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

  /** Detalle de la app; si es una promesa (vista previa del servidor), se espera y se guarda por propuesta y estado. */
  const details = new Map<string, Promise<Child>>();
  function detailSlot(item: ProposalItem): HTMLElement {
    const box = el('div', { class: 'pl-detail-app' });
    const key = `${item.id}:${item.status}`;
    let out: Child | Promise<Child>;
    try { out = details.get(key) ?? options.renderDetail!(item); } catch (error) { out = el('p', { class: 'hint' }, (error as Error)?.message ?? ''); }
    if (out instanceof Promise) {
      details.set(key, out);
      box.append(el('p', { class: 'hint' }, kt('Cargando…')));
      box.setAttribute('aria-busy', 'true');
      out.then((child) => { box.removeAttribute('aria-busy'); replace(box, child); }, (error: unknown) => { details.delete(key); box.removeAttribute('aria-busy'); replace(box, el('p', { class: 'hint' }, kt('No se ha podido cargar el detalle: {message}', { message: (error as Error)?.message ?? '' }))); });
    } else replace(box, out);
    return box;
  }

  function detailBody(item: ProposalItem, withActions: boolean): HTMLElement {
    return el('div', { class: 'pl-detail-body', dataset: { id: item.id } },
      el('div', { class: 'pl-top' }, el('span', { class: 'chip small' }, el('span', null, kindLabel(item.kind))), suggestionStatusChip(item.status)),
      el('h3', { class: 'pl-detail-title' }, item.summary),
      el('p', { class: 'pl-meta' }, [item.author.name, fullDate(item.createdAt), appLabel(item.app)].filter(Boolean).join(' · ')),
      options.renderDetail ? detailSlot(item) : null,
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
      const pending = options.source?.pendingCount?.() ?? items.filter((i) => i.status === 'pending').length;
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
    const mine = items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    setItems(next) { items = next.map(normalizeProposal); paint(); },
    refresh,
    destroy() {
      // Lo que esperaba «Deshacer» se guarda ya: cerrar la vista no deshace.
      for (const w of [...waiting.values()]) w.save();
      offSource?.(); window.removeEventListener('focus', onFocus); element.remove();
    },
  };
}
