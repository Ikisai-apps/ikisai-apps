/**
 * Cabecera del kit con el lanzador (sesión única) y «Ayuda y sugerencias», idioma, rutas del portal, estado de guardado
 * y conflictos (API.md §9). Rutas: `#/` (Inicio o «¿Qué quieres ver?» si la cuenta tiene varias entradas) y
 * `#/p/<guestId>[/datos|/alimentacion|/firma|/info|/programa|/menu|/alojamiento|/materiales|/preguntas|/mas]`. Con
 * módulos del organizador (fases 4 y 5, API.md §13), barra inferior propia; en la vista previa, franja de solo lectura.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, createAppLauncher, createAppShell, createUsage, el, icon, openSheet, replace, toast, type LauncherCatalog } from '@ikisai/ui-kit';
import { createGuestApi, type Grant, type MyGuest } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { describeError } from '../app/client.ts';
import { commonText, loadCommonTexts } from '../app/common-texts.ts';
import { openGuest, type GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { dateRange, fieldLabel } from '../app/labels.ts';
import { createPortalReads } from '../app/portal.ts';
import { openAccess, openInstall } from './access.ts';
import { centralText, failure, fbIgnore, loading } from './common.ts';
import { mountData } from './data.ts';
import { mountDiet } from './diet.ts';
import { openHelp } from './help.ts';
import { momentOf, mountHome } from './home.ts';
import { mountInfo } from './info.ts';
import { mountLodging } from './lodging.ts';
import { clearOfflineMaterials, mountMaterials } from './materials.ts';
import { modulesOf, navItems, type Modules } from './nav.ts';
import { mountMenu, mountProgram } from './program.ts';
import { mountQuestions } from './questions.ts';
import { languageSelect } from './language.ts';
import { needsPrivacy, renderPrivacy } from './privacy.ts';
import { mountSign } from './sign.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
  /** Para el aviso de actualización: hay cambios sin confirmar. */
  setBusy(busy: () => boolean): void;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PERSON = new RegExp(`^#/p/(${UUID})(?:/(datos|alimentacion|firma|info|programa|menu|alojamiento|materiales|preguntas))?$`, 'i');
type Page = 'inicio' | 'datos' | 'alimentacion' | 'firma' | 'info' | 'programa' | 'menu' | 'alojamiento' | 'materiales' | 'preguntas';
/** Ids literales de cada pantalla (el catálogo de la publicación los recoge del código). */
const PAGE_IDS: Record<Page, [string, string]> = {
  inicio: ['guests.inicio', 'Inicio'], datos: ['guests.datos', 'Mis datos'], alimentacion: ['guests.alimentacion', 'Alimentación'],
  firma: ['guests.firma', 'Firma'], info: ['guests.info', 'Información práctica'], programa: ['guests.programa', 'Programa'],
  menu: ['guests.menu', 'Menú'], alojamiento: ['guests.alojamiento', 'Alojamiento'], materiales: ['guests.materiales', 'Materiales'],
  preguntas: ['guests.preguntas', 'Preguntas del organizador'],
};
/** Páginas de un módulo del organizador: solo existen si está activo (si no, se vuelve a Inicio). */
const MODULE_OF: Partial<Record<Page, keyof Modules>> = { programa: 'program', menu: 'menu', alojamiento: 'lodging', materiales: 'materials', preguntas: 'questions' };

