/**
 * Piezas comunes para los agentes de IA (contrato §3.1): revisión de propuestas con pie fijo, clave mostrada una vez,
 * resumen de riesgo, fila de propuesta, lista de cambios, registro de accesos y selector de ámbitos.
 * El kit no conoce el dominio: la app traduce los códigos de riesgo (`delete:1`, `bulk:12>=10`, `archive:project`…),
 * los nombres de tabla y de campo, y pasa etiquetas ya listas. Los ganchos de la app van en `attrs`.
 */
import { el, formatDate, plural, replace, type Child } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { openSheet, type Sheet, type SheetOptions } from '../overlay/sheet.ts';

export type HookAttrs = Record<string, string | number | boolean | null | undefined>;

// ---------------------------------------------------------------------------------------------------------------
// Estados y tiempo
// ---------------------------------------------------------------------------------------------------------------

/** Estados de una propuesta tal como los devuelve la API (`expired` lo calcula el servidor; aplicada es `consumed`). */
export type ProposalStatus = 'pending' | 'approved' | 'consumed' | 'rejected' | 'expired' | 'revoked';

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Pendiente',
  approved: 'Aprobada',
  consumed: 'Aplicada',
  rejected: 'Rechazada',
  expired: 'Caducada',
  revoked: 'Revocada',
};

const STATUS_TONE: Record<ProposalStatus, string> = {
  pending: 'pending', approved: 'approved', consumed: 'ok', rejected: 'trash', expired: 'trash', revoked: 'trash',
};

/** Chip de estado de una propuesta, con color fijo por estado. */
export function proposalStatusChip(status: ProposalStatus, labels: Partial<Record<ProposalStatus, string>> = {}): HTMLElement {
  return el('span', { class: `chip status ${STATUS_TONE[status] ?? ''}`, dataset: { status } }, el('span', null, labels[status] ?? PROPOSAL_STATUS_LABELS[status] ?? status));
}

/** «en 23 h», «en 15 min», «hace 2 h», «hace 3 días». */
export function relativeTime(iso: string | Date, now: Date = new Date()): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const text = minutes < 1 ? 'menos de 1 min'
    : minutes < 60 ? `${minutes} min`
      : minutes < 60 * 36 ? `${Math.round(minutes / 60)} h`
        : plural(Math.round(minutes / 1440), 'día', 'días');
  return diff >= 0 ? `en ${text}` : `hace ${text}`;
}

