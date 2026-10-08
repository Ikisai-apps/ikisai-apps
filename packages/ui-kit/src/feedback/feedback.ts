/**
 * Feedback en una app interna (especificación §2–§2.6, §18; FEEDBACK.md §6 y §8).
 * - **Modo «Señalar para comentar»** (§8.1), por persona y dispositivo, apagado por defecto. Apagado: ni gesto ni pines,
 *   la app se comporta como siempre. Encendido: la pulsación mantenida (o Mayúsculas+F10) señala, se ven los pines y
 *   `html.fb-mode` deja una marca discreta en la cabecera. Se cambia desde el lanzador (`createAppLauncher({ feedback })`).
 * - **Borradores**: salir con contenido deja un borrador local (IndexedDB) y un pin sobre el elemento; vacío no guarda nada.
 * - **Enviar**: pasa a la bandeja y se envía; sin red, «Pendiente de enviar». Si el servidor lo rechaza para siempre,
 *   vuelve a ser borrador con el motivo.
 * - **Pin verde** (§8.4) sobre los nodos con reportes corregidos: «Esto ya está corregido. ¿Lo compruebas?», con
 *   «Funciona» (`verify`) y «Sigue fallando» (`reopen`).
 * - `clear(userId)` borra borradores y bandeja de una cuenta (`onSessionEnd` de `sync-client`).
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { trapFocus } from '../overlay/focus.ts';
import { toast } from '../toast.ts';
import { createFeedbackClient, type FeedbackApi, type FeedbackClient, type FeedbackReport } from './client.ts';
import { openFeedbackComposer, type ComposerValue, type FeedbackComposer } from './composer.ts';
import type { FeedbackIntent } from './constants.ts';
import { appVersion, collectFeedbackContext, observeFeedbackContext, setFeedbackStepNode, type FeedbackContextInput } from './context.ts';
import { installFeedbackGesture, type FeedbackGesture } from './gesture.ts';
import { ensureFeedbackGlobalStyles, syncMarkHint } from './global-style.ts';
import { resolveFeedbackNode, type FeedbackNode } from './node.ts';
import { clearFeedbackForUser, feedbackDrafts, feedbackOutbox, type FeedbackDraft, type FeedbackOutboxItem } from './store.ts';
import { kt } from '../i18n/i18n.ts';
import { kitLayer } from '../layer.ts';

export interface FeedbackOptions {
  app: string;
  api: FeedbackApi;
  userId: () => string | null;
  role?: () => string | null;
  /** Estado de sincronización (`sync-client` `getSyncSummary()`) para el contexto. */
  syncSummary?: () => FeedbackContextInput['sync'];
  /** Nodo de reserva cuando no hay `data-feedback-id` en la cadena (página o sección). */
  fallbackNode?: () => { id: string; path: string[] };
  intents?: FeedbackIntent[];
  /** Capa donde montar el composer y los pines (en Tasks, `#kitLayer`); por defecto `document.body`. */
  container?: () => HTMLElement;
  fetchImpl?: typeof fetch;
  onSent?: (report: FeedbackReport) => void;
}

export interface FeedbackMode {
  get(): boolean;
  set(on: boolean): void;
  onChange(listener: (on: boolean) => void): () => void;
}

export interface Feedback {
  /** Modo «Señalar para comentar» (por persona y dispositivo). */
  mode: FeedbackMode;
  /** Abre el composer sobre el elemento (sube hasta el `data-feedback-id` más cercano). */
  signal(element: Element): Promise<FeedbackComposer>;
  /** Abre el composer para un nodo concreto (p. ej. desde una entrada de menú). */
  open(node: FeedbackNode, anchor?: Element | null): Promise<FeedbackComposer>;
  /** Reabre un borrador (p. ej. desde «Mis borradores» del centro). */
  openDraft(draft: FeedbackDraft): Promise<FeedbackComposer>;
  drafts(): Promise<FeedbackDraft[]>;
  pending(): Promise<FeedbackOutboxItem[]>;
  flush(): Promise<void>;
  /** Vuelve a pedir los reportes pendientes de verificar (pin verde). */
  refreshVerify(): Promise<void>;
  /** Borra borradores y bandeja de la cuenta (al cerrar sesión o cambiar de usuario). */
  clear(userId: string): Promise<void>;
  refreshPins(): void;
  destroy(): void;
}

