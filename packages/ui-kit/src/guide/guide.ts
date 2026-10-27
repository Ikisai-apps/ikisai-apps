/**
 * Guiado completo (decisión de VG del 27-10; `MUELA/equipo/feedback/flow/GUIADO.md`, traspaso de Flow v03 §1.3 y §11.4):
 * acompaña sobre los controles reales de la app. No bloquea nada: la persona puede trabajar libremente y volver a la guía.
 * - Cada paso señala su anclaje (`anchor`, un id del inventario) con un foco que lo sigue, y una burbuja lo explica:
 *   «Paso 2 de 5», el título, la explicación y lo que toca hacer.
 * - **Avanza solo con la confirmación real**: `confirm: 'save' | 'event'` espera el aviso de guardado de ese campo
 *   (`onSaved`, que nunca lleva valores). `manual` pide «Hecho» a la persona (p. ej. «Revisa el resumen»). `none` solo
 *   informa y tiene «Siguiente».
 * - Lo ya hecho fuera de la guía no se repregunta: `load()` devuelve los pasos con `done`, y se vuelve a llamar al volver a
 *   la pestaña, al desplegar la guía y con `refresh()`. Quien guía (Flow) reconsulta al sistema dueño.
 * - Si el anclaje no está en pantalla, se pide a la app (`registerReveal`). Si sigue sin estar, lo dice y ofrece «Ir allí»
 *   con la ruta del paso.
 * - «Ocultar» la deja en una píldora («Guía · paso 2 de 5»). «Volver a…» lleva a quien guía (la convención K9).
 * - En modo `learn` lo dice («Practicando»): una app que guarda sola no es sitio para practicar, y eso lo decide Flow.
 * - Guardado sin red (`pending`): el paso avanza y, cuando ese campo se guarda de verdad, se vuelve a confirmar sin `pending`.
 * - En el móvil, mientras se escribe en la app (foco en un campo o teclado abierto), la burbuja se queda en una tira arriba,
 *   bajo la cabecera, con el paso y su título: no tapa el campo, ni el teclado, ni «Guardar». Al salir del campo vuelve abajo
 *   (si se está pulsando algo, espera a soltar, para no mover el botón bajo el dedo).
 * Prefijo de clases: `guia-`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { icon } from '../icons.ts';
import { currentReturnTo, clearReturnTo } from '../shell/return-to.ts';
import { findAnchor, onSaved, pointAt, revealAnchor } from './anchors.ts';
import { clearGuideLink } from './link.ts';

export type GuideConfirm = 'save' | 'event' | 'manual' | 'none';

export interface GuideStep {
  id: string;
  title: string;
  explain?: string | null;
  /** Id del inventario (`data-field-id` o `data-feedback-id`). Sin anclaje, el paso solo se explica. */
  anchor?: string | null;
  /** Ruta de la pantalla del anclaje (`#/reservas/123`), para «Ir allí». */
  route?: string | null;
  /** Por defecto: `save` si hay anclaje, `manual` si no. */
  confirm?: GuideConfirm;
  /** Ya está hecho (lo dice quien guía tras reconsultar). */
  done?: boolean;
  /** Los no esenciales se pueden saltar. */
  essential?: boolean;
}

export interface GuideRun {
  id: string;
  title: string;
  mode?: 'learn' | 'run';
  steps: GuideStep[];
}

export interface GuideOptions {
  /** Lee la ejecución (de Flow): se llama al empezar y cada vez que hay que recalcular lo pendiente. */
  load: () => Promise<GuideRun>;
  /** Un paso se confirmó aquí (guardado de verdad o «Hecho»): quien guía lo registra. */
  onConfirmed?: (step: GuideStep, info: { pending: boolean; how: GuideConfirm }) => Promise<unknown> | void;
  /** Un paso se saltó (solo los no esenciales). */
  onSkipped?: (step: GuideStep) => Promise<unknown> | void;
  /** «Ir allí»: por defecto cambia `location.hash`. */
  navigate?: (route: string) => void;
  /** «Volver a…»: por defecto, el origen guardado (K9). */
  returnTo?: { url: string; title: string | null } | null;
  /** Se cerró la guía («Salir»). */
  onExit?: () => void;
  /** Recalcular al volver a la pestaña (por defecto sí). */
  refreshOnFocus?: boolean;
  feedbackId?: string;
}

export interface Guide {
  element: HTMLElement;
  start(): Promise<void>;
  /** Vuelve a leer la ejecución y va al primer paso pendiente. */
  refresh(): Promise<void>;
  current(): GuideStep | null;
  minimize(): void;
  expand(): void;
  destroy(): void;
}

const confirmOf = (s: GuideStep): GuideConfirm => s.confirm ?? (s.anchor ? 'save' : 'manual');