/** Final visible de un secreto: `…AzvE`. */
export function maskSecret(value: string, visible = 4): string {
  return `…${value.slice(-visible)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Resumen de riesgo
// ---------------------------------------------------------------------------------------------------------------

export interface RiskReason {
  /** Etiqueta ya traducida por la app («Incluye borrados», «Archiva un proyecto»). */
  label: string;
  /** `alert` para lo destructivo, `warn` para lo demás. */
  tone?: 'alert' | 'warn' | 'info';
}

export interface RiskSummaryOptions {
  /** Elementos afectados (`risk.affected`). */
  affected: number;
  /** Umbral de lote (`risk.bulkThreshold`); con `affected >= threshold` el contador se marca como aviso. */
  threshold?: number | null;
  reasons?: RiskReason[];
  /** Nombre del elemento afectado: «elemento»/«elementos». */
  unit?: [string, string];
}

/** Chips de riesgo: contador de afectados (con el umbral si se alcanza) y motivos traducidos por la app. */
export function renderRiskSummary(options: RiskSummaryOptions): HTMLElement {
  const [one, many] = options.unit ?? ['elemento afectado', 'elementos afectados'];
  const bulk = options.threshold != null && options.affected >= options.threshold;
  return el('div', { class: 'risksummary', role: 'group', 'aria-label': 'Riesgo' },
    el('span', { class: `chip${bulk ? ' warn' : ''}`, dataset: { risk: 'affected' } },
      el('span', null, plural(options.affected, one, many) + (bulk ? ` · umbral ${options.threshold}` : ''))),
    ...(options.reasons ?? []).map((reason) => el('span', { class: `chip ${reason.tone ?? 'warn'}`, dataset: { risk: reason.tone ?? 'warn' } }, el('span', null, reason.label))),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Fila de propuesta
// ---------------------------------------------------------------------------------------------------------------

export interface ProposalSummary {
  id: string;
  /** Nombre del agente que la preparó. */
  agent: string;
  status: ProposalStatus;
  createdAt: string;
  expiresAt?: string | null;
  affected?: number;
  reasons?: RiskReason[];
}

export interface ProposalRowOptions extends ProposalSummary {
  onOpen?: () => void;
  attrs?: HookAttrs;
  now?: Date;
}

function expiryText(p: ProposalSummary, now: Date): string | null {
  if (!p.expiresAt || (p.status !== 'pending' && p.status !== 'approved')) return null;
  return `caduca ${relativeTime(p.expiresAt, now)}`;
}

/** Fila de lista: agente, chip de estado, fecha, caducidad relativa, afectados y motivos. Pulsable si hay `onOpen`. */
export function renderProposalRow(options: ProposalRowOptions): HTMLElement {
  const now = options.now ?? new Date();
  const meta = [formatDate(options.createdAt), expiryText(options, now), options.affected != null ? plural(options.affected, 'elemento', 'elementos') : null].filter(Boolean).join(' · ');
  const inner: Child[] = [
    el('span', { class: 'pr-top' }, el('strong', { class: 'pr-agent' }, options.agent), proposalStatusChip(options.status)),
    el('span', { class: 'pr-meta' }, meta),
    options.reasons?.length ? el('span', { class: 'pr-reasons' }, ...options.reasons.map((r) => el('span', { class: `chip small ${r.tone ?? 'warn'}` }, el('span', null, r.label)))) : null,
  ];
  const attrs = { class: `proposalrow${options.onOpen ? ' pressable' : ''}`, dataset: { proposal: options.id, status: options.status }, ...(options.attrs ?? {}) };
  return options.onOpen
    ? el('button', { type: 'button', ...attrs, onclick: () => options.onOpen?.() }, ...inner)
    : el('div', attrs, ...inner);
}

// ---------------------------------------------------------------------------------------------------------------
// Lista de cambios
// ---------------------------------------------------------------------------------------------------------------

export interface ChangeField {
  /** Nombre del campo, traducido por la app. */
  label: string;
  before?: Child;
  after?: Child;
}

export interface ChangeItem {
  /** `insert`, `update`, `delete` u otra operación de la app. */
  op: string;
  /** Tabla en singular y plural, traducidas por la app («tarea», «tareas»). */
  table: string;
  tablePlural?: string;
  /** Título de la fila afectada. */
  title: Child;
  fields?: ChangeField[];
  id?: string;
}

export interface ChangeListOptions {
  changes: ChangeItem[];
  /** Agrupar por operación y tabla («Editar · 11 tareas»); por defecto sí. */
  group?: boolean;
  /** Filas visibles por grupo antes de «y N más»; por defecto 6. */
  max?: number;
  /** Nombres de operación; por defecto Crear, Editar, Borrar, Restaurar. */
  opLabels?: Record<string, string>;
}

const OP_LABELS: Record<string, string> = { insert: 'Crear', update: 'Editar', delete: 'Borrar', restore: 'Restaurar' };
const emptyMark = (): HTMLElement => el('span', { class: 'cl-empty' }, '—');

function fieldRow(field: ChangeField): HTMLElement {
  const empty = emptyMark;
  return el('div', { class: 'cl-field' },
    el('dt', null, field.label),
    el('dd', null,
      field.before !== undefined ? el('del', { class: 'cl-before' }, field.before === null || field.before === '' ? empty() : field.before) : null,
      field.before !== undefined && field.after !== undefined ? el('span', { class: 'cl-arrow', 'aria-hidden': 'true' }, '→') : null,
      field.after !== undefined ? el('ins', { class: 'cl-after' }, field.after === null || field.after === '' ? empty() : field.after) : null,
    ),
  );
}

function changeRow(change: ChangeItem, showOp: boolean, labels: Record<string, string>): HTMLElement {
  return el('li', { class: 'cl-item', dataset: { op: change.op, id: change.id ?? '' } },
    el('div', { class: 'cl-title' }, showOp ? el('span', { class: 'cl-op' }, `${labels[change.op] ?? change.op} · ${change.table}`) : null, el('strong', null, change.title)),
    change.fields?.length ? el('dl', { class: 'cl-fields' }, ...change.fields.map(fieldRow)) : null,
  );
}

/** Cambios de un lote agrupados por operación y tabla, con antes y después por campo y plegado «y N más». */
export function renderChangeList(options: ChangeListOptions): HTMLElement {
  const labels = { ...OP_LABELS, ...(options.opLabels ?? {}) };
  const max = options.max ?? 6;
  const groups = new Map<string, ChangeItem[]>();
  if (options.group === false) groups.set('', options.changes);
  else for (const change of options.changes) {
    const key = `${change.op}\u0000${change.table}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(change);
  }
  const root = el('div', { class: 'changelist' });
  for (const [key, items] of groups) {
    const first = items[0]!;
    const list = el('ol', { class: 'cl-items' });
    const visible = items.slice(0, max);
    list.append(...visible.map((c) => changeRow(c, key === '', labels)));
    if (items.length > visible.length) {
      const more = el('li', { class: 'cl-more' }, el('button', { type: 'button', class: 'linkbtn', onclick: () => more.replaceWith(...items.slice(max).map((c) => changeRow(c, key === '', labels))) }, `y ${items.length - max} más`));
      list.append(more);
    }
    root.append(el('section', { class: 'cl-group', dataset: { op: key ? first.op : '' } },
      key ? el('h4', { class: 'cl-head' }, el('span', { class: `cl-badge op-${first.op}` }, labels[first.op] ?? first.op), ` ${items.length} ${items.length === 1 ? first.table : (first.tablePlural ?? first.table)}`) : null,
      list,
    ));
  }
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// Revisión de una propuesta
// ---------------------------------------------------------------------------------------------------------------

