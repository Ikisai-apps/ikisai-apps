/**
 * Modo «Revisor de QA» (FEEDBACK.md §9), solo para el dueño del ecosistema (owner de Central):
 * - Segundo interruptor al pie del lanzador, debajo de «Señalar para comentar»; solo aparece si `available()` (la ruta
 *   `GET feedback?review=true` da 403 a cualquier otra cuenta).
 * - Encendido, una **lista lateral** con los reportes de todas las apps: «Por revisar» (`reviewStatus = 'new'`) y
 *   «Por comprobar» (`display = 'pending_verify'`).
 * - **Ir al sitio:** si es de esta app, navega a `report.routeRaw` sin recargar; si es de otra, abre
 *   `https://<dominio>/?fb=<código>&qa=1` (el modo pasa a la otra app por la URL: cada dominio tiene su almacenamiento).
 *   Al arrancar con `?fb=`, se pide el reporte, se navega, se espera al elemento `[data-feedback-id]` (con tiempo máximo;
 *   si no aparece, se ancla a la sección o a la página), se ilumina y se ancla la **tarjeta del revisor**.
 * - Tarjeta: comentario, imágenes, pasos y, según el caso, «Aprobar», «Descartar», «Unir a…» o «Funciona» y
 *   «Sigue fallando». «Siguiente» va al próximo de la lista.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { toast } from '../toast.ts';
import type { FeedbackApi, FeedbackReport } from './client.ts';
import { FEEDBACK_INTENT_LABELS, type FeedbackIntent } from './constants.ts';
import { appVersion } from './context.ts';
import type { FeedbackMode } from './feedback.ts';
import { reportChip, type FeedbackReportDetail } from './center.ts';

export interface FeedbackReviewOptions {
  api: FeedbackApi;
  /** Id de esta app (`tasks`, `booking`…). */
  app: string;
  /** Dominio de otra app (del catálogo del lanzador, `GET /api/v1/apps`). */
  appDomain?: (app: string) => string | null | undefined;
  /** Navega dentro de esta app a la ruta real; por defecto cambia el hash o hace `pushState` + `popstate`. */
  navigate?: (routeRaw: string) => void | Promise<void>;
  /** Abre otra app; por defecto `location.assign`. */
  openUrl?: (url: string) => void;
  /** Tiempo máximo esperando al elemento (ms); por defecto 6000. */
  waitMs?: number;
  /** Capa donde montar la lista y la tarjeta; por defecto `document.body`. */
  container?: () => HTMLElement;
  /** Clave del modo en este dispositivo; por defecto `ikisai-feedback-review`. */
  storageKey?: string;
}

export interface FeedbackReview {
  mode: FeedbackMode;
  /** ¿Esta cuenta puede revisar? (403 en `GET feedback?review=true` → no). */
  available(): Promise<boolean>;
  /** Vuelve a pedir la lista. */
  refresh(): Promise<void>;
  /** Va al reporte: en esta app lo enseña en su sitio; en otra, abre esa app con `?fb=`. */
  goTo(report: Pick<FeedbackReport, 'code' | 'originApp'>): Promise<void>;
  /** Enseña un reporte de esta app en su sitio (lo usa el arranque con `?fb=`). */
  show(code: string): Promise<void>;
  destroy(): void;
}

type ReviewReport = FeedbackReport & { reviewStatus?: string; routeRaw?: string | null };
type ReviewDetail = FeedbackReportDetail & { report: ReviewReport; context?: { steps?: { route?: string; node?: string; action?: string }[] } };

const FB_PARAM = 'fb';
const QA_PARAM = 'qa';

/** Navegación por defecto: hash (`/#/reservas/…`) o ruta (`/reservas/…`). */
function defaultNavigate(routeRaw: string): void {
  const hashAt = routeRaw.indexOf('#');
  if (hashAt >= 0) {
    const hash = routeRaw.slice(hashAt);
    if (location.hash !== hash) location.hash = hash;
    return;
  }
  if (location.pathname !== routeRaw) { history.pushState(null, '', routeRaw); dispatchEvent(new PopStateEvent('popstate')); }
}