export function createGuide(options: GuideOptions): Guide {
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const navigate = options.navigate ?? ((route: string) => { location.hash = route; });
  let run: GuideRun | null = null;
  /** Confirmados o saltados aquí, hasta que la siguiente lectura lo diga. */
  const local = new Set<string>();
  let at = -1;
  /** Paso ya hecho al que se ha vuelto con «Anterior» para cambiarlo. */
  let revisit: string | null = null;
  let minimized = false;
  let destroyed = false;
  let anchorNode: HTMLElement | null = null;
  let frame = 0;
  let seq = 0;
  /** Confirmados con `pending` (guardados sin red): se reconfirman cuando ese campo se guarda de verdad. */
  const unsynced = new Set<string>();

  const ring = el('div', { class: 'guia-ring', 'aria-hidden': 'true', hidden: true });
  const bubble = el('section', { class: 'guia-bubble', role: 'region', 'aria-label': kt('Guía'), ...(base ? { 'data-feedback-id': base, 'data-feedback-label': 'Guía' } : {}) });
  const pill = el('button', { type: 'button', class: 'guia-pill', hidden: true, ...mark('desplegar', 'Desplegar la guía'), onclick: () => api.expand() });
  const element = el('div', { class: 'guia-root' }, ring, bubble, pill);
  const status = () => bubble.querySelector<HTMLElement>('.guia-live');

  const pendingOf = (r: GuideRun) => r.steps.map((s, i) => ({ s, i })).filter(({ s }) => !s.done && !local.has(s.id));
  const isPending = (s: GuideStep) => !s.done && !local.has(s.id);
  const open = (s: GuideStep) => isPending(s) || s.id === revisit;

  function say(text: string): void { const s = status(); if (s) s.textContent = text; }

  function follow(): void {
    cancelAnimationFrame(frame);
    if (!anchorNode || minimized || destroyed) { ring.hidden = true; return; }
    const tick = () => {
      if (!anchorNode || !anchorNode.isConnected) { ring.hidden = true; return; }
      const r = anchorNode.getBoundingClientRect();
      ring.hidden = !(r.width || r.height);
      ring.style.cssText = `top:${r.top - 6}px;left:${r.left - 6}px;width:${r.width + 12}px;height:${r.height + 12}px`;
      frame = requestAnimationFrame(tick);
    };
    tick();
  }

  async function locate(step: GuideStep, focus: boolean): Promise<void> {
    const mine = ++seq;
    anchorNode = null;
    follow();
    if (!step.anchor) return;
    const node = findAnchor(step.anchor) ?? await revealAnchor(step.anchor);
    if (mine !== seq || destroyed) return;
    if (!node) {
      bubble.dataset.found = 'false';
      say(kt('No encuentro este paso en esta pantalla.'));
      const go = bubble.querySelector<HTMLElement>('.guia-go');
      if (go) go.hidden = !step.route;
      return;
    }
    bubble.dataset.found = 'true';
    anchorNode = node;
    // Arriba, bajo la cabecera de la app: abajo está la burbuja (y lo que sigue al campo, como «Guardar», queda a la vista).
    pointAt(node, { focus, block: 'start', marginTop: (document.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect().height ?? 0) + 72 });
    follow();
  }

  function paint(focus: boolean): void {
    if (!run) return;
    const steps = run.steps;
    const pend = pendingOf(run);
    if (!pend.length && !(revisit && steps.some((s) => s.id === revisit))) {
      anchorNode = null; follow();
      at = -1;
      replace(bubble,
        el('p', { class: 'guia-meta' }, run.title),
        el('h2', { class: 'guia-title', tabindex: '-1' }, el('span', { class: 'step-check', 'aria-hidden': 'true' }, '✓'), kt('Todo hecho')),
        el('p', { class: 'guia-explain' }, kt('Ya están todos los pasos de esta guía.')),
        el('p', { class: 'guia-live', role: 'status', 'aria-live': 'polite' }),
        el('div', { class: 'guia-actions' }, backLink(true), el('button', { type: 'button', class: 'ghost', ...mark('salir', 'Salir de la guía'), onclick: () => exit() }, kt('Cerrar la guía'))));
      paintPill();
      if (focus) bubble.querySelector<HTMLElement>('.guia-title')?.focus();
      return;
    }
    if (revisit) at = steps.findIndex((s) => s.id === revisit);
    if (at < 0 || at >= steps.length || !open(steps[at]!)) at = pend[0]!.i;
    const step = steps[at]!;
    const n = steps.slice(0, at + 1).length;
    const how = confirmOf(step);
    const prev = steps.slice(0, at).map((s, i) => ({ s, i })).reverse()[0];
    const waiting = how === 'save' || how === 'event';
    bubble.dataset.step = step.id;
    bubble.dataset.found = step.anchor ? 'pending' : 'none';
    replace(bubble,
      el('div', { class: 'guia-head' },
        el('p', { class: 'guia-meta' }, kt('Paso {n} de {m}', { n: String(n), m: String(steps.length) }), run.mode === 'learn' ? el('span', { class: 'guia-learn' }, kt('Practicando')) : null),
        el('button', { type: 'button', class: 'iconbtn guia-hide', 'aria-label': kt('Ocultar la guía'), ...mark('ocultar', 'Ocultar la guía'), onclick: () => api.minimize() }, icon('close', 18))),
      el('div', { class: 'guia-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(steps.length), 'aria-valuenow': String(steps.filter((s) => !isPending(s)).length), 'aria-label': kt('Hechos {n} de {m}', { n: String(steps.filter((s) => !isPending(s)).length), m: String(steps.length) }) },
        el('span', { style: `width:${Math.round((steps.filter((s) => !isPending(s)).length / Math.max(1, steps.length)) * 100)}%` })),
      el('h2', { class: 'guia-title', tabindex: '-1' }, step.title),
      step.explain ? el('p', { class: 'guia-explain' }, step.explain) : null,
      el('p', { class: 'guia-live', role: 'status', 'aria-live': 'polite' }, waiting ? kt('Cuando lo guardes, la guía sigue sola.') : ''),
      el('div', { class: 'guia-actions' },
        how === 'manual' ? el('button', { type: 'button', class: 'primary guia-done', ...mark('hecho', 'Hecho'), onclick: () => void confirm(step, 'manual', false) }, kt('Hecho')) : null,
        how === 'none' ? el('button', { type: 'button', class: 'primary guia-next', ...mark('siguiente', 'Siguiente'), onclick: () => void confirm(step, 'none', false) }, kt('Siguiente')) : null,
        step.anchor ? el('button', { type: 'button', class: 'ghost guia-show', ...mark('ver', 'Ver dónde'), onclick: () => void locate(step, true) }, kt('Ver dónde')) : null,
        step.route ? el('button', { type: 'button', class: 'ghost guia-go', hidden: true, ...mark('ir', 'Ir allí'), onclick: () => { navigate(step.route!); void locate(step, true); } }, kt('Ir allí')) : null,
        step.essential === false ? el('button', { type: 'button', class: 'ghost guia-skip', ...mark('saltar', 'Saltar'), onclick: () => void skip(step) }, kt('Saltar')) : null,
        prev ? el('button', { type: 'button', class: 'ghost guia-prev', ...mark('anterior', 'Anterior'), onclick: () => { revisit = prev.s.id; at = prev.i; paint(true); } }, kt('Anterior')) : null),
      el('div', { class: 'guia-foot' }, backLink(false)));
    paintPill();
    if (focus) bubble.querySelector<HTMLElement>('.guia-title')?.focus({ preventScroll: true });
    // El foco va a la burbuja si se pidió; si no, al campo (al llegar).
    void locate(step, !focus);
  }

  function backLink(primary: boolean): HTMLElement | null {
    const back = options.returnTo === undefined ? currentReturnTo() : options.returnTo;
    if (!back) return null;
    return el('a', { class: primary ? 'button primary guia-back' : 'guia-back', href: back.url, ...mark('volver', 'Volver a quien guía'), onclick: () => { clearReturnTo(); clearGuideLink(); } },
      icon('chevronLeft', 16), kt('Volver a {place}', { place: back.title ?? kt('la app anterior') }));
  }

  function paintPill(): void {
    if (!run) return;
    const pend = pendingOf(run).length;
    const n = at >= 0 ? at + 1 : run.steps.length;
    replace(pill, icon('pin', 16), pend ? kt('Guía · paso {n} de {m}', { n: String(n), m: String(run.steps.length) }) : kt('Guía · todo hecho'));
  }

  async function confirm(step: GuideStep, how: GuideConfirm, pending: boolean): Promise<void> {
    if (!open(step)) return;
    if (revisit === step.id) revisit = null;
    local.add(step.id);
    if (pending) unsynced.add(step.id); else unsynced.delete(step.id);
    say(pending ? kt('Guardado en este dispositivo: se enviará con conexión.') : kt('Hecho.'));
    try { await options.onConfirmed?.(step, { pending, how }); } catch { /* quien guía lo volverá a ver al reconsultar */ }
    if (destroyed) return;
    // Un momento para que se vea «Hecho» antes de pasar.
    setTimeout(() => { if (!destroyed && run) { at = -1; paint(true); } }, 500);
  }

  async function skip(step: GuideStep): Promise<void> {
    if (revisit === step.id) revisit = null;
    local.add(step.id);
    try { await options.onSkipped?.(step); } catch { /* idem */ }
    at = -1;
    paint(true);
  }

  const offSaved = onSaved((id, info) => {
    if (run && !info.pending) {
      for (const s of run.steps) {
        if (s.anchor !== id || !unsynced.has(s.id)) continue;
        unsynced.delete(s.id);
        void Promise.resolve(options.onConfirmed?.(s, { pending: false, how: confirmOf(s) })).catch(() => undefined);
      }
    }
    if (!run || at < 0) return;
    const step = run.steps[at];
    if (!step || step.anchor !== id || !open(step)) return;
    const how = confirmOf(step);
    if (how === 'save' || how === 'event') void confirm(step, how, info.pending);
  });

  const onVisible = () => { if (document.visibilityState === 'visible' && run && !destroyed) void api.refresh(); };
  if (options.refreshOnFocus !== false) document.addEventListener('visibilitychange', onVisible);
  const onResize = () => follow();
  addEventListener('resize', onResize);

  // Móvil: tira arriba mientras se escribe (ver la cabecera del archivo).
  const vv = typeof visualViewport === 'object' ? visualViewport : null;
  let pressing = false;
  let compactTimer = 0;
  const TYPING = 'textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=hidden])';
  /** El foco que pone la guía al llegar no cuenta: hace falta que la persona toque o escriba (si no, la explicación no se ve). */
  let engaged = false;
  const typing = () => {
    const a = document.activeElement as HTMLElement | null;
    return engaged && !!a && !element.contains(a) && a.matches(TYPING);
  };
  function compact(): void {
    if (destroyed) return;
    const narrow = typeof matchMedia !== 'function' || !matchMedia('(min-width: 720px)').matches;
    const keyboard = !!vv && vv.height < innerHeight * 0.75;
    const on = narrow && !minimized && (typing() || keyboard);
    bubble.classList.toggle('guia-compact', on);
    if (on) bubble.style.top = `${Math.round((vv?.offsetTop ?? 0) + (document.querySelector<HTMLElement>('.topbar')?.getBoundingClientRect().bottom ?? 0) + 6)}px`;
    else bubble.style.removeProperty('top');
  }
  const later = () => { clearTimeout(compactTimer); compactTimer = window.setTimeout(() => { if (!pressing) compact(); }, 60); };
  const onDown = () => { pressing = true; };
  const onUp = () => { pressing = false; later(); };
  const onFocus = () => { engaged = pressing; later(); };
  const onType = () => { engaged = true; later(); };
  document.addEventListener('focusin', onFocus);
  document.addEventListener('focusout', later);
  document.addEventListener('input', onType, true);
  document.addEventListener('keydown', onType, true);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
  vv?.addEventListener('resize', later);
  vv?.addEventListener('scroll', later);

  function exit(): void {
    api.destroy();
    clearGuideLink();
    options.onExit?.();
  }

  const api: Guide = {
    element,
    async start() {
      bubble.replaceChildren(el('p', { class: 'guia-live', role: 'status', 'aria-live': 'polite' }, kt('Cargando la guía…')));
      try {
        run = await options.load();
      } catch {
        replace(bubble, el('p', { class: 'guia-live', role: 'status' }, kt('No se pudo cargar la guía.')),
          el('div', { class: 'guia-actions' }, el('button', { type: 'button', class: 'ghost', onclick: () => void api.start() }, kt('Reintentar')), backLink(false)));
        return;
      }
      if (destroyed) return;
      local.clear();
      at = -1;
      paint(false);
    },
    async refresh() {
      try {
        const next = await options.load();
        if (destroyed) return;
        const keep = at >= 0 && run ? run.steps[at]?.id : null;
        run = next;
        // Lo que la lectura ya da por hecho deja de ser local; lo confirmado aquí y aún no reflejado se conserva.
        for (const id of [...local]) if (next.steps.find((s) => s.id === id)?.done) local.delete(id);
        at = keep ? next.steps.findIndex((s) => s.id === keep) : -1;
        if (!minimized) paint(false); else paintPill();
      } catch { say(kt('No se pudo actualizar la guía: sigue con lo que hay.')); }
    },
    current: () => (run && at >= 0 ? run.steps[at] ?? null : null),
    minimize() {
      minimized = true;
      bubble.hidden = true;
      pill.hidden = false;
      ring.hidden = true;
      cancelAnimationFrame(frame);
      paintPill();
      pill.focus();
    },
    expand() {
      minimized = false;
      bubble.hidden = false;
      pill.hidden = true;
      void api.refresh().then(() => bubble.querySelector<HTMLElement>('.guia-title')?.focus({ preventScroll: true }));
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      offSaved();
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('resize', onResize);
      clearTimeout(compactTimer);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', later);
      document.removeEventListener('input', onType, true);
      document.removeEventListener('keydown', onType, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
      vv?.removeEventListener('resize', later);
      vv?.removeEventListener('scroll', later);
      element.remove();
    },
  };
  return api;
}