const newId = () => crypto.randomUUID();
const ERROR_TEXT: Record<string, string> = {
  FEEDBACK_RATE_LIMITED: 'Has llegado al máximo de comentarios de hoy. Se queda guardado como borrador.',
  FEEDBACK_TOO_MANY_ATTACHMENTS: 'Como mucho 3 imágenes por comentario.',
  FEEDBACK_MESSAGE_TOO_LONG: 'El comentario es demasiado largo (4000 caracteres como mucho).',
  FEEDBACK_ATTACHMENT_INVALID: 'Una de las imágenes no es válida.',
  OUT_OF_SCOPE: 'No tienes acceso a esto.',
};
/** Texto de un código de error conocido (traducido al momento) o el de reserva ya traducido. */
const errorText = (code: string | undefined, fallback: string): string => { const known = ERROR_TEXT[code ?? '']; return known ? kt(known) : fallback; };
const VERIFY_EVERY_MS = 5 * 60_000;

export function createFeedback(options: FeedbackOptions): Feedback {
  observeFeedbackContext();
  if (options.fallbackNode) setFeedbackStepNode(() => options.fallbackNode?.().id);
  ensureFeedbackGlobalStyles();
  const host = () => kitLayer(options.container?.());
  const pinLayer = el('div', { class: 'ikisai-fb-layer fb-pins', 'aria-label': kt('Comentarios sobre la pantalla') });
  let current: FeedbackComposer | null = null;
  let currentVerify: (() => void) | null = null;
  let frame = 0;
  let gesture: FeedbackGesture | null = null;
  let verifyList: FeedbackReport[] = [];
  /** Mis reportes abiertos (pin «tus sugerencias aquí»: FB_2026_002, el usuario espera ver marcado lo que ya envió). */
  let mineList: FeedbackReport[] = [];
  let paintRun = 0;
  let verifyTimer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(on: boolean) => void>();
  const modeKey = () => `ikisai-feedback-mode:${options.app}:${options.userId() ?? ''}`;

  const client: FeedbackClient = createFeedbackClient({
    api: options.api, app: options.app, userId: options.userId, fetchImpl: options.fetchImpl,
    onChange: () => { void backToDraftOnFailure(); refreshPins(); },
    onSent: (report) => { toast(kt('Enviado · {code}', { code: report.code })); options.onSent?.(report); void refreshVerify(); },
  });

  // --- Modo «Señalar para comentar» --------------------------------------------------------------
  function modeOn(): boolean {
    try { return localStorage.getItem(modeKey()) === '1'; } catch { return false; }
  }
  function applyMode(): void {
    const on = modeOn();
    document.documentElement.classList.toggle('fb-mode', on);
    syncMarkHint();
    if (on && !gesture) gesture = installFeedbackGesture({ onSignal: (target) => { void signal(target); }, enabled: () => modeOn() && !current && !currentVerify && !document.documentElement.classList.contains('fb-capturing') });
    if (!on && gesture) { gesture.destroy(); gesture = null; }
    if (on && !verifyTimer) { void refreshVerify(); verifyTimer = setInterval(() => void refreshVerify(), VERIFY_EVERY_MS); }
    if (!on && verifyTimer) { clearInterval(verifyTimer); verifyTimer = null; }
    refreshPins();
  }
  const mode: FeedbackMode = {
    get: modeOn,
    set(on) {
      try { if (on) localStorage.setItem(modeKey(), '1'); else localStorage.removeItem(modeKey()); } catch { /* sin almacenamiento */ }
      applyMode();
      if (on) toast(kt('Señalar para comentar: activo. Mantén pulsado cualquier elemento para comentarlo; el punto amarillo de la marca lo recuerda.'));
      for (const l of listeners) l(on);
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };

  /** Lo que el servidor rechazó para siempre vuelve a ser borrador, con el motivo. */
  async function backToDraftOnFailure(): Promise<void> {
    for (const item of await client.pending()) {
      if (!item.failed) continue;
      const { requestId, context, scope, category, attempts, lastError, failed, ...draft } = item;
      void requestId; void context; void scope; void category; void attempts; void failed;
      await feedbackDrafts.put({ ...draft, updatedAt: new Date().toISOString() });
      await feedbackOutbox.delete(item.id);
      toast(errorText(lastError, kt('No se pudo enviar el comentario. Se queda como borrador.')));
    }
  }

  async function drafts(): Promise<FeedbackDraft[]> {
    const user = options.userId();
    return user ? feedbackDrafts.list(user, options.app) : [];
  }

  async function refreshVerify(): Promise<void> {
    if (modeOn()) [verifyList, mineList] = await Promise.all([client.pendingVerify(), client.mine()]);
    else { verifyList = []; mineList = []; }
    refreshPins();
  }

  // --- Pines ------------------------------------------------------------------------------------------
  /**
   * Dónde va el pin de un nodo: el primer elemento **visible** con ese id (una app puede tener copias ocultas para otro
   * tamaño de pantalla), arriba a la derecha. `slot` separa los pines de un mismo nodo para que no se tapen.
   */
  function pinFor(nodeId: string, slot = 0): { target: Element; style: string } | null {
    let target: Element | null = null;
    let rect: DOMRect | null = null;
    for (const candidate of document.querySelectorAll(`[data-feedback-id="${CSS.escape(nodeId)}"]`)) {
      const r = candidate.getBoundingClientRect();
      if (r.width || r.height) { target = candidate; rect = r; break; }
    }
    if (!target || !rect) return null;
    const left = Math.max(4, Math.min(innerWidth - 44, rect.right - 18) - slot * 46);
    return { target, style: `left:${left}px;top:${Math.max(4, rect.top - 10)}px` };
  }
  function refreshPins(): void {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(async () => {
      // Solo pinta la última pasada: una anterior que termine tarde (lectura de IndexedDB lenta) no pisa a la nueva.
      const run = ++paintRun;
      if (!pinLayer.isConnected) host().appendChild(pinLayer);
      if (!modeOn()) { replace(pinLayer); return; }
      const byNode = new Map<string, FeedbackDraft[]>();
      for (const d of await drafts()) byNode.set(d.nodeId, [...(byNode.get(d.nodeId) ?? []), d]);
      if (run !== paintRun) return;
      const slots = new Map<string, number>();
      const slot = (nodeId: string) => { const n = slots.get(nodeId) ?? 0; slots.set(nodeId, n + 1); return n; };
      const pins: HTMLElement[] = [];
      for (const [nodeId, items] of byNode) {
        const at = pinFor(nodeId, slot(nodeId));
        if (!at) continue;
        pins.push(el('button', {
          type: 'button', class: 'fb-pin draft', dataset: { node: nodeId }, style: at.style,
          'aria-label': kt('Borrador de comentario ({count}) sobre {path}', { count: items.length, path: items[0]!.nodePath.join(' › ') }),
          onclick: () => { void compose({ id: nodeId, path: items[0]!.nodePath, element: at.target }, at.target, items[0]); },
        }, icon('pin', 14), el('span', null, String(items.length))));
      }
      const mineByNode = new Map<string, FeedbackReport[]>();
      for (const r of mineList) if (r.node?.id) mineByNode.set(r.node.id, [...(mineByNode.get(r.node.id) ?? []), r]);
      for (const [nodeId, reports] of mineByNode) {
        const at = pinFor(nodeId, slot(nodeId));
        if (!at) continue;
        pins.push(el('button', {
          type: 'button', class: 'fb-pin mine', dataset: { node: nodeId, mine: String(reports.length) }, style: at.style,
          'aria-label': kt('Tus sugerencias abiertas aquí ({count}): toca para verlas o añadir otra', { count: reports.length }),
          onclick: () => { void compose({ id: nodeId, path: reports[0]!.node!.path, element: at.target }, at.target); },
        }, icon('edit', 14), el('span', null, String(reports.length))));
      }
      for (const report of verifyList) {
        if (!report.node) continue;
        const at = pinFor(report.node.id, slot(report.node.id));
        if (!at) continue;
        pins.push(el('button', {
          type: 'button', class: 'fb-pin verify', dataset: { node: report.node.id, report: report.id }, style: at.style,
          'aria-label': kt('Corregido: {code}. ¿Lo compruebas?', { code: report.code }),
          onclick: () => openVerify(report, at.target),
        }, icon('check', 14), el('span', null, kt('¿Ya va?'))));
      }
      replace(pinLayer, ...pins);
    });
  }

  // --- «Esto ya está corregido. ¿Lo compruebas?» -------------------------------------------------------
  function openVerify(report: FeedbackReport, anchor: Element): void {
    currentVerify?.();
    const note = el('textarea', { class: 'fb-message', rows: '3', maxlength: '4000', placeholder: kt('¿Qué sigue pasando? (opcional)'), 'aria-label': kt('Qué sigue fallando'), hidden: true }) as HTMLTextAreaElement;
    const status = el('p', { class: 'fb-status', role: 'status' });
    const works = el('button', { type: 'button', class: 'primary fb-works' }, kt('Funciona'));
    const fails = el('button', { type: 'button', class: 'ghost fb-fails' }, kt('Sigue fallando'));
    const panel = el('section', { class: 'fb-composer fb-verify', role: 'dialog', 'aria-modal': 'true', 'aria-label': kt('Comprobar una corrección'), tabindex: '-1' },
      el('header', { class: 'fb-head' },
        el('div', { class: 'fb-where' }, el('small', null, `${report.code}${report.node ? ` · ${report.node.path.join(' › ')}` : ''}`), el('strong', null, kt('Esto ya está corregido. ¿Lo compruebas?'))),
        el('button', { type: 'button', class: 'iconbtn small fb-close', 'aria-label': kt('Cerrar'), onclick: () => close() }, icon('close', 18))),
      el('p', { class: 'fb-quote' }, report.message.slice(0, 280)),
      note, status,
      el('div', { class: 'fb-foot' }, fails, works));
    const layer = el('div', { class: 'ikisai-fb-layer fb-layer' }, el('div', { class: 'fb-catcher', onclick: () => close() }), panel);
    host().appendChild(layer);
    const rect = anchor.getBoundingClientRect();
    layer.classList.toggle('sheet-mode', innerWidth < 720);
    if (innerWidth >= 720) { panel.style.left = `${Math.min(Math.max(12, rect.left), innerWidth - 392)}px`; panel.style.top = `${Math.min(rect.bottom + 8, innerHeight - 260)}px`; }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } else if (e.key === 'Tab') trapFocus(e, panel); };
    document.addEventListener('keydown', onKey, true);
    function close(): void { document.removeEventListener('keydown', onKey, true); layer.remove(); currentVerify = null; }
    currentVerify = close;
    const act = async (run: () => Promise<void>, done: string) => {
      works.disabled = fails.disabled = true;
      try { await run(); verifyList = verifyList.filter((r) => r.id !== report.id); refreshPins(); close(); toast(done); }
      catch { works.disabled = fails.disabled = false; status.textContent = kt('No se pudo guardar. Prueba otra vez con conexión.'); status.className = 'fb-status error'; }
    };
    works.addEventListener('click', () => void act(async () => client.verify(report.id, (await appVersion())?.release ?? null), kt('Gracias: queda verificado.')));
    fails.addEventListener('click', () => {
      if (note.hidden) { note.hidden = false; fails.textContent = kt('Enviar: sigue fallando'); note.focus(); return; }
      void act(() => client.reopen(report.id, note.value.trim() || undefined), kt('Reabierto: vuelve a la lista de pendientes.'));
    });
    works.focus();
  }

  // --- Composer ---------------------------------------------------------------------------------------
  async function compose(node: FeedbackNode, anchor: Element | null | undefined, existing?: FeedbackDraft): Promise<FeedbackComposer> {
    current?.close();
    const user = options.userId();
    let draftId = existing?.id ?? newId();
    /**
     * Un mismo `id` y `requestId` por composer mientras el contenido no cambie: un segundo toque o un reintento no crean
     * un duplicado (el servidor deduplica). Si tras un fallo se cambia el texto, van nuevos (si no, la huella no casaría).
     */
    let attempt: { requestId: string; key: string } | null = null;
    const saveDraft = async (value: ComposerValue) => {
      if (!user) return;
      await feedbackDrafts.put({ id: draftId, userId: user, app: options.app, nodeId: node.id, nodePath: node.path, message: value.message, intent: value.intent, blocking: value.blocking, subject: 'application', images: value.images, updatedAt: new Date().toISOString() });
      refreshPins();
    };
    current = openFeedbackComposer({
      node, anchor: anchor ?? node.element, container: host(), intents: options.intents,
      initial: existing ? { message: existing.message, intent: existing.intent, images: existing.images, blocking: !!existing.blocking } : undefined,
      openReports: client.openReports(node.id),
      onSupport: (report) => client.support(report.id),
      onClose: (value) => {
        current = null;
        if (value) void saveDraft(value);
        else if (existing) void feedbackDrafts.delete(existing.id).then(refreshPins);
      },
      onSend: async (value) => {
        if (!user) throw new Error(kt('Inicia sesión para enviar comentarios.'));
        const item: FeedbackOutboxItem = {
          id: draftId, requestId: '', userId: user, app: options.app, nodeId: node.id, nodePath: node.path,
          message: value.message, intent: value.intent, blocking: value.blocking, subject: 'application', images: value.images, updatedAt: new Date().toISOString(),
          context: await collectFeedbackContext({ app: options.app, node, role: options.role?.(), sync: options.syncSummary?.() }), attempts: 0,
        };
        const key = JSON.stringify([value.message, value.intent, !!value.blocking, value.images.map((i) => i.id)]);
        if (attempt && attempt.key !== key) { draftId = newId(); item.id = draftId; attempt = null; }
        attempt ??= { requestId: newId(), key };
        item.requestId = attempt.requestId;
        await feedbackDrafts.delete(existing?.id ?? draftId);
        await client.enqueue(item);
        current = null;
        refreshPins();
        const still = (await client.pending()).find((i) => i.id === item.id);
        if (!still) return 'sent';
        if (still.failed) throw new Error(errorText(still.lastError, kt('No se pudo enviar.')));
        return 'pending';
      },
    });
    return current;
  }
  const signal = (element: Element) => compose(resolveFeedbackNode(element, options.fallbackNode), element);

  const onLayout = () => { if (modeOn()) refreshPins(); };
  const onNavigate = () => { if (modeOn()) setTimeout(() => { refreshPins(); syncMarkHint(); }, 60); };
  const onVisible = () => { if (document.visibilityState === 'visible' && modeOn()) void refreshVerify(); };
  window.addEventListener('popstate', onNavigate);
  window.addEventListener('hashchange', onNavigate);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('resize', onLayout);
  window.addEventListener('scroll', onLayout, { capture: true, passive: true });
  // Solo cambios de la página: los de los pines y del composer no cuentan (si no, se repintarían sin fin).
  const observer = new MutationObserver((records) => {
    if (!modeOn()) return;
    if (records.some((r) => !(r.target instanceof Element) || (!r.target.closest('.ikisai-fb-layer') && !r.target.classList.contains('ikisai-fb-layer')))) refreshPins();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  applyMode();

  return {
    mode,
    signal,
    open: (node, anchor) => compose(node, anchor),
    openDraft(draft) {
      const element = document.querySelector(`[data-feedback-id="${CSS.escape(draft.nodeId)}"]`);
      return compose({ id: draft.nodeId, path: draft.nodePath, element }, element, draft);
    },
    drafts,
    pending: () => client.pending(),
    flush: () => client.flush(),
    refreshVerify,
    async clear(userId) { current?.close(); await clearFeedbackForUser(userId); refreshPins(); },
    refreshPins,
    destroy() {
      client.destroy(); gesture?.destroy(); observer.disconnect(); if (verifyTimer) clearInterval(verifyTimer);
      window.removeEventListener('resize', onLayout); window.removeEventListener('popstate', onNavigate); window.removeEventListener('hashchange', onNavigate); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('scroll', onLayout, { capture: true } as EventListenerOptions);
      pinLayer.remove(); current?.close(); currentVerify?.(); document.documentElement.classList.remove('fb-mode');
    },
  };
}
