/**
 * Modo «Revisor de QA» (FEEDBACK.md §9 y USO.md §3), solo para el dueño del ecosistema (owner de Central):
 * - Segundo interruptor al pie del lanzador, debajo de «Señalar para comentar»; solo aparece si `available()` (la ruta
 *   `GET feedback?review=true` da 403 a cualquier otra cuenta).
 * - Encendido, una **lista lateral** con dos pestañas de todas las apps:
 *   - **Incidencias** (`review-feedback.ts`): «Por revisar» y «Por comprobar».
 *   - **Uso** (`review-usage.ts`): funciones agrupadas por *insight*.
 * - **Ir al sitio:** en esta app navega a la ruta real sin recargar, espera al `[data-feedback-id]` (con tiempo máximo;
 *   si no aparece, la sección o la pantalla más cercana), lo ilumina y ancla la tarjeta. En otra app abre
 *   `https://<dominio>/?fb=<código>&qa=1` (incidencia) o `?fbf=<función>&qa=1` (uso): el modo pasa por la URL porque
 *   cada dominio tiene su almacenamiento. Al arrancar con esos parámetros, el kit enciende el modo y limpia la URL.
 */
import { el, replace, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { toast } from '../toast.ts';
import type { FeedbackApi, FeedbackReport } from './client.ts';
import type { FeedbackMode } from './feedback.ts';
import { createFeedbackReviewTab } from './review-feedback.ts';
import { createUsageReviewTab, type UsageReviewItem } from './review-usage.ts';

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
  /** Vuelve a pedir las listas. */
  refresh(): Promise<void>;
  /** Va al reporte: en esta app lo enseña en su sitio; en otra, abre esa app con `?fb=`. */
  goTo(report: Pick<FeedbackReport, 'code' | 'originApp'>): Promise<void>;
  /** Enseña un reporte de esta app en su sitio (lo usa el arranque con `?fb=`). */
  show(code: string): Promise<void>;
  /** Va a una función (pestaña «Uso»): en esta app la ilumina; en otra, abre esa app con `?fbf=`. */
  goToFeature(item: Pick<UsageReviewItem, 'featureId' | 'app'>): Promise<void>;
  /** Pestaña de la lista. */
  tab(id?: 'feedback' | 'usage'): 'feedback' | 'usage';
  destroy(): void;
}

/** Lo que una pestaña del revisor necesita del armazón. */
export interface ReviewHost {
  api: FeedbackApi;
  app: string;
  card: HTMLElement;
  /** Monta la tarjeta anclada al elemento (o como hoja si no hay elemento o en móvil). */
  showCard(anchor: Element | null): void;
  closeCard(): void;
  /** Navega a la ruta (si hay) y espera al nodo; lo ilumina. Con `watch`, si no está, lo ilumina cuando aparezca. */
  goToNode(routeRaw: string | null | undefined, nodeId: string | null | undefined, opts?: { watch?: boolean }): Promise<{ element: Element | null; exact: boolean }>;
  /** Abre otra app con los parámetros dados (y `qa=1`). */
  openApp(app: string, params: Record<string, string>): void;
  repaint(): void;
  refresh(): Promise<void>;
}

/** Una pestaña de la lista lateral. */
export interface ReviewTab {
  id: 'feedback' | 'usage';
  label: string;
  count(): number;
  load(): Promise<void>;
  list(state: 'ok' | 'loading' | 'error'): Child[];
  /** Atiende su parámetro de arranque (`fb`, `fbf`); devuelve si lo había. */
  boot(params: URLSearchParams): boolean;
  closed(): void;
}

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

const findNode = (id: string) => document.querySelector(`[data-feedback-id="${CSS.escape(id)}"]`);
/** A la vista de verdad (dentro de un `<details>` cerrado hay rectángulos pero no se ve). */
const shown = (element: Element) => {
  const html = element as HTMLElement;
  return typeof html.checkVisibility === 'function' ? html.checkVisibility({ checkVisibilityCSS: true } as CheckVisibilityOptions) : !!html.getClientRects().length;
};

