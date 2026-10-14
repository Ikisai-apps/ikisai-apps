/**
 * Cabecera del kit con el lanzador (sesión única) y «Ayuda y sugerencias», idioma, rutas del portal, estado de guardado
 * y conflictos (API.md §9). Guests por persona (O4a, decisión del usuario del 13-10-2026): barra «Calendario · Retiros ·
 * Más»; en «Retiros», el selector de persona, las pestañas de retiros y las secciones de cada uno. Rutas:
 * - `#/`: el retiro de entrada (el del enlace con el que se entró, el que está en curso o el próximo) o, si no hay, el calendario;
 * - `#/calendario`: el calendario de la persona con sus retiros;
 * - `#/p/<guestId>[/datos|/alimentacion|/firma|/info|/programa|/menu|/alojamiento|/materiales|/preguntas]`: una persona
 *   en un retiro, como antes (los enlaces directos siguen valiendo);
 * - `#/r/<reservationId>[/programa|/menu|/alojamiento]`: la familia junta en un retiro con varias personas de la cuenta.
 * En la vista previa del organizador, franja de solo lectura.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, createAppLauncher, createAppShell, createUsage, el, icon, openSheet, replace, toast, type LauncherCatalog } from '@ikisai/ui-kit';
import { createGuestApi, type Grant } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { describeError } from '../app/client.ts';
import { commonText, loadCommonTexts } from '../app/common-texts.ts';
import { openGuest, type GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { fieldLabel } from '../app/labels.ts';
import { createPortalReads } from '../app/portal.ts';
import { buildRoster, defaultRetreat, entriesFor, entryRetreat, loadRoster, type Retreat, type Roster, type Selection } from '../app/roster.ts';
import { openAccess, openInstall } from './access.ts';
import { mountCalendar } from './calendar.ts';
import { centralText, failure, fbIgnore, loading } from './common.ts';
import { mountData } from './data.ts';
import { mountDiet } from './diet.ts';
import { openHelp } from './help.ts';
import { momentOf, mountHome, todayMadrid } from './home.ts';
import { mountInfo } from './info.ts';
import { mountFamilyLodging, mountLodging } from './lodging.ts';
import { clearOfflineMaterials, mountMaterials } from './materials.ts';
import { barItems, modulesOf, moreItems, sectionsOf, type Modules, type Section } from './nav.ts';
import { mountMenu, mountProgram } from './program.ts';
import { mountQuestions } from './questions.ts';
import { languageSelect } from './language.ts';
import { needsPrivacy, renderPrivacy } from './privacy.ts';
import { personSelector, retreatTabs, sectionLinks } from './retreats.ts';
import { mountSign } from './sign.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
  /** Para el aviso de actualización: hay cambios sin confirmar. */
  setBusy(busy: () => boolean): void;
  /** Ficha del enlace con el que se entró (C10): es el retiro de entrada. */
  linkedGuestId?: string | null;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PERSON = new RegExp(`^#/p/(${UUID})(?:/(datos|alimentacion|firma|info|programa|menu|alojamiento|materiales|preguntas))?$`, 'i');