export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  const userId = client.bootstrap()?.profile.userId ?? 'anon';
  const api = createGuestApi(client);
  const reads = createPortalReads(client);
  const apiCall = client.api.bind(client);
  // Uso sin persona en los portales (contrato §3.8): sin aviso.
  const usage = createUsage({ app: 'guests', api: apiCall, userId: () => userId, notice: false });
  const offSessionEnd = client.onSessionEnd((id) => { void cache.clearUser(id); void usage.clear(id); void clearOfflineMaterials(id); });
  const texts = loadCommonTexts(client);
  let person: { grant: Grant; ctx: GuestContext } | null = null;

  const launcher = createAppLauncher({
    current: 'guests',
    fetchApps: async () => client.api<LauncherCatalog>('/apps'),
    center: () => openHelp({ client, userId, grant: person?.grant ?? null }),
    centerLabel: t('home.help'),
    centerText: t('help.centerText'),
  });
  const logoutButton = el('button', { type: 'button', class: 'iconbtn', id: 'logout', 'aria-label': t('shell.logout'), title: t('shell.logout'),
    'data-feedback-id': 'guests.cuenta.dispositivo.salir', 'data-feedback-label': 'Salir de este dispositivo', onclick: () => void logout() }, icon('logout', 18));
  const shell = createAppShell(root, {
    appName: 'Guests',
    markIcon: 'guest',
    subtitle: client.bootstrap()?.profile.displayName ?? '',
    nav: [],
    // Barra del kit 0.21 (U5): los módulos del organizador y «Más»; vacía en la fase 1 (sin módulos).
    maxNav: 5,
    navigate,
    launcher,
    tools: [languageSelect(), logoutButton],
  });
  const { main } = shell;
  shell.header.setAttribute('data-feedback-id', 'guests.cabecera');
  shell.header.setAttribute('data-feedback-label', 'Cabecera');
  const saveState = el('p', { class: 'gsavestate', id: 'saveState', role: 'status', 'aria-live': 'polite' });
  const previewBand = el('p', { class: 'banner warn gpreview', id: 'previewBand', role: 'status', hidden: true });
  shell.banners.append(previewBand, saveState);
  ctx.setBusy(() => person?.ctx.writer.busy() ?? false);

  let unmountView: (() => void) | null = null;

  async function logout(): Promise<void> {
    const busy = person?.ctx.writer.busy();
    const ok = await confirmDialog({
      title: t('shell.logoutTitle'),
      text: busy ? t('shell.logoutPending') : t('shell.logoutText'),
      confirmLabel: t('shell.logout'),
    });
    if (!ok) return;
    try { await client.logout(); } finally { ctx.onLogout(); }
  }

  function navigate(hash: string, replaceHistory = false): void {
    if (replaceHistory) { history.replaceState(null, '', hash); void route(); }
    else if (location.hash === hash) void route();
    else location.hash = hash;
  }

  function paintSaveState(): void {
    const w = person?.ctx.writer;
    const state = w?.state() ?? 'idle';
    saveState.dataset.state = state;
    saveState.textContent = !w ? '' : state === 'saving' ? t('save.globalSaving', { count: w.pending() })
      : state === 'offline' ? t('save.globalOffline', { count: w.pending() })
      : state === 'error' ? t('save.globalError') : state === 'saved' ? t('save.globalSaved') : '';
  }

  function showConflicts(): void {
    const c = person?.ctx;
    if (!c || !c.conflicts().length) return;
    const list = el('div', { id: 'conflicts' });
    const sheet = openSheet({ title: t('conflict.title'), body: el('div', null, el('p', null, t('conflict.intro')), list) });
    const paint = () => {
      const pending = c.conflicts();
      if (!pending.length) { void sheet.close(true); return; }
      replace(list, ...pending.map((conflict) => fbIgnore(el('div', { class: 'card gcard gconflict', 'data-field': conflict.field },
        el('h3', null, fieldLabel(conflict.field)),
        el('p', null, t('conflict.theirs'), ' ', el('strong', null, String(conflict.theirs ?? '—'))),
        el('p', null, t('conflict.mine'), ' ', el('strong', null, String(conflict.mine ?? '—'))),
        el('div', { class: 'btnrow' },
          el('button', { type: 'button', class: 'ghost', 'data-feedback-id': 'guests.datos.conflicto.resolver', 'data-feedback-label': 'Usar el nuevo', onclick: () => { c.settle(conflict, 'theirs'); paint(); } }, t('conflict.useTheirs')),
          el('button', { type: 'button', class: 'primary', 'data-feedback-id': 'guests.datos.conflicto.mio', 'data-feedback-label': 'Quedarme con el mío', onclick: () => { c.settle(conflict, 'mine'); paint(); } }, t('conflict.keepMine')))))));
    };
    paint();
  }

  async function ensurePerson(grant: Grant): Promise<GuestContext> {
    if (person?.grant.guest_id === grant.guest_id) return person.ctx;
    person?.ctx.destroy();
    person = null;
    const opened = await openGuest(api, reads, userId, grant);
    person = { grant, ctx: opened };
    opened.onChange((reason) => {
      paintSaveState();
      if (reason === 'conflict') showConflicts();
      if (reason === 'rejected') toast((opened.lastRejected()?.error as { code?: string })?.code === 'PREVIEW_READ_ONLY' ? t('preview.readOnly') : describeError(opened.lastRejected()?.error));
    });
    paintSaveState();
    return opened;
  }

  async function picker(grants: Grant[]): Promise<void> {
    replace(main, loading());
    const cards = await Promise.all(grants.map(async (grant) => {
      try { return { grant, guest: (await api.myGuest(grant.guest_id)).value as MyGuest | null }; } catch { return { grant, guest: null }; }
    }));
    replace(main,
      el('div', { class: 'pagehead' }, el('h2', null, t('picker.title')), el('p', { class: 'muted' }, t('picker.intro'))),
      el('div', { class: 'gcards', id: 'people' }, ...cards.map(({ grant, guest }) => fbIgnore(el('a', {
        class: 'card gcard glink', href: `#/p/${grant.guest_id}`, 'data-feedback-id': 'guests.inicio.selector.abrir', 'data-feedback-label': 'Persona y retiro',
      }, icon('user', 20), el('span', null,
        el('strong', null, guest ? String(guest.fields.first_name ?? '') : t('picker.unknown')),
        el('span', { class: 'muted small' }, guest ? `${guest.reservation.title} · ${dateRange(guest.reservation.start_date, guest.reservation.end_date)}` : '')))))));
  }

  async function route(): Promise<void> {
    const hash = location.hash && location.hash !== '#' ? location.hash : '#/';
    unmountView?.();
    unmountView = null;
    const grants = api.grants();
    const match = hash.match(PERSON);
    const grant = match ? grants.find((g) => g.guest_id === match[1]!.toLowerCase()) : null;
    if (!grant) {
      if (grants.length === 1) { navigate(`#/p/${grants[0]!.guest_id}`, true); return; }
      person?.ctx.destroy(); person = null; paintSaveState(); previewBand.hidden = true;
      shell.setNav([], []);
      if (!grants.length) { replace(main, el('p', { class: 'card gcard', id: 'noAccess' }, t('error.noAccess'))); return; }
      main.setAttribute('data-feedback-id', 'guests.inicio');
      main.setAttribute('data-feedback-label', 'Inicio');
      await picker(grants);
      return;
    }
    let page = (match?.[2] ?? 'inicio').toLowerCase() as Page;
    const base = `#/p/${grant.guest_id}`;
    replace(main, loading());
    let gctx: GuestContext;
    try {
      await texts;
      gctx = await ensurePerson(grant);
    } catch (error) {
      replace(main, failure(error, () => void route()));
      return;
    }
    if (location.hash !== hash && !(hash === '#/' && location.hash === '')) return; // otra ruta mientras cargaba
    const mods = modulesOf(gctx);
    const moduleKey = MODULE_OF[page];
    if (moduleKey && !mods[moduleKey]) page = 'inicio';
    previewBand.hidden = !gctx.readOnly();
    previewBand.textContent = gctx.readOnly() ? t('preview.band') : '';
    main.setAttribute('data-feedback-id', PAGE_IDS[page][0]);
    main.setAttribute('data-feedback-label', PAGE_IDS[page][1]);
    document.title = `${t(`page.${page}`)} · Ikisai Guests`;
    const guarded = ['inicio', 'datos', 'alimentacion', 'firma', 'preguntas', 'alojamiento'].includes(page);
    if (guarded && needsPrivacy(gctx)) {
      renderPrivacy(main, gctx, () => void route());
      return;
    }
    const during = momentOf(gctx.guest()) === 'during';
    const items = navItems(gctx, base, mods);
    shell.setNav(items.nav, items.more);
    shell.setRoute(page === 'inicio' ? base : `${base}/${page}`);
    const help = (start?: 'place' | 'event') => openHelp({ client, userId, grant, ...(start ? { start } : {}) });
    switch (page) {
      case 'datos': unmountView = mountData(main, gctx, base); break;
      case 'alimentacion': unmountView = mountDiet(main, gctx, base); break;
      case 'firma': unmountView = mountSign(main, gctx, base); break;
      case 'info': unmountView = mountInfo(main, base, during, gctx.reads); break;
      case 'programa': unmountView = mountProgram(main, gctx); break;
      case 'menu': {
        const notice = commonText('guests.menu_notice');
        unmountView = mountMenu(main, gctx, notice ? centralText(notice.body, notice.spanishOnly, { id: 'menuNotice', class: 'gtext muted small' }) : null);
        break;
      }
      case 'alojamiento': unmountView = mountLodging(main, gctx); break;
      case 'materiales': unmountView = mountMaterials(main, gctx, userId); break;
      case 'preguntas': unmountView = mountQuestions(main, gctx); break;
      default: unmountView = mountHome(main, gctx, {
        base,
        modules: mods,
        openHelp: help,
        openAccess: () => void openAccess(api),
        openInstall: () => void openInstall(),
      });
    }
    if (gctx.conflicts().length) showConflicts();
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  const offStatus = client.onStatus(() => { if (!client.session()) ctx.onLogout(); });
  const onHash = () => void route();
  window.addEventListener('hashchange', onHash);
  void route();

  return () => {
    offStatus();
    offSessionEnd();
    usage.destroy();
    unmountView?.();
    person?.ctx.destroy();
    window.removeEventListener('hashchange', onHash);
    shell.destroy();
    replace(root, el('div'));
  };
}