export interface ProposalReviewOptions {
  proposal: ProposalSummary;
  changes: ChangeItem[];
  /** Umbral de lote para el resumen de riesgo. */
  threshold?: number | null;
  /** Nota bajo el resumen («El resumen es el de cuando se preparó…»). */
  note?: Child;
  /** Sin permiso para decidir, la hoja es solo de lectura. */
  canDecide?: boolean;
  onApprove?: () => void | Promise<void>;
  onReject?: () => void | Promise<void>;
  /** Ganchos de los botones (p. ej. `{ id: 'approveProposal' }`). */
  approveAttrs?: HookAttrs;
  rejectAttrs?: HookAttrs;
  title?: string;
  max?: number;
  opLabels?: Record<string, string>;
  now?: Date;
  /** Opciones de la hoja que se pasan tal cual a `openSheet` (ganchos `backAttrs`, `panelAttrs`, `bodyAttrs`, `closeAttrs`, `hideTitle`, `onClose`…). */
  sheet?: Partial<Omit<SheetOptions, 'title' | 'body' | 'foot'>>;
}

export interface ProposalReviewParts {
  /** Cabecera, riesgo, nota y cambios. */
  body: HTMLElement;
  /** Pie con «Rechazar» y «Aprobar N cambios»; `null` si no está pendiente o no se puede decidir. Lleva `.proposalreview-foot`, pegajoso abajo dentro de un contenedor que desplaza. */
  foot: HTMLElement | null;
}

/**
 * Las piezas de la revisión sin hoja: para una app que ya tiene su hoja (Tasks) y solo quiere el cuerpo y el pie.
 * Mientras se resuelve una acción, los botones del pie quedan desactivados.
 */
