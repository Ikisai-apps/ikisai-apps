/**
 * «Sugerencias y QA» (especificación §7, §20 y §21; FEEDBACK.md §7 y §8.2): entrada de menú de las apps internas con
 * cuatro vistas (Mapa · Abiertos · Pendientes de verificar · Mis borradores).
 * - **Mapa**: árbol plegado construido con `GET feedback/tree?app=` (solo ramas con reportes), con recuento por rama y
 *   búsqueda por etiqueta. Al tocar un nodo, sus reportes.
 * - **Tarjeta** de reporte: código, tipo, estado, «Me bloquea», apoyos y ruta.
 * - **Detalle** (`GET feedback/:id`): mensaje, imágenes, tareas enlazadas, «Copiar para Claude» y «Descargar .md» con el
 *   `agentBlock`, y las acciones de verificar, reabrir y descartar según quién mira.
 * Todo el texto del servidor se pinta como texto (`textContent`), nunca como HTML.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { openSheet, type Sheet } from '../overlay/sheet.ts';
import { toast } from '../toast.ts';
import type { FeedbackApi, FeedbackReport } from './client.ts';
import { FEEDBACK_DISPLAY_LABELS, FEEDBACK_INTENT_LABELS, type FeedbackIntent } from './constants.ts';
import { appVersion } from './context.ts';
import type { Feedback } from './feedback.ts';
import { kitLocaleTag, kt } from '../i18n/i18n.ts';

export type FeedbackCenterTab = 'map' | 'open' | 'verify' | 'drafts';

export interface FeedbackTreeNode { id: string; path: string[]; open: number; pendingVerify: number; verified: number; total: number }

export interface FeedbackReportDetail {
  report: FeedbackReport;
  attachments: { id: string; url: string }[];
  tasks: { taskId: string; status: string; sequence?: number | null }[];
  /** Solo en apps internas (los portales no reciben el diagnóstico). */
  agentBlock?: string;
}

export interface FeedbackCenterOptions {
  api: FeedbackApi;
  app: string;
  /** Editor u owner: puede descartar y verificar o reabrir cualquier reporte (quien lo informó, los suyos). */
  canEdit?: () => boolean;
  /** Para «Mis borradores» (y reabrirlos). */
  feedback?: Feedback;
  tab?: FeedbackCenterTab;
  /** Deep link `#/feedback/<code-or-id>`: abre directamente el detalle. */
  reportId?: string;
  /** Se llama al reabrir un borrador (para cerrar la hoja que contiene el centro). */
  onLeave?: () => void;
  /** Dónde montar la hoja de `openFeedbackCenter`; por defecto `document.body` (en Tasks, `#kitLayer`). */
  container?: () => HTMLElement;
}

export interface FeedbackCenter {
  element: HTMLElement;
  show(tab: FeedbackCenterTab): Promise<void>;
  showReport(id: string): Promise<void>;
}

const TABS: [FeedbackCenterTab, string][] = [['map', 'Mapa'], ['open', 'Abiertos'], ['verify', 'Pendientes de verificar'], ['drafts', 'Mis borradores']];
const DISPLAY_CHIP: Record<string, string> = { open: 'pending', in_progress: '', pending_verify: 'ok', verified: 'ok', dismissed: 'trash' };

