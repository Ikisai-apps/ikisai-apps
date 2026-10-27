/**
 * El portal del visitante (API.md §9.19): `#/v` («Mis eventos» de este móvil) y `#/v/<código>` (el evento del QR). Sin
 * sesión: se entra sin dar ningún dato y lo que se deja (nombre, contacto, nota) es voluntario, con su para qué y su
 * conservación al lado. Las ofertas son la pieza de §9.18 sin cruce personal (el visitante no indicó nada); «Mi pedido»
 * es su cliente de Flow (FL2: `visitor_join` al tocar, `flow_visitor_customer` para pintar); sin Flow, la carta pública.
 * Un visitante nunca ve a otros.
 */
import { clearGuideLink, clearReturnTo, createFieldPointer, createGuide, currentGuideLink, currentReturnTo, el, fieldAttrs, flowGuideSource, type GuideApiClient, icon, onSaved, replace, toast } from '@ikisai/ui-kit';
import { contactEmail } from '../app/common-texts.ts';
import { t } from '../app/i18n.ts';
import { FLOW_CARTA, offersForGuest, safeUrl } from '../app/offers.ts';
import { whenOf, type When } from '../app/roster.ts';
import { bindMember, claimGuest, createHandoff, ensureVisitor, visitorMe, errorCodeOf, withHandoff, forgetVisitor, unlockLodging, myEventCodes, myRequests, publicEvent, publicEvents, rememberEvent, sendRequest, sendStay, takeRenewed, visitorCustomer, visitorJoin, visitorOffers, visitorToken,
  EVENT_CODE, type PublicEvent, type VisitorCustomer, type VisitorRequest } from '../app/visitor.ts';
import { failure, loading, staleNote, whyNote } from './common.ts';
import { retreatState, shortRange } from './frame.ts';
import { todayMadrid } from './home.ts';
import { languageSelect } from './language.ts';
import { offersBlock } from './offers.ts';
import { accessBox } from './visitor-access.ts';
import { mountLodge } from './lodge.ts';
import { stayBlock, stayRequestText } from './stay.ts';

const LIST = '#/v';
/** Nombres visibles de las apps (para «Entras como…»). */
const APP_NAMES: Record<string, string> = { guests: 'Guests', flow: 'Flow', booking: 'Booking', food: 'Food', invoices: 'Finance', tasks: 'Tasks', central: 'Central', organizers: 'Organizers', resources: 'Recursos' };
const EVENT = /^#\/v\/([A-Za-z0-9]{10})(?:\/(alojate|datos))?$/;

/** ¿Es una ruta del portal del visitante? */
export function isVisitorHash(hash: string): boolean {
  return hash === LIST || EVENT.test(hash);
}

const KINDS = ['retiro', 'jornadas_abiertas', 'familiar'];
const kindText = (kind: string) => (KINDS.includes(kind) ? t(`visitor.kind.${kind}`) : '');
const STATES = ['pendiente', 'aceptada', 'atendida', 'descartada'];
const requestText = (r: VisitorRequest) => (STATES.includes(r.status) ? t(`visitor.req.${r.status}`) : r.status);
const ORDER_STATES = ['open', 'paid', 'delivered'];
const orderText = (status: string) => (ORDER_STATES.includes(status) ? t(`visitor.ost.${status}`) : status);

/** El cliente de la app, para el Guiado completo de Flow cuando en este móvil hay sesión de un miembro de Flow. */
export type VisitorGuideClient = GuideApiClient & { session(): { token: string } | null };