export function renderProposalReview(options: ProposalReviewOptions): ProposalReviewParts {
  const p = options.proposal;
  const now = options.now ?? new Date();
  const count = options.changes.length;
  const pending = p.status === 'pending' && options.canDecide !== false && !!(options.onApprove || options.onReject);
  const dates = [`Preparada ${formatDate(p.createdAt)}`, expiryText(p, now)].filter(Boolean).join(' · ');
  const body = el('div', { class: 'proposalreview' },
    el('div', { class: 'pr-top' }, el('strong', { class: 'pr-agent' }, p.agent), proposalStatusChip(p.status)),
    el('p', { class: 'pr-meta' }, dates),
    renderRiskSummary({ affected: p.affected ?? count, threshold: options.threshold, reasons: p.reasons }),
    options.note ? el('p', { class: 'hint' }, options.note) : null,
    renderChangeList({ changes: options.changes, max: options.max, opLabels: options.opLabels }),
  );
  if (!pending) return { body, foot: null };
  const foot = el('div', { class: 'proposalreview-foot' });
  const act = async (button: HTMLButtonElement, run?: () => void | Promise<void>) => {
    if (!run) return;
    const buttons = Array.from((button.parentElement ?? foot).querySelectorAll('button'));
    buttons.forEach((b) => { b.disabled = true; });
    try { await run(); } finally { buttons.forEach((b) => { b.disabled = false; }); button.blur(); }
  };
  const reject = options.onReject ? el('button', { type: 'button', class: 'ghost danger-text', ...(options.rejectAttrs ?? {}), onclick: (e: Event) => void act(e.currentTarget as HTMLButtonElement, options.onReject) }, 'Rechazar') : null;
  const approve = options.onApprove ? el('button', { type: 'button', class: 'primary', ...(options.approveAttrs ?? {}), onclick: (e: Event) => void act(e.currentTarget as HTMLButtonElement, options.onApprove) }, count === 1 ? 'Aprobar el cambio' : `Aprobar ${count} cambios`) : null;
  foot.append(...[reject, approve].filter((b): b is HTMLButtonElement => !!b));
  return { body, foot };
}

/**
 * Hoja de revisión: cabecera con agente, estado y fechas; resumen de riesgo; cambios agrupados; y **pie fijo** con
 * «Rechazar» y «Aprobar N cambios», que no se pierde con lotes largos. Solo hay pie si está pendiente y se puede decidir.
 */
export function openProposalReview(options: ProposalReviewOptions): Sheet {
  const { body, foot } = renderProposalReview(options);
  if (foot) foot.classList.remove('proposalreview-foot');
  return openSheet({ ...(options.sheet ?? {}), title: options.title ?? 'Revisar propuesta', body, foot: foot ? Array.from(foot.childNodes) : undefined });
}

// ---------------------------------------------------------------------------------------------------------------
// Clave mostrada una vez
// ---------------------------------------------------------------------------------------------------------------

export interface SecretOnceOptions {
  value: string;
  label?: string;
  /** Aviso; por defecto «Solo se muestra ahora…». */
  warning?: Child;
  /** Antes de «Hecho», pedir «La he guardado» si no se ha copiado; por defecto sí. */
  confirmBeforeDone?: boolean;
  onDone?: () => void;
  doneLabel?: string;
  /** Ganchos: el campo con la clave, el botón de copiar y el de terminar. */
  valueAttrs?: HookAttrs;
  copyAttrs?: HookAttrs;
  doneAttrs?: HookAttrs;
}