const when = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(kitLocaleTag(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function reportChip(display: string): HTMLElement {
  return el('span', { class: `chip small ${DISPLAY_CHIP[display] ?? ''}`.trim(), dataset: { display } }, el('span', null, FEEDBACK_DISPLAY_LABELS[display] ? kt(FEEDBACK_DISPLAY_LABELS[display]) : display));
}

/** Tarjeta de reporte (lista del nodo, abiertos, pendientes de verificar). */
export function feedbackReportCard(report: FeedbackReport, onOpen?: (report: FeedbackReport) => void): HTMLElement {
  return el('button', { type: 'button', class: 'fb-card', dataset: { report: report.id, code: report.code }, onclick: () => onOpen?.(report) },
    el('span', { class: 'fb-card-head' },
      el('strong', { class: 'fb-code' }, report.code),
      el('span', { class: 'fb-card-intent' }, FEEDBACK_INTENT_LABELS[report.intent as FeedbackIntent] ? kt(FEEDBACK_INTENT_LABELS[report.intent as FeedbackIntent]) : report.intent),
      report.blocking ? el('span', { class: 'chip small alert fb-card-blocking' }, el('span', null, kt('Me bloquea'))) : null,
      reportChip(report.display)),
    el('span', { class: 'fb-card-msg' }, report.message),
    el('span', { class: 'fb-card-meta' },
      report.node ? el('span', null, report.node.path.join(' › ')) : null,
      report.supportersCount > 1 ? el('span', null, kt('{count} personas', { count: report.supportersCount })) : null,
      el('span', null, when(report.createdAt))));
}

/** Copia al portapapeles (con alternativa para navegadores sin `navigator.clipboard`). */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* sigue con la alternativa */ }
  const area = el('textarea', { style: 'position:fixed;opacity:0;top:0;left:0', 'aria-hidden': 'true' }) as HTMLTextAreaElement;
  area.value = text;
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = el('a', { href: url, download: name, hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Branch { key: string; label: string; nodeId: string | null; open: number; pendingVerify: number; total: number; children: Map<string, Branch> }

/** Árbol a partir de las rutas de etiquetas: cada rama suma lo de sus hojas. */
export function buildFeedbackTree(nodes: FeedbackTreeNode[]): Branch {
  const root: Branch = { key: '', label: '', nodeId: null, open: 0, pendingVerify: 0, total: 0, children: new Map() };
  for (const n of nodes) {
    let at = root;
    const path = n.path.length ? n.path : [n.id];
    path.forEach((label, i) => {
      let next = at.children.get(label);
      if (!next) { next = { key: `${at.key}\u0001${label}`, label, nodeId: null, open: 0, pendingVerify: 0, total: 0, children: new Map() }; at.children.set(label, next); }
      next.open += n.open; next.pendingVerify += n.pendingVerify; next.total += n.total;
      if (i === path.length - 1) next.nodeId = n.id;
      at = next;
    });
  }
  return root;
}

export function renderFeedbackCenter(options: FeedbackCenterOptions): FeedbackCenter {
  const expanded = new Set<string>();
  let tab: FeedbackCenterTab = options.tab ?? 'map';
  let tree: Branch | null = null;
  let query = '';
  const tabsRow = el('div', { class: 'segmented fb-tabs', role: 'tablist', 'aria-label': kt('Sugerencias y QA') });
  const body = el('div', { class: 'fb-center-body', role: 'tabpanel' });
  const element = el('div', { class: 'fb-center' }, tabsRow, body);
  const appQ = `app=${encodeURIComponent(options.app)}`;

  function paintTabs(): void {
    replace(tabsRow, ...TABS.map(([id, label]) => el('button', {
      type: 'button', role: 'tab', 'aria-selected': String(id === tab), class: id === tab ? 'on' : '', dataset: { fbTab: id },
      onclick: () => void show(id),
    }, kt(label))));
  }
  const loading = () => replace(body, el('p', { class: 'hint' }, kt('Cargando…')));
  const failed = (retry: () => void) => replace(body, el('div', { class: 'banner warn' }, icon('offline', 18), el('span', null, kt('No se pudo cargar. Comprueba la conexión.')), el('button', { type: 'button', class: 'ghost small', onclick: retry }, kt('Reintentar'))));

  async function list(path: string, title: string | null, empty: string, back?: () => void): Promise<void> {
    loading();
    try {
      const { items } = await options.api<{ items: FeedbackReport[] }>(path);
      replace(body,
        back ? el('button', { type: 'button', class: 'linkbtn fb-back', onclick: back }, icon('chevronLeft', 16), kt('Volver')) : null,
        title ? el('h3', { class: 'fb-center-title' }, title) : null,
        items?.length ? el('div', { class: 'fb-cards' }, ...items.map((r) => feedbackReportCard(r, (x) => void showReport(x.id, () => void list(path, title, empty, back))))) : el('p', { class: 'hint fb-empty' }, empty));
    } catch { failed(() => void list(path, title, empty, back)); }
  }

  function paintTree(): void {
    if (!tree) return;
    const search = el('input', { type: 'search', class: 'fb-tree-search', placeholder: kt('Buscar en el mapa'), 'aria-label': kt('Buscar en el mapa'), value: query }) as HTMLInputElement;
    search.addEventListener('input', () => { query = search.value; const pos = search.selectionStart; paintTree(); const again = body.querySelector<HTMLInputElement>('.fb-tree-search'); again?.focus(); again?.setSelectionRange(pos, pos); });
    const counts = (b: Branch) => el('span', { class: 'fb-counts' },
      b.open ? el('span', { class: 'fb-count', title: kt('Abiertos') }, String(b.open)) : null,
      b.pendingVerify ? el('span', { class: 'fb-count verify', title: kt('Pendientes de verificar') }, icon('check', 12), String(b.pendingVerify)) : null);
    const openNode = (b: Branch, trail: string[]) => {
      if (b.nodeId) void list(`/feedback?node=${encodeURIComponent(b.nodeId)}&status=all&limit=50`, trail.join(' › '), kt('Sin reportes en este punto.'), () => void show('map'));
    };
    const row = (b: Branch, trail: string[], depth: number): HTMLElement => {
      const kids = [...b.children.values()];
      const isOpen = expanded.has(b.key);
      return el('li', { class: 'fb-branch', dataset: { node: b.nodeId ?? '' } },
        el('div', { class: 'fb-branch-row', style: `--depth:${depth}` },
          kids.length
            ? el('button', { type: 'button', class: 'iconbtn small fb-toggle', 'aria-expanded': String(isOpen), 'aria-label': isOpen ? kt('Plegar {name}', { name: b.label }) : kt('Desplegar {name}', { name: b.label }), onclick: () => { if (isOpen) expanded.delete(b.key); else expanded.add(b.key); paintTree(); } }, icon(isOpen ? 'chevronDown' : 'chevronRight', 16))
            : el('span', { class: 'fb-toggle-spacer' }),
          el('button', { type: 'button', class: 'fb-branch-label', onclick: () => (b.nodeId ? openNode(b, trail) : (expanded.has(b.key) ? expanded.delete(b.key) : expanded.add(b.key), paintTree())) }, b.label),
          counts(b)),
        kids.length && isOpen ? el('ul', { class: 'fb-tree' }, ...kids.map((k) => row(k, [...trail, k.label], depth + 1))) : null);
    };
    let content: HTMLElement;
    const q = query.trim().toLocaleLowerCase('es');
    if (q) {
      const hits: HTMLElement[] = [];
      const walk = (b: Branch, trail: string[]) => {
        for (const k of b.children.values()) {
          const t = [...trail, k.label];
          if (k.nodeId && t.join(' ').toLocaleLowerCase('es').includes(q)) hits.push(el('li', { class: 'fb-branch', dataset: { node: k.nodeId } }, el('div', { class: 'fb-branch-row' }, el('button', { type: 'button', class: 'fb-branch-label', onclick: () => openNode(k, t) }, t.join(' › ')), counts(k))));
          walk(k, t);
        }
      };
      walk(tree, []);
      content = hits.length ? el('ul', { class: 'fb-tree' }, ...hits) : el('p', { class: 'hint fb-empty' }, kt('Nada coincide.'));
    } else {
      content = tree.children.size ? el('ul', { class: 'fb-tree', role: 'tree' }, ...[...tree.children.values()].map((k) => row(k, [k.label], 0))) : el('p', { class: 'hint fb-empty' }, kt('Todavía no hay reportes en esta app.'));
    }
    replace(body, search, content);
  }

  async function showDrafts(): Promise<void> {
    if (!options.feedback) { replace(body, el('p', { class: 'hint fb-empty' }, kt('Los borradores se guardan en cada dispositivo.'))); return; }
    const drafts = await options.feedback.drafts();
    replace(body, drafts.length
      ? el('div', { class: 'fb-cards' }, ...drafts.map((d) => el('button', {
        type: 'button', class: 'fb-card draft', dataset: { draft: d.id },
        onclick: () => { options.onLeave?.(); void options.feedback!.openDraft(d); },
      },
        el('span', { class: 'fb-card-head' }, el('strong', null, d.nodePath.join(' › ')), el('span', { class: 'chip small pending' }, el('span', null, kt('Borrador')))),
        el('span', { class: 'fb-card-msg' }, d.message || (d.images.length ? kt('{count} imagen(es) sin texto', { count: d.images.length }) : '')),
        el('span', { class: 'fb-card-meta' }, el('span', null, when(d.updatedAt))))))
      : el('p', { class: 'hint fb-empty' }, kt('No tienes borradores en este dispositivo.')));
  }

  async function show(next: FeedbackCenterTab): Promise<void> {
    tab = next;
    paintTabs();
    if (tab === 'open') return list(`/feedback?status=open&${appQ}&limit=50`, null, kt('No hay reportes abiertos.'));
    if (tab === 'verify') return list(`/feedback?status=pending_verify&${appQ}&limit=50`, null, kt('Nada pendiente de verificar.'));
    if (tab === 'drafts') return showDrafts();
    loading();
    try {
      const { nodes } = await options.api<{ nodes: FeedbackTreeNode[] }>(`/feedback/tree?${appQ}`);
      tree = buildFeedbackTree(nodes ?? []);
      paintTree();
    } catch { failed(() => void show('map')); }
  }

  async function showReport(id: string, back?: () => void): Promise<void> {
    loading();
    let detail: FeedbackReportDetail;
    try { detail = await options.api<FeedbackReportDetail>(`/feedback/${encodeURIComponent(id)}`); } catch { failed(() => void showReport(id, back)); return; }
    const r = detail.report;
    const editor = !!options.canEdit?.();
    const status = el('p', { class: 'fb-status', role: 'status' });
    const reload = () => void showReport(id, back);
    const act = async (path: string, json: unknown, done: string) => {
      try { await options.api(`/feedback/${encodeURIComponent(r.id)}/${path}`, { method: 'POST', json }); toast(done); reload(); }
      catch { status.textContent = kt('No se pudo guardar. Prueba otra vez con conexión.'); status.className = 'fb-status error'; }
    };
    const reason = el('textarea', { class: 'fb-message', rows: '2', maxlength: '500', placeholder: kt('Motivo (lo verá quien lo informó)'), 'aria-label': kt('Motivo para descartar'), hidden: true }) as HTMLTextAreaElement;
    const dismiss = el('button', { type: 'button', class: 'ghost fb-dismiss' }, kt('Descartar'));
    dismiss.addEventListener('click', () => {
      if (reason.hidden) { reason.hidden = false; dismiss.textContent = kt('Confirmar descarte'); reason.focus(); return; }
      if (!reason.value.trim()) { reason.focus(); return; }
      void act('dismiss', { reason: reason.value.trim() }, kt('Descartado.'));
    });
    const canVerify = (r.mine || editor) && r.display === 'pending_verify';
    const canReopen = (r.mine || editor) && (r.display === 'pending_verify' || r.display === 'verified' || r.display === 'dismissed');
    replace(body,
      el('button', { type: 'button', class: 'linkbtn fb-back', onclick: () => (back ? back() : void show(tab)) }, icon('chevronLeft', 16), kt('Volver')),
      el('article', { class: 'fb-detail', dataset: { report: r.id } },
        el('header', { class: 'fb-card-head' },
          el('strong', { class: 'fb-code' }, r.code),
          el('span', { class: 'fb-card-intent' }, FEEDBACK_INTENT_LABELS[r.intent as FeedbackIntent] ? kt(FEEDBACK_INTENT_LABELS[r.intent as FeedbackIntent]) : r.intent),
          r.blocking ? el('span', { class: 'chip small alert' }, el('span', null, kt('Me bloquea'))) : null,
          reportChip(r.display)),
        r.node ? el('p', { class: 'fb-detail-path' }, r.node.path.join(' › ')) : null,
        el('p', { class: 'fb-detail-msg' }, r.message),
        el('p', { class: 'fb-card-meta' },
          el('span', null, when(r.createdAt)),
          r.supportersCount > 1 ? el('span', null, kt('{count} personas', { count: r.supportersCount })) : null,
          r.releasedBuild && !r.verifiedBuild ? el('span', null, kt('Corregido en {build}', { build: r.releasedBuild })) : null,
          r.verifiedBuild ? el('span', null, kt('Verificado en {build}', { build: r.verifiedBuild })) : null),
        detail.attachments?.length ? el('div', { class: 'fb-images' }, ...detail.attachments.map((a) => el('a', { class: 'fb-thumb', href: a.url, target: '_blank', rel: 'noopener' }, el('img', { src: a.url, alt: kt('Imagen adjunta'), loading: 'lazy' })))) : null,
        detail.tasks?.length ? el('ul', { class: 'fb-tasks' }, ...detail.tasks.map((t) => el('li', null, kt('Tarea {id} · {status}', { id: t.sequence ?? t.taskId, status: t.status })))) : null,
        detail.agentBlock ? el('div', { class: 'fb-agent' },
          el('button', { type: 'button', class: 'ghost fb-copy', onclick: async () => { toast((await copyText(detail.agentBlock!)) ? kt('Copiado: pégalo en Claude.') : kt('No se pudo copiar.')); } }, icon('copy', 16), kt('Copiar para Claude')),
          el('button', { type: 'button', class: 'ghost fb-download', onclick: () => download(`${r.code}.md`, detail.agentBlock!) }, icon('download', 16), kt('Descargar .md'))) : null,
        reason, status,
        el('div', { class: 'fb-foot' },
          editor && r.status === 'open' ? dismiss : null,
          canReopen ? el('button', { type: 'button', class: 'ghost fb-reopen', onclick: () => void act('reopen', {}, kt('Reabierto.')) }, kt('Sigue fallando')) : null,
          canVerify ? el('button', { type: 'button', class: 'primary fb-verify-btn', onclick: async () => void act('verify', { build: (await appVersion())?.release ?? null }, kt('Verificado.')) }, kt('Funciona')) : null)));
  }

  paintTabs();
  if (options.reportId) void showReport(options.reportId);
  else void show(tab);
  return { element, show, showReport: (id) => showReport(id) };
}

/** Abre el centro en una hoja (entrada «Sugerencias y QA» del menú). */
export function openFeedbackCenter(options: FeedbackCenterOptions): Sheet {
  let sheet: Sheet | null = null;
  const center = renderFeedbackCenter({ ...options, onLeave: () => { void sheet?.close(true); options.onLeave?.(); } });
  sheet = openSheet({ title: kt('Sugerencias y QA'), body: center.element, container: options.container?.() });
  return sheet;
}