export function renderVisitor(root: HTMLElement, client?: VisitorGuideClient | null): () => void {
  let alive = true;
  let token = 0;
  const main = el('main', { class: 'gview gvisitor', id: 'visitor', tabindex: '-1', 'data-feedback-id': 'guests.visitante', 'data-feedback-label': 'Portal del visitante' });
  // Guiado del kit (#948) sin la cáscara: el visitante no usa `createAppShell`, así que se monta aquí.
  // - Completo (`?guia=`) solo con sesión de un miembro de Flow en este móvil (p. ej. VG probando): lee y confirma los pasos
  //   en Flow (`flow.guide_read` y `flow.guide_confirm`, por las capacidades de guests-api; confirmado por Flow, 27-10).
  // - Mínimo para el visitante anónimo: el campo se señala tras cada pantalla y, al guardarlo (`announceSaved`), se dice y
  //   se ofrece volver; el paso se cierra con «Hecho» en Flow.
  const origin = currentReturnTo();
  const link = currentGuideLink();
  const run = link?.run ?? null;
  const source = run && client?.session() ? flowGuideSource(client, { app: 'guests' }) : null;
  const guide = run && source
    ? createGuide({
      load: () => source.load(run),
      onConfirmed: (step, info) => source.confirm(run, step, info),
      onSkipped: source.skip ? (step) => source.skip!(run, step) : undefined,
      navigate: (route) => { location.hash = route; },
      feedbackId: 'guests.visitante.cabecera.guia',
    })
    : null;
  const pointer = !guide && link?.field ? createFieldPointer(link, { feedbackId: 'guests.visitante.cabecera.guia' }) : null;
  const back = origin ? el('a', { class: 'return-link', href: origin.url, 'data-feedback-id': 'guests.visitante.cabecera.volver', 'data-feedback-label': 'Volver a la guía',
    onclick: () => { clearReturnTo(); clearGuideLink(); } }, icon('chevronLeft', 18), el('span', null, t('visitor.backTo', { place: origin.title ?? origin.from ?? t('visitor.backGuide') }))) : null;
  // Dirección o staff con su pase (núcleo 0115): el visitante de este móvil se ata a su cuenta y se dice quién entra.
  // Flow marca lo que pida como prueba (`core.visitor_member`). Un huésped o sin red: sigue como visitante, sin aviso.
  const memberLine = el('p', { class: 'small gvisitor-member', id: 'visitorMember', role: 'status' });
  let memberTried = false;
  const bindAsMember = async (code: string) => {
    const session = client?.session();
    if (memberTried || !session) return;
    memberTried = true;
    try {
      await ensureVisitor(code);
      await bindMember(session.token);
      const me = await visitorMe();
      const apps = [...new Set((me.member?.apps ?? []).map((a) => APP_NAMES[a.app] ?? null).filter((n): n is string => !!n))].join(', ');
      if (me.member && alive) replace(memberLine, icon('guest', 14), ' ', t(apps ? 'visitor.asMember' : 'visitor.asMemberNoApps', { name: me.member.displayName ?? t('visitor.memberSomeone'), apps }));
    } catch { /* sin pertenencia o sin red */ }
  };
  const offSaved = !guide && link?.field ? onSaved((id) => { if (id === link.field) toast(t(origin ? 'visitor.guideSaved' : 'visitor.guideDone')); }) : null;
  replace(root, el('div', { class: 'gvisitor-shell' },
    el('header', { class: 'gvisitor-top' },
      el('a', { class: 'gvisitor-brand', href: LIST, 'data-feedback-id': 'guests.visitante.cabecera.eventos', 'data-feedback-label': 'Mis eventos' },
        el('span', { class: 'mark', 'aria-hidden': 'true' }, icon('guest', 20)), el('strong', null, 'Ikisai')),
      languageSelect()),
    back, pointer?.element ?? null, memberLine,
    main, guide?.element ?? null));
  if (guide) queueMicrotask(() => void guide.start());

  const route = () => {
    const mine = ++token;
    const m = location.hash.match(EVENT);
    const shown = m ? showEvent(m[1]!.toUpperCase(), mine, (m[2] as 'alojate' | 'datos' | undefined) ?? 'evento') : showList(mine);
    if (pointer) void shown.then(() => { if (current(mine)) void pointer.point(); });
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  };
  const current = (mine: number) => alive && mine === token;

  async function showList(mine: number): Promise<void> {
    document.title = `${t('visitor.mine')} · Ikisai`;
    const codes = myEventCodes();
    if (!codes.length) {
      replace(main, el('div', { class: 'pagehead' }, el('h2', null, t('visitor.mine'))),
        el('p', { class: 'card gcard', id: 'visitorEmpty' }, t('visitor.mineEmpty')), openEvents(), footer());
      return;
    }
    replace(main, loading());
    let offline = 0;
    const events = (await Promise.all(codes.map((c) => publicEvent(c).catch((error) => { if (errorCodeOf(error) === 'NETWORK') offline++; return null; }))))
      .map((x) => x?.value ?? null).filter((e): e is PublicEvent => Boolean(e));
    if (!current(mine)) return;
    // Los que no se pueden abrir no desaparecen sin más: sin red, o el evento ya no existe o cambió su código.
    const gone = codes.length - events.length - offline;
    const why = [offline ? whyNote('visitorListOffline', t('visitor.listOffline', { count: offline })) : null,
      gone > 0 ? whyNote('visitorListGone', t('visitor.listGone', { count: gone })) : null];
    const today = todayMadrid();
    const by = new Map<When, PublicEvent[]>([['during', []], ['before', []], ['after', []]]);
    for (const e of events) by.get(e.starts_on ? whenOf({ start: e.starts_on, end: e.ends_on }, today) : 'before')!.push(e);
    by.get('before')!.sort((a, b) => (a.starts_on ?? '9999').localeCompare(b.starts_on ?? '9999'));
    by.get('after')!.sort((a, b) => (b.starts_on ?? '').localeCompare(a.starts_on ?? ''));
    const LABEL: Record<When, string> = { during: 'retreats.now', before: 'retreats.next', after: 'retreats.past' };
    replace(main, el('div', { class: 'pagehead' }, el('h2', null, t('visitor.mine'))), ...why,
      ...(['during', 'before', 'after'] as When[]).filter((w) => by.get(w)!.length).map((w) => el('section', { class: 'gretreats-group', id: `visitor-${w}` },
        el('h3', null, t(LABEL[w])),
        el('ul', { class: 'gretreats' }, ...by.get(w)!.map((e) => el('li', null, el('a', {
          class: 'card gcard gretreat', href: `#/v/${e.code}`, dataset: { code: e.code },
          'data-feedback-id': 'guests.visitante.eventos.abrir', 'data-feedback-label': 'Abrir un evento',
        }, el('span', { class: 'gretreat-text' }, el('strong', null, e.name),
          el('span', { class: 'small' }, [shortRange(e.starts_on, e.ends_on), retreatState({ start: e.starts_on, end: e.ends_on }, today).text].filter(Boolean).join(' · ')),
          el('span', { class: 'gtags' }, el('span', { class: 'chip small gstatus' }, t(e.status === 'abierto' ? 'visitor.open' : 'visitor.closed')))),
        icon('chevronRight', 16))))))),
      footer());
  }

  async function showEvent(code: string, mine: number, tab: 'evento' | 'alojate' | 'datos' = 'evento'): Promise<void> {
    replace(main, loading());
    let loaded: Awaited<ReturnType<typeof publicEvent>>;
    try {
      loaded = await publicEvent(code);
    } catch (error) {
      if (current(mine)) replace(main, failure(error, () => route()));
      return;
    }
    if (!current(mine)) return;
    const event = loaded.value;
    if (!event) {
      const email = contactEmail();
      document.title = 'Ikisai';
      replace(main, el('section', { class: 'card gcard', id: 'visitorUnknown' },
        el('h2', null, t('visitor.unknownTitle')), el('p', null, t('visitor.unknownText')),
        email ? el('p', null, el('a', { href: `mailto:${email}`, 'data-feedback-id': 'guests.visitante.evento.contacto', 'data-feedback-label': 'Escribir a Ikisai' }, email)) : null),
      footer());
      return;
    }
    document.title = `${event.name} · Ikisai`;
    void bindAsMember(code);
    const today = todayMadrid();
    const head = el('section', { class: 'card gcard', id: 'visitorEvent', dataset: { code: event.code } },
      el('h2', { id: 'retreatTitle' }, event.name),
      el('p', { class: 'small' }, [shortRange(event.starts_on, event.ends_on), retreatState({ start: event.starts_on, end: event.ends_on }, today).text].filter(Boolean).join(' · ')),
      el('p', { class: 'gtags' },
        kindText(event.kind) ? el('span', { class: 'chip small' }, kindText(event.kind)) : null,
        el('span', { class: 'chip small gstatus' }, t(event.status === 'abierto' ? 'visitor.open' : 'visitor.closed'))),
      event.summary ? el('p', { id: 'visitorSummary' }, event.summary) : null);

    // «Alójate aquí» (VG, por Core): pestaña aparte en todo evento abierto con noches (ven.ikisai.com, única entrada pública,
    // 27-10 noche; recomendación de vg-48 mientras VG no decida: visible a cualquiera en el evento abierto).
    const lodging = event.lodging;
    const tabs = lodging ? el('nav', { class: 'segmented gvisitor-tabs', id: 'visitorTabs', 'aria-label': t('visitor.tabs') },
      ...([['evento', `#/v/${code}`, t('visitor.tabEvent')], ['alojate', `#/v/${code}/alojate`, t('lodge.tab')]] as const).map(([key, href, label]) => el('a', {
        href, class: (tab === 'datos' ? 'evento' : tab) === key ? 'on' : '', 'aria-current': (tab === 'datos' ? 'evento' : tab) === key ? 'page' : null, dataset: { tab: key },
        ...(key === 'alojate' ? { 'data-feedback-id': 'guests.visitante.pestana.alojate', 'data-feedback-label': 'Pestaña «Alójate aquí»' }
          : { 'data-feedback-id': 'guests.visitante.pestana.evento', 'data-feedback-label': 'Pestaña «El evento»' }),
      }, label))) : null;
    if (lodging && tab === 'alojate') {
      // «Reservar antes» (la solicitud con `hold` o `pay_first`), opción secundaria y plegada.
      const stay = stayBlock(event, today, {
        send: async (input) => {
          await sendStay(code, input);
          rememberEvent(code);
          toast(t('stay.sent'));
          location.hash = `#/v/${code}`;
        },
        error: visitorError,
      });
      const later = el('details', { class: 'card gcard', id: 'lodgeLater', 'data-feedback-id': 'guests.visitante.alojate.antes', 'data-feedback-label': 'Reservar antes' },
        el('summary', null, t('lodge.later')), stay);
      rememberEvent(code);
      const lodgeHost = el('div', { id: 'lodgeHost' });
      replace(main, loaded.stale ? staleNote(loaded.at) : null, head, tabs, lodgeHost, later, footer());
      mountLodge(lodgeHost, event, today, { alive: () => current(mine) && location.hash.endsWith('/alojate') });
      return;
    }

    // Sin identidad todavía: se entra sin dar nada.
    if (!visitorToken()) {
      const enter = el('button', { type: 'button', class: 'primary wide', id: 'visitorEnter', 'data-feedback-id': 'guests.visitante.evento.entrar', 'data-feedback-label': 'Entrar como visitante',
        onclick: async () => {
          enter.setAttribute('disabled', '');
          try { await ensureVisitor(code); rememberEvent(code); route(); } catch (error) { enter.removeAttribute('disabled'); toast(visitorError(error)); }
        } }, t('visitor.enter'));
      replace(main, loaded.stale ? staleNote(loaded.at) : null, head, tabs,
        el('section', { class: 'card gcard', id: 'visitorWelcome' }, el('p', null, t('visitor.enterText')), enter), footer());
      return;
    }
    rememberEvent(code);

    const offersHost = el('div', { id: 'visitorOffers' });
    const requestsHost = el('div', { id: 'visitorRequests', tabindex: '-1' });
    const orderHost = el('section', { class: 'card gcard', id: 'visitorOrder' });
    // Recorridos (ven.ikisai.com, única entrada pública): pedir en la barra (la carta de Flow) y, después, tus datos y
    // «Alójate aquí». Cada uno se marca hecho con lo que ya hay; la carta, al acabar, vuelve aquí con `?siguiente=`.
    const step = (key: 'carta' | 'datos' | 'alojate', label: string, attrs: NonNullable<Parameters<typeof el>[1]>) =>
      el('li', { class: 'gvisitor-route', dataset: { route: key } },
        el(attrs.href ? 'a' : 'button', { ...(attrs.href ? {} : { type: 'button' }), class: 'gvisitor-route-go', ...attrs },
          el('span', { class: 'gvisitor-route-mark', 'aria-hidden': 'true' }), el('span', null, label), icon('chevronRight', 16)));
    const routes = el('ol', { class: 'gvisitor-routes', id: 'visitorRoutes', 'aria-label': t('visitor.routes') },
      step('carta', t('visitor.routeCarta'), { onclick: () => void openCarta(code, orderHost, mine), 'data-feedback-id': 'guests.visitante.recorrido.carta', 'data-feedback-label': 'Pedir en la barra' }),
      step('datos', t('visitor.routeDatos'), { href: `#/v/${code}/datos`, 'data-feedback-id': 'guests.visitante.recorrido.datos', 'data-feedback-label': 'Tus datos' }),
      lodging ? step('alojate', t('lodge.tab'), { href: `#/v/${code}/alojate`, 'data-feedback-id': 'guests.visitante.recorrido.alojate', 'data-feedback-label': 'Alójate aquí' }) : null);
    const done = (key: 'carta' | 'datos' | 'alojate') => {
      const item = routes.querySelector<HTMLElement>(`[data-route="${key}"]`);
      if (item && !item.dataset.done) { item.dataset.done = 'true'; item.querySelector('.gvisitor-route-mark')?.replaceChildren(icon('check', 14)); const go = item.querySelector<HTMLElement>('.gvisitor-route-go'); go?.setAttribute('aria-label', `${go.textContent ?? ''} · ${t('visitor.routeDone')}`); }
    };
    replace(main, loaded.stale ? staleNote(loaded.at) : null, head, tabs, el('section', { class: 'card gcard', id: 'visitorRoutesBox' }, el('h3', null, t('visitor.routes')), routes),
      offersHost, orderHost, requestsHost, invitation(), footer());
    const join = async () => { const c = await visitorJoin(code); return { number: c.number, carta_url: c.carta_url, account_open: c.account_open }; };

    // Ofertas públicas (FD5): la pieza del Menú, sin cruce personal.
    void visitorOffers(code).then((raw) => {
      if (!current(mine)) return;
      const offers = offersForGuest(raw.value, null, null);
      const eater = { guestId: 'visitante', name: null, base: '', restrictions: [], team: false };
      const days = offers.days.map((d) => d.date);
      const day = days.includes(today) ? today : days[0];
      const block = day ? offersBlock(day, today, [{ eater, offers }], false, () => join().catch(() => null)) : null;
      replace(offersHost, block ? el('div', null, block, el('p', { class: 'small', id: 'visitorAllergies' }, icon('warn', 14), ' ', t('visitor.allergies'))) : null);
    }).catch((error) => { if (current(mine)) replace(offersHost, whyNote('visitorOffersWhy', errorCodeOf(error) === 'NETWORK' ? t('error.offline') : t('visitor.offersFailed'))); });

    void paintOrder(code, orderHost, mine).then((ordered) => { if (ordered) done('carta'); });
    void paintRequests(code, event, requestsHost, mine).then((kinds) => {
      if (kinds.has('join') || kinds.has('contact')) done('datos');
      if (kinds.has('stay')) done('alojate');
      // `?siguiente=datos` (de la carta) o el recorrido «Tus datos»: a lo que se pide aquí.
      if (tab === 'datos' && current(mine)) { requestsHost.scrollIntoView({ block: 'start' }); requestsHost.focus({ preventScroll: true }); }
    });
  }

  /**
   * «Pedir en la barra»: se une a la carta (`visitor_join`, idempotente) y la abre con el traspaso de esta identidad
   * (`?v=`), para que la carta de Flow sea el mismo visitante. Sin Flow, la carta pública.
   */
  let cartaBusy = false;
  async function openCarta(code: string, host: HTMLElement, mine: number): Promise<void> {
    if (cartaBusy) return;
    cartaBusy = true;
    // Un toque a la vez: si no, cada uno abre otra pestaña y pide otro traspaso.
    const buttons = [...main.querySelectorAll<HTMLButtonElement>('#visitorCarta, .gvisitor-route[data-route="carta"] button')];
    buttons.forEach((b) => { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
    const win = window.open('about:blank', '_blank'); // en el toque, para que el navegador no la bloquee
    try {
      let url: string | null = FLOW_CARTA;
      try {
        url = safeUrl((await visitorJoin(code)).carta_url) ?? FLOW_CARTA;
      } catch (error) {
        if (errorCodeOf(error) === 'NO_FLOW') { win?.close(); toast(t('visitor.noFlow')); return; }
      }
      const target = withHandoff(url, await createHandoff());
      if (win) { win.opener = null; win.location.href = target; } else window.location.href = target;
      void paintOrder(code, host, mine);
    } finally {
      cartaBusy = false;
      buttons.forEach((b) => { b.disabled = false; b.removeAttribute('aria-busy'); });
    }
  }

  /**
   * «Mi pedido» (FL2): su número, si tiene cuenta y sus pedidos, de `flow_visitor_customer`. «Abrir la carta» se une con
   * `visitor_join` (idempotente; le da número, sin cuenta) y abre su enlace de un solo uso. Sin Flow, la carta pública.
   */
  async function paintOrder(code: string, host: HTMLElement, mine: number): Promise<boolean> {
    const customer: VisitorCustomer | null = await visitorCustomer(code).catch(() => null);
    if (!current(mine)) return false;
    const status = el('p', { class: 'small', id: 'visitorNumber', role: 'status' },
      customer?.number ? t('visitor.number', { number: customer.number }) : customer ? t('visitor.noNumber') : t('visitor.orderText'),
      customer?.number ? ` ${customer.account_open ? t('offers.accountOpen') : t('offers.accountClosed')}` : '');
    const open = el('button', { type: 'button', class: 'primary goffer-open', id: 'visitorCarta', 'data-feedback-id': 'guests.visitante.pedido.abrir', 'data-feedback-label': 'Abrir la carta',
      onclick: () => void openCarta(code, host, mine) }, icon('menu', 16), ' ', t('visitor.routeCarta'));
    const orders = customer?.orders.length ? el('ul', { class: 'gvisitor-sent', id: 'visitorOrders' }, ...customer.orders.map((o) => el('li', { dataset: { status: o.status } },
      el('strong', null, o.summary || t('visitor.order')), ' · ', orderText(o.status), o.preparing ? ` · ${t('visitor.preparing')}` : '', o.number ? ` · ${t('visitor.number', { number: o.number })}` : ''))) : null;
    replace(host, el('h3', null, t('visitor.order')), status, open, orders);
    return Boolean(customer?.orders.length);
  }

  /** «Apuntarme» (si el evento lo admite) y «Déjanos un dato», con lo que ya pidió. */
  async function paintRequests(code: string, event: PublicEvent, host: HTMLElement, mine: number): Promise<Set<string>> {
    let failed = false;
    const list = await myRequests(code).catch(() => { failed = true; return [] as VisitorRequest[]; });
    if (!current(mine)) return new Set();
    // Lo que pidió puede no verse: no se pudo leer, o su acceso anterior ya no valía y este móvil tiene uno nuevo.
    const why = [failed ? whyNote('visitorRequestsWhy', t('visitor.requestsFailed')) : null,
      takeRenewed() ? whyNote('visitorRenewed', t('visitor.renewed')) : null];
    const joined = list.find((r) => r.kind === 'join' && r.status !== 'descartada');
    const repaint = () => void paintRequests(code, event, host, mine);
    const sent = list.length ? el('ul', { class: 'gvisitor-sent', id: 'visitorSent' }, ...list.map((r) => el('li', { dataset: { kind: r.kind, status: r.status } },
      el('strong', null, r.kind === 'join' ? t('visitor.joinSent') : r.kind === 'stay' ? t('stay.sentTitle') : t('visitor.contactSent')), ' · ', requestText(r),
      r.kind === 'stay' ? el('span', { class: 'small gstay-sent' }, stayRequestText(r)) : null,
      // Aceptada con ficha: «Tu ficha está lista» (entra con un enlace de un solo uso; el núcleo comprueba que es suya).
      r.id && r.status === 'aceptada' && (r.kind === 'join' || r.kind === 'stay') ? el('button', { type: 'button', class: 'primary small gclaim', dataset: { request: r.id },
        'data-feedback-id': 'guests.visitante.ficha.entrar', 'data-feedback-label': 'Tu ficha está lista',
        onclick: async (e: Event) => {
          const button = e.currentTarget as HTMLButtonElement;
          button.disabled = true;
          try { const out = await claimGuest(code, r.id!); location.assign(`/i/${out.loginToken}`); }
          catch (error) { button.disabled = false; toast(errorCodeOf(error) === 'NOT_FOUND' ? t('vlink.notReady') : visitorError(error)); }
        } }, t('vlink.ready')) : null))) : null;

    const field = (id: string, label: string, help: string | null, attrs: Record<string, string | null> = {}) => {
      const input = el('input', { id, class: 'input', ...attrs /* data-field-id literal en cada llamada (fieldAttrs) */ }) as HTMLInputElement;
      return { input, row: el('label', { class: 'field', for: id }, el('span', null, label), input, help ? el('span', { class: 'small' }, help) : null) };
    };
    const keep = el('p', { class: 'small' }, t('visitor.keep'));

    let join: HTMLElement | null = null;
    if (event.joinable && !joined) {
      const name = field('visitorName', t('visitor.name'), null, { autocomplete: 'given-name', maxlength: '80', required: '', ...fieldAttrs({ id: 'guests.visitante.apuntarme.nombre', entity: 'booking.visitor_requests', prop: 'name', type: 'text', required: true, sensitivity: 'personal' }) });
      const contact = field('visitorJoinContact', t('visitor.contactOptional'), t('visitor.contactWhy'), { autocomplete: 'off', maxlength: '200', ...fieldAttrs({ id: 'guests.visitante.apuntarme.contacto', entity: 'booking.visitor_requests', prop: 'contact', type: 'text', required: false, sensitivity: 'personal' }) });
      const note = field('visitorNote', t('visitor.note'), null, { maxlength: '300', ...fieldAttrs({ id: 'guests.visitante.apuntarme.nota', entity: 'booking.visitor_requests', prop: 'note', type: 'text', required: false, sensitivity: 'personal' }) });
      const send = el('button', { type: 'submit', class: 'primary', id: 'visitorJoin', 'data-feedback-id': 'guests.visitante.apuntarme.enviar', 'data-feedback-label': 'Apuntarme como visitante' }, t('retreats.join'));
      join = el('form', { class: 'card gcard', id: 'visitorJoinForm', novalidate: '',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (!name.input.value.trim()) { name.input.focus(); toast(t('visitor.nameNeeded')); return; }
          send.setAttribute('disabled', '');
          try { await sendRequest(code, { kind: 'join', name: name.input.value, contact: contact.input.value, note: note.input.value }); toast(t('visitor.joinDone')); repaint(); }
          catch (error) { send.removeAttribute('disabled'); toast(visitorError(error)); }
        } }, el('h3', null, t('visitor.joinTitle')), name.row, contact.row, note.row, keep.cloneNode(true), send);
    }

    const pendingContact = list.some((r) => r.kind === 'contact' && r.status === 'pendiente');
    let leave: HTMLElement | null = null;
    if (!pendingContact) {
      const contact = field('visitorContact', t('visitor.contact'), t('visitor.contactWhyNext'), { autocomplete: 'off', maxlength: '200', ...fieldAttrs({ id: 'guests.visitante.dato.contacto', entity: 'booking.visitor_requests', prop: 'contact', type: 'text', required: true, sensitivity: 'personal' }) });
      const send = el('button', { type: 'submit', class: 'ghost', id: 'visitorLeave', 'data-feedback-id': 'guests.visitante.dato.enviar', 'data-feedback-label': 'Dejar un dato' }, t('visitor.leave'));
      leave = el('details', { class: 'card gcard', id: 'visitorLeaveBox', 'data-feedback-id': 'guests.visitante.dato.abrir', 'data-feedback-label': 'Déjanos un dato' },
        el('summary', null, t('visitor.leaveTitle')),
        el('form', { novalidate: '', onsubmit: async (e: Event) => {
          e.preventDefault();
          if (!contact.input.value.trim()) { contact.input.focus(); toast(t('visitor.contactNeeded')); return; }
          send.setAttribute('disabled', '');
          try { await sendRequest(code, { kind: 'contact', contact: contact.input.value }); toast(t('visitor.contactDone')); repaint(); }
          catch (error) { send.removeAttribute('disabled'); toast(visitorError(error)); }
        } }, contact.row, keep.cloneNode(true), send));
    }
    replace(host, ...why, sent ? el('section', { class: 'card gcard' }, el('h3', null, t('visitor.sentTitle')), sent) : null, join, leave);
    return new Set(list.filter((r) => r.status !== 'descartada').map((r) => r.kind));
  }

  /** «Ya tengo invitación»: el vínculo consentido con su ficha es su propio enlace (`/i/<token>`). */
  function invitation(): HTMLElement {
    const input = el('input', { id: 'visitorInvite', class: 'input', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'https://guests.ikisai.com/i/…', ...fieldAttrs({ id: 'guests.visitante.invitacion.enlace', type: 'url', required: true, sensitivity: 'internal' }) }) as HTMLInputElement;
    return el('details', { class: 'card gcard', id: 'visitorInviteBox', 'data-feedback-id': 'guests.visitante.invitacion.abrir', 'data-feedback-label': 'Ya tengo invitación' },
      el('summary', null, t('visitor.invite')),
      el('p', { class: 'small' }, t('visitor.inviteText')),
      el('label', { class: 'field', for: 'visitorInvite' }, el('span', null, t('visitor.inviteLabel')), input),
      el('button', { type: 'button', class: 'ghost', 'data-feedback-id': 'guests.visitante.invitacion.abrir_enlace', 'data-feedback-label': 'Abrir mi invitación',
        onclick: () => {
          const m = input.value.trim().match(/\/i\/([A-Za-z0-9_-]{20,})\/?$/);
          if (!m) { toast(t('visitor.inviteBad')); return; }
          location.assign(`/i/${m[1]}`);
        } }, t('visitor.inviteGo')));
  }

  function footer(): HTMLElement {
    // «Guarda tu acceso» (tarjeta 3): en «Mis eventos» y en cada evento; para recuperar el de otro móvil, el mismo correo.
    const code = location.hash.match(EVENT)?.[1]?.toUpperCase() ?? null;
    return el('footer', { class: 'gvisitor-foot' },
      accessBox(code, () => route()),
      el('p', { class: 'small' }, t('visitor.onlyHere')),
      visitorToken() ? el('button', { type: 'button', class: 'ghost', id: 'visitorForget', 'data-feedback-id': 'guests.visitante.movil.salir', 'data-feedback-label': 'Salir de este móvil',
        onclick: async () => { await forgetVisitor(); location.hash = LIST; route(); } }, icon('logout', 16), ' ', t('visitor.forget')) : null);
  }

  const onHash = () => { if (isVisitorHash(location.hash)) route(); };
  window.addEventListener('hashchange', onHash);
  route();
  return () => { alive = false; offSaved?.(); guide?.destroy(); window.removeEventListener('hashchange', onHash); replace(root); };
}

function visitorError(error: unknown): string {
  switch (errorCodeOf(error)) {
    case 'NETWORK': return t('error.offline');
    case 'RESERVATION_NOT_OPEN': return t('retreats.notOpen');
    case 'RATE_LIMITED': return t('visitor.busy');
    case 'NO_AVAILABILITY': return t('stay.noAvailability');
    case 'NO_LODGING': return t('stay.noLodging');
    case 'INVALID_FIELDS': return t('error.invalid');
    default: return t('error.generic');
  }
}

/**
 * «Eventos abiertos» (ENTRADA_PUBLICA.md, tarjeta 1): los de Booking abiertos al público y los retiros con «Apuntarme»,
 * con su tipo en texto. Tocar uno abre su página de visitante (`#/v/<código>`); la identidad se crea solo al «Entrar».
 * Sin eventos o sin poder leerlos, una línea que lo dice.
 */
export function openEvents(): HTMLElement {
  const host = el('section', { class: 'gopen-events', id: 'openEvents', 'aria-labelledby': 'openEventsTitle', 'data-feedback-id': 'guests.entrada.eventos', 'data-feedback-label': 'Eventos abiertos' },
    el('h2', { id: 'openEventsTitle' }, t('visitor.openTitle')), loading());
  void publicEvents().then((loaded) => {
    const today = todayMadrid();
    const list = loaded.value.filter((e) => !e.ends_on || e.ends_on >= today)
      .sort((a, b) => (a.starts_on ?? '9999').localeCompare(b.starts_on ?? '9999'));
    replace(host, el('h2', { id: 'openEventsTitle' }, t('visitor.openTitle')), loaded.stale ? staleNote(loaded.at) : null,
      list.length ? el('ul', { class: 'gretreats' }, ...list.map((e) => el('li', null, el('a', {
        class: 'card gcard gretreat', href: `#/v/${e.code}`, dataset: { code: e.code },
        'data-feedback-id': 'guests.entrada.eventos.abrir', 'data-feedback-label': 'Abrir un evento abierto',
      }, el('span', { class: 'gretreat-text' }, el('strong', null, e.name),
        el('span', { class: 'small' }, [shortRange(e.starts_on, e.ends_on), retreatState({ start: e.starts_on, end: e.ends_on }, today).text].filter(Boolean).join(' · ')),
        el('span', { class: 'gtags' },
          kindText(e.kind) ? el('span', { class: 'chip small' }, kindText(e.kind)) : null,
          e.joinable ? el('span', { class: 'chip small' }, t('retreats.join')) : null,
          e.lodging ? el('span', { class: 'chip small' }, t('visitor.lodging')) : null)),
      icon('chevronRight', 16))))) : whyNote('openEventsNone', t('visitor.openNone')));
  }).catch((error) => replace(host, el('h2', { id: 'openEventsTitle' }, t('visitor.openTitle')),
    whyNote('openEventsWhy', errorCodeOf(error) === 'NETWORK' ? t('error.offline') : t('visitor.openFailed'))));
  return host;
}

/** `/e/<código>` → `#/v/<CÓDIGO>` (sin el código en la ruta; con `?alojate`, `#/v/<CÓDIGO>/alojate`), o null si no es una entrada de visitante. */
export function visitorEntry(pathname: string, search = ''): string | null {
  const m = pathname.match(/^\/e\/([^/?#]*)\/?$/);
  if (!m) return null;
  if (!EVENT_CODE.test(m[1] ?? '')) return LIST;
  // Con `?alojate` (o `?siguiente=alojate`, al acabar la carta de Flow), directamente en «Alójate aquí»; con
  // `?siguiente=datos`, en lo que se pide aquí.
  const code = m[1]!.toUpperCase();
  unlockLodging(code);
  const params = new URLSearchParams(search);
  const next = params.get('siguiente');
  return params.has('alojate') || next === 'alojate' ? `#/v/${code}/alojate` : next === 'datos' ? `#/v/${code}/datos` : `#/v/${code}`;
}