/** Espera al elemento del nodo; si no llega, el ancestro más cercano que exista (sección, pantalla) o `null` (página). */
async function waitForNode(nodeId: string | null | undefined, waitMs: number): Promise<{ element: Element | null; exact: boolean }> {
  if (!nodeId) return { element: null, exact: false };
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const found = findNode(nodeId);
    if (found && shown(found)) return { element: found, exact: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  const parts = nodeId.split('.');
  for (let n = parts.length - 1; n > 0; n--) {
    const found = findNode(parts.slice(0, n).join('.'));
    if (found) return { element: found, exact: false };
  }
  return { element: null, exact: false };
}

export function createFeedbackReview(options: FeedbackReviewOptions): FeedbackReview {
  const key = options.storageKey ?? 'ikisai-feedback-review';
  const tabKey = `${key}-tab`;
  const host = () => options.container?.() ?? document.body;
  const navigate = options.navigate ?? defaultNavigate;
  const openUrl = options.openUrl ?? ((url: string) => location.assign(url));
  const listeners = new Set<(on: boolean) => void>();
  let availability: Promise<boolean> | null = null;
  let spot: Element | null = null;
  let watcher: MutationObserver | null = null;
  let collapsed = false;
  const state: Record<'feedback' | 'usage', 'ok' | 'loading' | 'error'> = { feedback: 'ok', usage: 'ok' };
  const panel = el('aside', { class: 'ikisai-fb-layer fb-review', 'aria-label': 'Revisor de QA' });
  const card = el('section', { class: 'ikisai-fb-layer fb-review-card', role: 'dialog', 'aria-label': 'Revisión', tabindex: '-1', hidden: true });

  function isOn(): boolean { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
  function activeTab(): 'feedback' | 'usage' { try { return localStorage.getItem(tabKey) === 'usage' ? 'usage' : 'feedback'; } catch { return 'feedback'; } }
  function setTab(id: 'feedback' | 'usage'): void { try { localStorage.setItem(tabKey, id); } catch { /* */ } paintPanel(); }

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

  // --- Tarjeta y navegación (compartidas por las pestañas) ---------------------------------------------
  function clearSpot(): void { spot?.classList.remove('fb-spot'); spot = null; watcher?.disconnect(); watcher = null; }
  function spotlight(element: Element): void {
    spot?.classList.remove('fb-spot');
    spot = element;
    element.classList.add('fb-spot');
    (element as HTMLElement).scrollIntoView?.({ block: 'center', behavior: 'instant' as ScrollBehavior });
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !card.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closeCard(); } };
  function closeCard(): void {
    card.hidden = true; card.remove(); clearSpot(); panel.classList.remove('under-card');
    for (const t of Object.values(tabs)) t.closed();
    document.removeEventListener('keydown', onKey, true);
    if (isOn()) paintPanel();
  }
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

  const reviewHost: ReviewHost = {
    api: options.api,
    app: options.app,
    card,
    showCard(anchor) {
      // Como hoja (móvil) tapa la pantalla: «Minimizar» la deja en su cabecera para poder ir hasta la función.
      card.classList.remove('min');
      const head = card.querySelector('.fb-head');
      if (head && !head.querySelector('.fb-rv-min')) {
        const min = el('button', { type: 'button', class: 'iconbtn small fb-rv-min', 'aria-label': 'Minimizar', 'aria-expanded': 'true' }, icon('chevronDown', 18));
        min.addEventListener('click', () => {
          const on = card.classList.toggle('min');
          min.setAttribute('aria-expanded', String(!on));
          min.setAttribute('aria-label', on ? 'Desplegar' : 'Minimizar');
          replace(min, icon(on ? 'chevronUp' : 'chevronDown', 18));
        });
        head.insertBefore(min, head.querySelector('.fb-close'));
      }
      if (!card.isConnected) host().appendChild(card);
      card.hidden = false;
      document.removeEventListener('keydown', onKey, true);
      document.addEventListener('keydown', onKey, true);
      // En móvil la lista y la tarjeta irían las dos abajo: la lista se aparta mientras hay tarjeta («Siguiente» sigue la cola).
      panel.classList.toggle('under-card', innerWidth < 720);
      place(anchor);
      requestAnimationFrame(() => place(anchor));
      if (isOn()) paintPanel();
    },
    closeCard,
    async goToNode(routeRaw, nodeId, opts) {
      clearSpot();
      if (routeRaw) await navigate(routeRaw);
      const found = await waitForNode(nodeId, options.waitMs ?? 6000);
      if (found.element) spotlight(found.element);
      if (!found.exact && nodeId && opts?.watch) {
        // Se queda vigilando: cuando la persona navega hasta la función, se ilumina y la tarjeta se ancla a ella.
        watcher = new MutationObserver(() => {
          const exact = findNode(nodeId);
          if (!exact || !shown(exact)) return;
          watcher?.disconnect(); watcher = null;
          spotlight(exact);
          card.querySelector('.fb-rv-approx')?.remove();
          place(exact);
        });
        watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'open', 'style'] });
      }
      return found;
    },
    openApp(app, params) {
      const domain = options.appDomain?.(app);
      if (!domain) { toast(`No sé abrir ${app} desde aquí.`); return; }
      closeCard();
      const query = new URLSearchParams({ ...params, [QA_PARAM]: '1' });
      openUrl(`https://${domain}/?${query.toString()}`);
    },
    repaint: () => { if (isOn()) paintPanel(); },
    refresh: () => refresh(),
  };

  const feedbackTab = createFeedbackReviewTab(reviewHost);
  const usageTab = createUsageReviewTab(reviewHost);
  const tabs = { feedback: feedbackTab, usage: usageTab };

  // --- Lista lateral --------------------------------------------------------------------------------------
  function paintPanel(): void {
    const active = tabs[activeTab()];
    replace(panel,
      el('header', { class: 'fb-review-head' },
        el('strong', null, 'Revisor de QA'),
        el('span', { class: 'fb-count' }, String(active.count())),
        el('button', { type: 'button', class: 'iconbtn small fb-review-refresh', 'aria-label': 'Actualizar', onclick: () => void refresh() }, icon('sync', 16)),
        el('button', { type: 'button', class: 'iconbtn small fb-review-collapse', 'aria-expanded': String(!collapsed), 'aria-label': collapsed ? 'Desplegar la lista' : 'Plegar la lista', onclick: () => { collapsed = !collapsed; paintPanel(); } }, icon(collapsed ? 'chevronUp' : 'chevronDown', 16))),
      collapsed ? null : el('div', { class: 'segmented fb-review-tabs', role: 'tablist', 'aria-label': 'Qué revisar' },
        ...(['feedback', 'usage'] as const).map((id) => el('button', {
          type: 'button', role: 'tab', 'aria-selected': String(id === active.id), class: id === active.id ? 'on' : '', dataset: { tab: id },
          onclick: () => setTab(id),
        }, tabs[id].label, ' ', el('span', { class: 'fb-count' }, String(tabs[id].count()))))),
      collapsed ? null : el('div', { class: 'fb-review-body', role: 'tabpanel', dataset: { tab: active.id } }, ...active.list(state[active.id])));
    panel.classList.toggle('collapsed', collapsed);
  }

  async function refresh(): Promise<void> {
    if (!isOn()) return;
    state.feedback = state.usage = 'loading';
    paintPanel();
    await Promise.all((['feedback', 'usage'] as const).map(async (id) => {
      try { await tabs[id].load(); state[id] = 'ok'; } catch { state[id] = 'error'; }
    }));
    if (isOn()) paintPanel();
  }

  function apply(): void {
    const on = isOn();
    document.documentElement.classList.toggle('fb-reviewing', on);
    if (on) { if (!panel.isConnected) host().appendChild(panel); void refresh(); }
    else { panel.remove(); closeCard(); }
  }

  /** Arranque con `?fb=<código>` o `?fbf=<función>` (y `qa=1` si viene de otra app). */
  function boot(): void {
    const params = new URLSearchParams(location.search);
    if (!params.has('fb') && !params.has('fbf')) return;
    const fromQa = params.get(QA_PARAM) === '1';
    params.delete(QA_PARAM);
    const which = params.has('fbf') ? 'usage' : 'feedback';
    const copy = new URLSearchParams(params);
    feedbackTab.boot(params) || usageTab.boot(params);
    for (const k of ['fb', 'fbf']) copy.delete(k);
    const search = copy.toString();
    history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
    try { localStorage.setItem(tabKey, which); } catch { /* */ }
    if (fromQa && !isOn()) mode.set(true);
  }

  const onResize = () => { if (!card.hidden && card.isConnected) place(spot); };
  window.addEventListener('resize', onResize);
  apply();
  boot();

  return {
    mode, available, refresh,
    goTo: (r) => feedbackTab.goTo(r),
    show: (code) => feedbackTab.show(code),
    goToFeature: (item) => usageTab.goTo(item),
    tab(id) { if (id) setTab(id); return activeTab(); },
    destroy() { window.removeEventListener('resize', onResize); panel.remove(); closeCard(); document.documentElement.classList.remove('fb-reviewing'); },
  };
}