/** Espera al elemento del nodo; si no llega, el ancestro más cercano que exista (sección, pantalla) o `null` (página). */
async function waitForNode(nodeId: string | null | undefined, waitMs: number): Promise<{ element: Element | null; exact: boolean }> {
  if (!nodeId) return { element: null, exact: false };
  const find = (id: string) => document.querySelector(`[data-feedback-id="${CSS.escape(id)}"]`);
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const found = find(nodeId);
    if (found && (found as HTMLElement).getClientRects().length) return { element: found, exact: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  const parts = nodeId.split('.');
  for (let n = parts.length - 1; n > 0; n--) {
    const found = find(parts.slice(0, n).join('.'));
    if (found) return { element: found, exact: false };
  }
  return { element: null, exact: false };
}

export function createFeedbackReview(options: FeedbackReviewOptions): FeedbackReview {
  const key = options.storageKey ?? 'ikisai-feedback-review';
  const host = () => options.container?.() ?? document.body;
  const navigate = options.navigate ?? defaultNavigate;
  const openUrl = options.openUrl ?? ((url: string) => location.assign(url));
  const listeners = new Set<(on: boolean) => void>();
  let items: ReviewReport[] = [];
  let availability: Promise<boolean> | null = null;
  let currentCode: string | null = null;
  let spot: Element | null = null;
  let collapsed = false;
  const panel = el('aside', { class: 'ikisai-fb-layer fb-review', 'aria-label': 'Revisor de QA' });
  const card = el('section', { class: 'ikisai-fb-layer fb-review-card', role: 'dialog', 'aria-label': 'Reporte en revisión', tabindex: '-1', hidden: true });

  function isOn(): boolean { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
  const mode: FeedbackMode = {
    get: isOn,
    set(on) {
      try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* sin almacenamiento */ }
      apply();
      for (const l of listeners) l(on);
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };

  function available(): Promise<boolean> {
    availability ??= options.api('/feedback?review=true&app=all&limit=1').then(() => true, () => false);
    return availability;
  }

  function apply(): void {
    const on = isOn();
    document.documentElement.classList.toggle('fb-reviewing', on);
    if (on) { if (!panel.isConnected) host().appendChild(panel); void refresh(); }
    else { panel.remove(); closeCard(); }
  }

  const firstLine = (text: string) => text.split('\n')[0]!.slice(0, 120);
  function row(r: ReviewReport): HTMLElement {
    return el('li', null, el('button', {
      type: 'button', class: `fb-review-row${r.code === currentCode ? ' on' : ''}`, dataset: { code: r.code, app: r.originApp },
      'aria-current': r.code === currentCode ? 'true' : null,
      onclick: () => void goTo(r),
    },
      el('span', { class: 'fb-card-head' },
        el('span', { class: 'chip small', dataset: { app: r.originApp } }, el('span', null, r.originApp)),
        el('strong', { class: 'fb-code' }, r.code),
        r.blocking ? el('span', { class: 'chip small alert' }, el('span', null, 'Me bloquea')) : null,
        r.supportersCount > 1 ? el('small', { class: 'fb-review-sup' }, `+${r.supportersCount - 1}`) : null),
      el('span', { class: 'fb-card-msg' }, firstLine(r.message))));
  }
  const toReview = () => items.filter((r) => r.reviewStatus === 'new');
  const toCheck = () => items.filter((r) => r.reviewStatus !== 'new' && r.display === 'pending_verify');
  /** Orden de «Siguiente»: primero por revisar, luego por comprobar. */
  const queue = () => [...toReview(), ...toCheck()];

  function paintPanel(state: 'ok' | 'loading' | 'error' = 'ok'): void {
    const a = toReview();
    const b = toCheck();
    replace(panel,
      el('header', { class: 'fb-review-head' },
        el('strong', null, 'Revisor de QA'),
        el('span', { class: 'fb-count' }, String(a.length + b.length)),
        el('button', { type: 'button', class: 'iconbtn small fb-review-refresh', 'aria-label': 'Actualizar', onclick: () => void refresh() }, icon('sync', 16)),
        el('button', { type: 'button', class: 'iconbtn small fb-review-collapse', 'aria-expanded': String(!collapsed), 'aria-label': collapsed ? 'Desplegar la lista' : 'Plegar la lista', onclick: () => { collapsed = !collapsed; paintPanel(); } }, icon(collapsed ? 'chevronUp' : 'chevronDown', 16))),
      collapsed ? null : el('div', { class: 'fb-review-body' },
        state === 'loading' && !items.length ? el('p', { class: 'hint' }, 'Cargando…') : null,
        state === 'error' ? el('p', { class: 'fb-status error' }, 'No se pudo cargar la lista. Comprueba la conexión.') : null,
        el('h3', { class: 'launcher-group' }, `Por revisar · ${a.length}`),
        a.length ? el('ul', { class: 'fb-review-list', 'aria-label': 'Por revisar', dataset: { block: 'review' } }, ...a.map(row)) : el('p', { class: 'hint fb-empty' }, 'Nada nuevo.'),
        el('h3', { class: 'launcher-group' }, `Por comprobar · ${b.length}`),
        b.length ? el('ul', { class: 'fb-review-list', 'aria-label': 'Por comprobar', dataset: { block: 'check' } }, ...b.map(row)) : el('p', { class: 'hint fb-empty' }, 'Nada pendiente de comprobar.')));
    panel.classList.toggle('collapsed', collapsed);
  }

  async function refresh(): Promise<void> {
    if (!isOn()) return;
    paintPanel('loading');
    try {
      items = (await options.api<{ items: ReviewReport[] }>('/feedback?review=true&app=all&limit=100')).items ?? [];
      paintPanel();
    } catch { paintPanel('error'); }
  }

  async function goTo(r: Pick<FeedbackReport, 'code' | 'originApp'>): Promise<void> {
    if (r.originApp && r.originApp !== options.app) {
      const domain = options.appDomain?.(r.originApp);
      if (!domain) { toast(`No sé abrir ${r.originApp} desde aquí.`); return; }
      closeCard();
      openUrl(`https://${domain}/?${FB_PARAM}=${encodeURIComponent(r.code)}&${QA_PARAM}=1`);
      return;
    }
    await show(r.code);
  }

  function clearSpot(): void { spot?.classList.remove('fb-spot'); spot = null; }
  function closeCard(): void { card.hidden = true; card.remove(); clearSpot(); panel.classList.remove('under-card'); currentCode = null; document.removeEventListener('keydown', onKey, true); if (isOn()) paintPanel(); }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !card.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeCard(); } };

  function place(anchor: Element | null): void {
    const mobile = innerWidth < 720;
    card.classList.toggle('sheet-mode', mobile || !anchor);
    card.style.left = card.style.top = '';
    if (mobile || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const w = Math.min(380, innerWidth - 24);
    const h = card.offsetHeight || 320;
    let top = rect.bottom + 10;
    if (top + h > innerHeight - 12) top = Math.max(12, rect.top - h - 10);
    card.style.left = `${Math.min(Math.max(12, rect.left), innerWidth - w - 12)}px`;
    card.style.top = `${top}px`;
  }

  async function show(code: string): Promise<void> {
    currentCode = code;
    if (isOn()) paintPanel();
    let detail: ReviewDetail;
    try { detail = await options.api<ReviewDetail>(`/feedback/${encodeURIComponent(code)}`); }
    catch { toast(`No se pudo abrir ${code}.`); currentCode = null; return; }
    const r = detail.report;
    if (r.routeRaw) await navigate(r.routeRaw);
    const { element, exact } = await waitForNode(r.node?.id, options.waitMs ?? 6000);
    clearSpot();
    if (element) { spot = element; element.classList.add('fb-spot'); (element as HTMLElement).scrollIntoView?.({ block: 'center', behavior: 'instant' as ScrollBehavior }); }
    paintCard(detail, element, exact);
  }

  function paintCard(detail: ReviewDetail, anchor: Element | null, exact: boolean): void {
    const r = detail.report;
    const status = el('p', { class: 'fb-status', role: 'status' });
    const reason = el('textarea', { class: 'fb-message', rows: '2', maxlength: '500', 'aria-label': 'Motivo', hidden: true }) as HTMLTextAreaElement;
    const into = el('input', { type: 'text', class: 'fb-merge-into', placeholder: 'FB_2026_0001', 'aria-label': 'Código del reporte que se queda', hidden: true }) as HTMLInputElement;
    const act = async (path: string, json: unknown, done: string, buttons: HTMLButtonElement[]) => {
      buttons.forEach((b) => { b.disabled = true; });
      try {
        await options.api(`/feedback/${encodeURIComponent(r.id)}/${path}`, { method: 'POST', json });
        toast(done);
        const nextOne = next();
        items = items.filter((x) => x.code !== r.code);
        if (nextOne) void goTo(nextOne); else { closeCard(); }
        void refresh();
      } catch (error) {
        buttons.forEach((b) => { b.disabled = false; });
        status.className = 'fb-status error';
        status.textContent = (error as { code?: string }).code === 'OUT_OF_SCOPE' ? 'No se encontró ese reporte.' : 'No se pudo guardar. Prueba otra vez con conexión.';
      }
    };
    const next = () => { const q = queue(); const at = q.findIndex((x) => x.code === r.code); return q[at + 1] ?? (at < 0 ? q[0] : null) ?? null; };

    const buttons: HTMLButtonElement[] = [];
    const btn = (cls: string, label: string, onclick: () => void) => { const b = el('button', { type: 'button', class: cls, onclick }, label) as HTMLButtonElement; buttons.push(b); return b; };
    const isNew = r.reviewStatus === 'new';
    const isCheck = r.display === 'pending_verify';
    const dismiss = btn('ghost fb-rv-dismiss', 'Descartar', () => {
      if (reason.hidden) { reason.hidden = false; into.hidden = true; reason.placeholder = 'Motivo (lo verá quien lo informó)'; dismiss.textContent = 'Confirmar descarte'; reason.focus(); return; }
      if (!reason.value.trim()) { reason.focus(); return; }
      void act('dismiss', { reason: reason.value.trim() }, 'Descartado.', buttons);
    });
    const merge = btn('ghost fb-rv-merge', 'Unir a…', () => {
      if (into.hidden) { into.hidden = false; reason.hidden = true; merge.textContent = 'Unir'; into.focus(); return; }
      const target = into.value.trim().toUpperCase();
      if (!/^FB_\d{4}_\d{3,}$/.test(target) || target === r.code) { status.className = 'fb-status error'; status.textContent = 'Escribe el código del otro reporte (FB_AAAA_NNNN).'; into.focus(); return; }
      void act('merge', { into: target }, `Unido a ${target}.`, buttons);
    });
    const approve = btn('primary fb-rv-approve', 'Aprobar para arreglar', () => void act('approve', {}, 'Aprobado: pasa al buzón del agente.', buttons));
    const works = btn('primary fb-rv-works', 'Funciona', async () => void act('verify', { build: (await appVersion())?.release ?? null }, 'Verificado.', buttons));
    const fails = btn('ghost fb-rv-fails', 'Sigue fallando', () => {
      if (reason.hidden) { reason.hidden = false; reason.placeholder = '¿Qué sigue pasando? (opcional)'; fails.textContent = 'Enviar: sigue fallando'; reason.focus(); return; }
      void act('reopen', reason.value.trim() ? { message: reason.value.trim() } : {}, 'Reabierto.', buttons);
    });
    const steps = detail.context?.steps ?? [];
    const following = next();
    replace(card,
      el('header', { class: 'fb-head' },
        el('div', { class: 'fb-where' },
          el('small', null, `${r.originApp} · ${FEEDBACK_INTENT_LABELS[r.intent as FeedbackIntent] ?? r.intent}${r.node ? ` · ${r.node.path.join(' › ')}` : ''}`),
          el('strong', null, r.code, ' ', reportChip(r.display), r.blocking ? el('span', { class: 'chip small alert' }, el('span', null, 'Me bloquea')) : null)),
        el('button', { type: 'button', class: 'iconbtn small fb-close', 'aria-label': 'Cerrar', onclick: () => closeCard() }, icon('close', 18))),
      exact ? null : el('p', { class: 'banner info fb-rv-approx' }, icon('info', 16), el('span', null, anchor ? 'El elemento ya no está aquí: se muestra su sección.' : 'El elemento no aparece en esta pantalla.')),
      el('p', { class: 'fb-detail-msg' }, r.message),
      r.supportersCount > 1 ? el('p', { class: 'fb-card-meta' }, `${r.supportersCount} personas`) : null,
      detail.attachments?.length ? el('div', { class: 'fb-images' }, ...detail.attachments.filter((a) => a.url).map((a) => el('a', { class: 'fb-thumb', href: a.url, target: '_blank', rel: 'noopener' }, el('img', { src: a.url, alt: 'Imagen adjunta', loading: 'lazy' })))) : null,
      steps.length ? el('details', { class: 'fb-rv-steps' }, el('summary', null, `Últimos pasos (${steps.length})`),
        el('ol', null, ...steps.map((s) => el('li', null, `${s.action ?? 'tocó'} ${s.node ?? ''} ${s.route ? `(${s.route})` : ''}`.trim())))) : null,
      reason, into, status,
      el('div', { class: 'fb-foot fb-rv-actions' },
        isNew ? dismiss : null, isNew ? merge : null, isNew ? approve : null,
        !isNew && isCheck ? fails : null, !isNew && isCheck ? works : null),
      el('div', { class: 'fb-rv-nav' },
        following ? el('button', { type: 'button', class: 'linkbtn fb-rv-next', onclick: () => void goTo(following) }, 'Siguiente', icon('chevronRight', 16)) : el('small', { class: 'hint' }, 'Es el último de la lista.')));
    if (!card.isConnected) host().appendChild(card);
    card.hidden = false;
    document.removeEventListener('keydown', onKey, true);
    document.addEventListener('keydown', onKey, true);
    // En móvil la lista y la tarjeta irían las dos abajo: la lista se aparta mientras hay tarjeta («Siguiente» sigue la cola).
    panel.classList.toggle('under-card', innerWidth < 720);
    place(anchor);
    requestAnimationFrame(() => place(anchor));
    if (isOn()) paintPanel();
  }

  /** Arranque con `?fb=<código>[&qa=1]`: enciende el modo si viene de otra app y enseña el reporte. */
  function boot(): void {
    const params = new URLSearchParams(location.search);
    const code = params.get(FB_PARAM);
    if (!code) return;
    const fromQa = params.get(QA_PARAM) === '1';
    params.delete(FB_PARAM); params.delete(QA_PARAM);
    const search = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
    if (fromQa && !isOn()) mode.set(true);
    void show(code);
  }

  const onResize = () => { if (!card.hidden && card.isConnected) place(spot); };
  window.addEventListener('resize', onResize);
  apply();
  boot();

  return {
    mode, available, refresh, goTo, show,
    destroy() { window.removeEventListener('resize', onResize); panel.remove(); closeCard(); document.documentElement.classList.remove('fb-reviewing'); },
  };
}