const FAMILY = new RegExp(`^#/r/(${UUID})(?:/(programa|menu|alojamiento))?$`, 'i');
const CALENDAR = '#/calendario';
type Page = 'inicio' | 'datos' | 'alimentacion' | 'firma' | 'info' | 'programa' | 'menu' | 'alojamiento' | 'materiales' | 'preguntas' | 'calendario';
/** Ids literales de cada pantalla (el catálogo de la publicación los recoge del código). */
const PAGE_IDS: Record<Page, [string, string]> = {
  inicio: ['guests.inicio', 'Inicio'], datos: ['guests.datos', 'Mis datos'], alimentacion: ['guests.alimentacion', 'Alimentación'],
  firma: ['guests.firma', 'Firma'], info: ['guests.info', 'Información práctica'], programa: ['guests.programa', 'Programa'],
  menu: ['guests.menu', 'Menú'], alojamiento: ['guests.alojamiento', 'Alojamiento'], materiales: ['guests.materiales', 'Materiales'],
  preguntas: ['guests.preguntas', 'Preguntas del organizador'], calendario: ['guests.calendario', 'Calendario'],
};
/** Páginas de un módulo del organizador: solo existen si está activo (si no, se vuelve al Resumen). */
const MODULE_OF: Partial<Record<Page, keyof Modules>> = { programa: 'program', menu: 'menu', alojamiento: 'lodging', materiales: 'materials', preguntas: 'questions' };
/** Pantallas con datos de la ficha: antes, el aviso de protección de datos. */
const GUARDED: Page[] = ['inicio', 'datos', 'alimentacion', 'firma', 'preguntas', 'alojamiento'];
const SAVE_ORDER = ['idle', 'saved', 'saving', 'offline', 'error'] as const;

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
  /** Fichas abiertas (una persona en un retiro); con la familia junta, varias a la vez. */
  const open = new Map<string, Promise<GuestContext>>();
  const opened = new Map<string, GuestContext>();
  /** La ficha principal de lo que se ve: guardado, vista previa, ayuda y «Más». */
  let primary: GuestContext | null = null;
  let roster: Roster | null = null;
  let rosterLoad: Promise<Roster> | null = null;
  /** «Todos» por defecto (la familia junta); una ruta de una persona en un retiro compartido la elige. */
  let selection: Selection = 'all';
  /** El último retiro visto: a él lleva «Retiros» desde el calendario. */
  let lastRetreat: { reservation_id: string; hash: string; base: string; family: boolean } | null = null;

  const launcher = createAppLauncher({
    current: 'guests',
    fetchApps: async () => client.api<LauncherCatalog>('/apps'),
    center: () => openHelp({ client, userId, grant: primary?.grant ?? null }),
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
    // Barra del kit 0.21: «Calendario · Retiros · Más» (O4a).
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
  const busy = () => [...opened.values()].some((c) => c.writer.busy());
  ctx.setBusy(busy);

  let unmountView: (() => void) | null = null;

  async function logout(): Promise<void> {
    const ok = await confirmDialog({
      title: t('shell.logoutTitle'),
      text: busy() ? t('shell.logoutPending') : t('shell.logoutText'),
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

  /** Estado de guardado de todas las fichas abiertas: el más urgente y la suma de lo pendiente. */
  function paintSaveState(): void {
    const writers = [...opened.values()].map((c) => c.writer);
    const state = writers.reduce<(typeof SAVE_ORDER)[number]>((worst, w) => {
      const s = w.state() as (typeof SAVE_ORDER)[number];
      return SAVE_ORDER.indexOf(s) > SAVE_ORDER.indexOf(worst) ? s : worst;
    }, 'idle');
    const count = writers.reduce((n, w) => n + w.pending(), 0);
    saveState.dataset.state = state;
    saveState.textContent = !writers.length ? '' : state === 'saving' ? t('save.globalSaving', { count })
      : state === 'offline' ? t('save.globalOffline', { count })
      : state === 'error' ? t('save.globalError') : state === 'saved' ? t('save.globalSaved') : '';
  }

  function showConflicts(c: GuestContext): void {
    if (!c.conflicts().length) return;
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

  /** Abre las fichas que hacen falta y cierra las demás (su cola sigue en IndexedDB y se envía al volver). */
  async function ensureContexts(grants: Grant[]): Promise<GuestContext[]> {
    const wanted = new Set(grants.map((g) => g.guest_id));
    for (const [id, c] of opened) if (!wanted.has(id)) { c.destroy(); opened.delete(id); open.delete(id); }
    return Promise.all(grants.map((grant) => {
      let pending = open.get(grant.guest_id);
      if (!pending) {
        pending = openGuest(api, reads, userId, grant).then((c) => {
          if (open.get(grant.guest_id) !== pending) { c.destroy(); return c; } // se cerró mientras abría
          opened.set(grant.guest_id, c);
          c.onChange((reason) => {
            paintSaveState();
            if (reason === 'conflict') showConflicts(c);
            if (reason === 'rejected') toast((c.lastRejected()?.error as { code?: string })?.code === 'PREVIEW_READ_ONLY' ? t('preview.readOnly') : describeError(c.lastRejected()?.error));
            if (reason === 'guest' && roster) roster = buildRoster(roster.entries.map((e) => (e.grant.guest_id === grant.guest_id ? { grant: e.grant, guest: c.guest() } : e)));
          });
          paintSaveState();
          return c;
        });
        pending.catch(() => open.delete(grant.guest_id));
        open.set(grant.guest_id, pending);
      }
      return pending;
    }));
  }

  function getRoster(): Promise<Roster> {
    rosterLoad ??= loadRoster(api).then((r) => (roster = r));
    return rosterLoad;
  }

  /** Enlace a un retiro con la selección: la familia junta (`#/r/`) si hay varias personas, o la ficha de la persona (`#/p/`). */
  function hrefFor(retreat: Retreat, section: Section = 'inicio', sel: Selection = selection): string {
    const seen = entriesFor(retreat, sel);
    const list = seen.length ? seen : retreat.entries;
    const tail = section === 'inicio' ? '' : `/${section}`;
    return list.length > 1 ? `#/r/${retreat.reservation_id}${tail}` : `#/p/${list[0]!.grant.guest_id}${tail}`;
  }

  /** Nombres de a quién toca un retiro con «Todos», si no es de todos. */
  function who(retreat: Retreat): string {
    if (!roster || selection !== 'all' || roster.persons.length < 2 || retreat.entries.length >= roster.persons.length) return '';
    return retreat.entries.map((e) => roster!.persons.find((p) => p.key === e.person)?.name ?? '').filter(Boolean).join(', ');
  }

  function pickPerson(next: Selection, current: { retreat: Retreat; section: Section } | null): void {
    selection = next;
    const r = roster!;
    if (current && entriesFor(current.retreat, next).length) { navigate(hrefFor(current.retreat, current.section)); return; }
    if (!current) { void route(); return; }
    const target = entryRetreat(r, next, todayMadrid()) ?? defaultRetreat(r, next, todayMadrid());
    navigate(target ? hrefFor(target) : CALENDAR);
  }

  function setPageMarks(page: Page): void {
    main.setAttribute('data-feedback-id', PAGE_IDS[page][0]);
    main.setAttribute('data-feedback-label', PAGE_IDS[page][1]);
    document.title = `${t(`page.${page}`)} · Ikisai Guests`;
  }

  /** Barra y «Más» del retiro que se ve (o del último visto, desde el calendario). */
  function paintNav(route: string, current: { base: string; hash: string; family: boolean; ctx: GuestContext; mods: Modules; sections: Section[] } | null): void {
    const r = roster!;
    const fallback = !current && !lastRetreat ? defaultRetreat(r, selection, todayMadrid()) : null;
    const retreats = current
      ? { hash: current.hash, matches: current.sections.map((s) => (s === 'inicio' ? current.hash : `${current.hash}/${s}`)) }
      : lastRetreat ? { hash: lastRetreat.hash, matches: [] } : fallback ? { hash: hrefFor(fallback), matches: [] } : null;
    const moreCtx = current?.ctx ?? (lastRetreat ? opened.get(primary?.grant.guest_id ?? '') ?? null : null);
    const more = moreCtx ? moreItems(moreCtx, current?.base ?? lastRetreat!.base, current?.mods ?? modulesOf(moreCtx), current?.family ?? lastRetreat!.family) : [];
    shell.setNav(barItems(retreats), more);
    shell.setRoute(route);
  }

  async function showCalendar(view: HTMLElement): Promise<void> {
    const r = roster!;
    setPageMarks('calendario');
    previewBand.hidden = true;
    paintNav(CALENDAR, null);
    unmountView = mountCalendar(view, r, selection, { href: (retreat) => hrefFor(retreat), navigate, who }, personSelector(r.persons, selection, (next) => pickPerson(next, null)));
  }

  async function route(): Promise<void> {
    const hash = location.hash && location.hash !== '#' ? location.hash : '#/';
    unmountView?.();
    unmountView = null;
    const grants = api.grants();
    if (!grants.length) {
      shell.setNav([], []);
      replace(main, el('p', { class: 'card gcard', id: 'noAccess' }, t('error.noAccess')));
      return;
    }
    if (!roster) replace(main, loading());
    let r: Roster;
    try {
      [r] = await Promise.all([getRoster(), texts]);
    } catch (error) {
      replace(main, failure(error, () => void route()));
      return;
    }
    if (location.hash !== hash && !(hash === '#/' && location.hash === '')) return; // otra ruta mientras cargaba
    const view = el('div', { class: 'gview', id: 'view' });
    const today = todayMadrid();

    if (hash.toLowerCase() === CALENDAR) {
      replace(main, view);
      await showCalendar(view);
      main.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
      return;
    }

    const pm = hash.match(PERSON);
    const fm = hash.match(FAMILY);
    const grant = pm ? grants.find((g) => g.guest_id === pm[1]!.toLowerCase()) : null;
    const familyRetreat = fm ? r.retreats.find((x) => x.reservation_id === fm[1]!.toLowerCase()) ?? null : null;
    if (!grant && !(familyRetreat && familyRetreat.entries.length > 1)) {
      // `#/` o una ruta que ya no vale: el retiro de entrada o, si no hay, el calendario.
      if (familyRetreat) { navigate(hrefFor(familyRetreat, (fm![2]?.toLowerCase() ?? 'inicio') as Section, 'all'), true); return; }
      const target = entryRetreat(r, selection, today, ctx.linkedGuestId);
      navigate(target ? hrefFor(target) : CALENDAR, true);
      return;
    }

    // Retiro, personas y selección que corresponden a la ruta.
    const retreat = familyRetreat ?? r.retreats.find((x) => x.entries.some((e) => e.grant.guest_id === grant!.guest_id))!;
    const entry = grant ? retreat.entries.find((e) => e.grant.guest_id === grant.guest_id)! : null;
    if (familyRetreat) selection = 'all';
    else if (retreat.entries.length > 1 || (selection !== 'all' && selection !== entry!.person)) selection = entry!.person;
    const family = Boolean(familyRetreat);
    const grantsHere = family ? retreat.entries.map((e) => e.grant) : [grant!];
    let page = ((family ? fm![2] : pm![2]) ?? 'inicio').toLowerCase() as Page;

    replace(main, loading());
    let ctxs: GuestContext[];
    try {
      ctxs = await ensureContexts(grantsHere);
    } catch (error) {
      replace(main, failure(error, () => void route()));
      return;
    }
    if (location.hash !== hash) return;
    const gctx = ctxs[0]!;
    primary = gctx;
    const base = family ? `#/r/${retreat.reservation_id}` : `#/p/${gctx.grant.guest_id}`;
    const personBase = `#/p/${gctx.grant.guest_id}`;
    const mods = modulesOf(gctx);
    const moduleKey = MODULE_OF[page];
    if (moduleKey && !mods[moduleKey]) page = 'inicio';
    previewBand.hidden = !gctx.readOnly();
    previewBand.textContent = gctx.readOnly() ? t('preview.band') : '';
    setPageMarks(page);
    const sections = sectionsOf(mods);
    lastRetreat = { reservation_id: retreat.reservation_id, hash: base, base: personBase, family };
    const current = { base: personBase, hash: base, family, ctx: gctx, mods, sections };
    const routeHash = page === 'inicio' ? base : `${base}/${page}`;

    if (GUARDED.includes(page) && ctxs.some((c) => needsPrivacy(c))) {
      paintNav(routeHash, current);
      replace(main, view);
      renderPrivacy(view, ctxs, () => void route());
      return;
    }
    paintNav(routeHash, current);

    // Cabecera de «Retiros» solo en el Resumen y en las secciones; las demás pantallas tienen su «Volver».
    const inTab = (sections as Page[]).includes(page);
    const frame = inTab ? el('div', { class: 'gframe', id: 'retreatFrame' },
      personSelector(r.persons, selection, (next) => pickPerson(next, { retreat, section: page as Section })),
      retreatTabs({
        retreats: r.retreats.filter((x) => entriesFor(x, selection).length),
        current: retreat.reservation_id,
        href: (x) => hrefFor(x, page as Section),
        who,
      }),
      sectionLinks(sections, page as Section, (s) => (s === 'inicio' ? base : `${base}/${s}`))) : null;
    replace(main, frame && frame.childElementCount ? frame : null, view);

    const during = momentOf(gctx.guest()) === 'during';
    const help = (start?: 'place' | 'event') => openHelp({ client, userId, grant: gctx.grant, ...(start ? { start } : {}) });
    const people = ctxs.map((c) => ({ ctx: c, base: `#/p/${c.grant.guest_id}` }));
    switch (page) {
      case 'datos': unmountView = mountData(view, gctx, personBase); break;
      case 'alimentacion': unmountView = mountDiet(view, gctx, personBase); break;
      case 'firma': unmountView = mountSign(view, gctx, personBase); break;
      case 'info': unmountView = mountInfo(view, personBase, during, gctx.reads); break;
      case 'programa': unmountView = mountProgram(view, gctx); break;
      case 'menu': {
        const notice = commonText('guests.menu_notice');
        unmountView = mountMenu(view, gctx, notice ? centralText(notice.body, notice.spanishOnly, { id: 'menuNotice', class: 'gtext muted small' }) : null);
        break;
      }
      case 'alojamiento': unmountView = family ? mountFamilyLodging(view, people) : mountLodging(view, gctx); break;
      case 'materiales': unmountView = mountMaterials(view, gctx, userId); break;
      case 'preguntas': unmountView = mountQuestions(view, gctx); break;
      default: unmountView = mountHome(view, gctx, {
        base: personBase,
        modules: mods,
        ...(family ? { family: people } : {}),
        openHelp: help,
        openAccess: () => void openAccess(api),
        openInstall: () => void openInstall(),
      });
    }
    for (const c of ctxs) if (c.conflicts().length) showConflicts(c);
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
    for (const c of opened.values()) c.destroy();
    window.removeEventListener('hashchange', onHash);
    shell.destroy();
    replace(root, el('div'));
  };
}