/** Clave entera en monoespaciada (salta de línea, no se corta), «Copiar» con confirmación y «Hecho» que pide guardarla. */
export function renderSecretOnce(options: SecretOnceOptions): HTMLElement {
  let copied = false;
  const value = el('textarea', { class: 'so-value', readonly: true, rows: '2', spellcheck: 'false', autocomplete: 'off', 'aria-label': options.label ?? 'Clave', ...(options.valueAttrs ?? {}) }) as HTMLTextAreaElement;
  value.value = options.value;
  const copyText = el('span', null, 'Copiar');
  const copy = el('button', { type: 'button', class: 'ghost', ...(options.copyAttrs ?? {}), onclick: async () => {
    try { await navigator.clipboard.writeText(options.value); } catch { value.select(); document.execCommand?.('copy'); }
    copied = true;
    replace(copy, icon('check', 18), el('span', null, 'Copiada'));
    copy.classList.add('done');
    confirm.hidden = true;
  } }, icon('copy', 18), copyText);
  const check = el('input', { type: 'checkbox', class: 'so-check' }) as HTMLInputElement;
  const confirm = el('label', { class: 'field check so-confirm', hidden: true }, check, el('span', null, 'La he guardado en un lugar seguro'));
  const done = el('button', { type: 'button', class: 'primary', ...(options.doneAttrs ?? {}), onclick: () => {
    if (options.confirmBeforeDone !== false && !copied && !check.checked) {
      confirm.hidden = false;
      confirm.classList.add('attention');
      check.focus();
      return;
    }
    options.onDone?.();
  } }, options.doneLabel ?? 'Hecho');
  check.addEventListener('change', () => confirm.classList.toggle('attention', !check.checked));
  return el('div', { class: 'secretonce' },
    el('div', { class: 'banner warn' }, icon('warn', 18), el('span', null, options.warning ?? 'Solo se muestra ahora. Cópiala y guárdala: si la pierdes, revócala y crea otra.')),
    el('label', { class: 'field' }, el('span', null, options.label ?? 'Clave'), value),
    confirm,
    el('div', { class: 'btnrow' }, copy, done),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Registro de accesos
// ---------------------------------------------------------------------------------------------------------------

export interface AccessLogEntry {
  at: string;
  /** Evento, traducido por la app («Propuesta aprobada»). */
  label: string;
  /** Quién: persona o agente. */
  actor?: string;
  actorKind?: 'person' | 'agent';
  /** Sobre quién o qué («Asistente de obra»). */
  target?: string;
  icon?: IconName;
  tone?: 'alert' | 'warn' | 'ok';
}

function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Registro agrupado por días (Hoy, Ayer, fecha), con icono por evento, hora y chip de quién. */
export function renderAccessLog(options: { entries: AccessLogEntry[]; now?: Date; emptyText?: string }): HTMLElement {
  const now = options.now ?? new Date();
  const today = dayKeyOf(now.toISOString());
  const yesterday = dayKeyOf(new Date(now.getTime() - 86_400_000).toISOString());
  const root = el('div', { class: 'accesslog' });
  if (!options.entries.length) {
    root.append(el('p', { class: 'hint' }, options.emptyText ?? 'Sin accesos registrados.'));
    return root;
  }
  const days = new Map<string, AccessLogEntry[]>();
  for (const entry of [...options.entries].sort((a, b) => b.at.localeCompare(a.at))) {
    const key = dayKeyOf(entry.at);
    if (!days.has(key)) days.set(key, []);
    days.get(key)!.push(entry);
  }
  for (const [key, entries] of days) {
    const title = key === today ? 'Hoy' : key === yesterday ? 'Ayer' : new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(entries[0]!.at));
    root.append(el('section', { class: 'al-day', dataset: { day: key } },
      el('h4', null, title),
      el('ol', null, ...entries.map((entry) => el('li', { class: `al-entry${entry.tone ? ' ' + entry.tone : ''}` },
        el('span', { class: 'al-icon', 'aria-hidden': 'true' }, icon(entry.icon ?? 'history', 16)),
        el('span', { class: 'al-text' },
          el('strong', null, entry.label),
          entry.target ? el('span', { class: 'al-target' }, entry.target) : null,
        ),
        entry.actor ? el('span', { class: `chip small al-actor ${entry.actorKind ?? 'person'}` }, entry.actorKind === 'agent' ? icon('bot', 12) : icon('user', 12), el('span', null, entry.actor)) : null,
        el('time', { class: 'al-time', datetime: entry.at }, new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(entry.at))),
      ))),
    ));
  }
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// Selector de ámbitos
// ---------------------------------------------------------------------------------------------------------------

export interface ScopeArea {
  id: string;
  name: string;
  projects: { id: string; name: string }[];
}

/** `'*'`: todo, también lo futuro. Si no, áreas enteras y proyectos sueltos por área (formato de `core.access_scopes`). */
export type ScopeValue = '*' | { tabs: string[]; projects: Record<string, string[]> };

export interface ScopePicker {
  element: HTMLElement;
  get(): ScopeValue;
  set(value: ScopeValue): void;
  /** Nada elegido (ni todo, ni un área, ni un proyecto). */
  isEmpty(): boolean;
}

/** Árbol «Todo, también lo futuro» → área entera → proyectos. Elegir el todo desactiva lo demás; un área entera, sus proyectos. */
export function createScopePicker(options: { areas: ScopeArea[]; value?: ScopeValue; onChange?: (value: ScopeValue) => void; allLabel?: string; areaLabel?: (area: ScopeArea) => string; label?: string }): ScopePicker {
  const all = el('input', { type: 'checkbox', dataset: { scope: 'all' } }) as HTMLInputElement;
  const areaBoxes = new Map<string, HTMLInputElement>();
  const projectBoxes = new Map<string, { area: string; box: HTMLInputElement }>();
  const groups = options.areas.map((area) => {
    const box = el('input', { type: 'checkbox', dataset: { scopeArea: area.id } }) as HTMLInputElement;
    areaBoxes.set(area.id, box);
    return el('div', { class: 'sp-area' },
      el('label', { class: 'field check sp-area-all' }, box, el('span', null, options.areaLabel ? options.areaLabel(area) : `Todo ${area.name}`)),
      area.projects.length ? el('div', { class: 'sp-projects' }, ...area.projects.map((project) => {
        const pbox = el('input', { type: 'checkbox', dataset: { scopeProject: project.id } }) as HTMLInputElement;
        projectBoxes.set(project.id, { area: area.id, box: pbox });
        return el('label', { class: 'field check' }, pbox, el('span', null, project.name));
      })) : null,
    );
  });
  const element = el('fieldset', { class: 'scopepicker' },
    el('legend', { class: 'vh' }, options.label ?? 'Ámbito'),
    el('label', { class: 'field check sp-all' }, all, el('span', null, options.allLabel ?? 'Todas las áreas, también las futuras')),
    el('div', { class: 'sp-areas' }, ...groups),
  );
  const sync = () => {
    for (const box of areaBoxes.values()) box.disabled = all.checked;
    for (const { area, box } of projectBoxes.values()) box.disabled = all.checked || !!areaBoxes.get(area)?.checked;
    element.classList.toggle('all', all.checked);
  };
  const get = (): ScopeValue => {
    if (all.checked) return '*';
    const tabs = [...areaBoxes].filter(([, box]) => box.checked).map(([id]) => id);
    const projects: Record<string, string[]> = {};
    for (const [id, { area, box }] of projectBoxes) {
      if (!box.checked || tabs.includes(area)) continue;
      (projects[area] ??= []).push(id);
    }
    return { tabs, projects };
  };
  const set = (value: ScopeValue) => {
    all.checked = value === '*';
    const v = value === '*' ? { tabs: [], projects: {} as Record<string, string[]> } : value;
    for (const [id, box] of areaBoxes) box.checked = v.tabs.includes(id);
    for (const [id, { area, box }] of projectBoxes) box.checked = !!v.projects[area]?.includes(id);
    sync();
  };
  element.addEventListener('change', () => { sync(); options.onChange?.(get()); });
  set(options.value ?? { tabs: [], projects: {} });
  return {
    element, get, set,
    isEmpty() { const v = get(); return v !== '*' && !v.tabs.length && !Object.values(v.projects).some((l) => l.length); },
  };
}
