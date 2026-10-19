import type { SyncStatus } from '@ikisai/sync-client';
import { el, formatDate, renderLead, renderStats, replace, type LeadItem } from '@ikisai/ui-kit';
import { PHASE_LABELS, canSeeGuests, dayNumber, depositStatus, guestModeOf, nextText, stayClashes, uncoveredNeedsSoon, type ClashAssignment, type ClashReservation } from '@ikisai/domain-booking';
import { ASSIGNMENTS, EVENTS, FINANCE, GUESTS, NEEDS, STAYS, PORTAL_REQUESTS, PROPOSALS, RATES, RESERVATIONS, SES_SETTINGS, canRead, canWrite, dateRange, shortDay, today, type ReservationRow } from '../app/client.ts';
import { PHASE_COLORS, inHouse, loadExperiences, onSesPending, resetSesWatch, requestBlock, sesCandidates, startsWithin, type ReservationView } from '../app/experience.ts';
import { onLogos, retreatLogos } from '../app/logos.ts';
import { liveStays } from '../app/stays.ts';
import { pendingJoins, type PendingJoin } from '../app/joins.ts';
import type { ViewMount } from './shell.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event as InstallPromptEvent;
});

type Filter = 'necesitan' | 'casa' | 'llegan' | 'captacion' | 'senales';
const FILTER_TITLES: Record<Filter, string> = { necesitan: 'Lo primero', casa: 'En casa ahora', llegan: 'Llegan en 7 días', captacion: 'En captación', senales: 'Señales por cobrar' };
const UPCOMING = ['pre_reservada', 'confirmada', 'en_ejecucion'];
/** Avisos que no se pliegan nunca: el plazo de SES es legal y el organizador espera respuesta (PERDIDAS §2). */
const ALWAYS_VISIBLE = new Set(['ses', 'ses_guests', 'portal', 'joins']);

/**
 * Inicio (tanda 27, MUELA-067 §1): cinco cifras que filtran, los avisos de SES y del portal a la vista, «Lo primero» con
 * las tres reservas que más piden y la cola numerada; el resto de avisos y las utilidades, plegados. Todo sale del espejo.
 */
export const mountHome: ViewMount = ({ main, client, navigate, logout }) => {
  const statsHost = el('div', { id: 'homeStats', 'data-feedback-id': 'booking.inicio.cifras', 'data-feedback-label': 'Cifras' });
  const noticesHost = el('div', { 'data-feedback-id': 'booking.inicio.avisos', 'data-feedback-label': 'Requiere atención' });
  const leadHost = el('div', { 'data-feedback-id': 'booking.inicio.proximas', 'data-feedback-label': 'Lo primero' });
  const network = el('dd');
  const pending = el('dd');
  const lastPull = el('dd');
  const role = el('dd');
  let filter: Filter = 'necesitan';
  let disposed = false;
  let joins: PendingJoin[] | null = null;
  resetSesWatch();

  function paintStatus(status: SyncStatus): void {
    network.textContent = status.network === 'online' ? 'En línea' : status.network === 'offline' ? 'Sin conexión' : status.network === 'syncing' ? 'Sincronizando…' : 'Error';
    pending.textContent = String(status.pendingCommands + status.pendingBlobs);
    lastPull.textContent = formatDate(status.lastPullAt);
    const boot = client.bootstrap();
    role.textContent = boot ? { owner: 'Propietario', editor: 'Editor', reader: 'Solo lectura', outsider: 'Outsider' }[boot.membership.role] : '—';
  }

  async function paintData(): Promise<void> {
    const now = dayNumber(today())!;
    const set = await loadExperiences(client);
    if (disposed) return;
    const { views, seesMoney } = set;
    const reservations = views.map((v) => v.reservation);
    const events = views.flatMap((v) => (v.event ? [v.event] : []));
    const logos = retreatLogos(client);
    const open = views.filter((v) => v.x.phase !== 'fuera');
    const upcoming = views.filter((v) => UPCOMING.includes(v.reservation.status) && (dayNumber(v.reservation.end_date) ?? Infinity) >= now)
      .sort((a, b) => (dayNumber(a.reservation.start_date) ?? Infinity) - (dayNumber(b.reservation.start_date) ?? Infinity));
    const owes = (v: ReservationView) => seesMoney && ['pendiente', 'parcial'].includes(depositStatus(v.finance)) && UPCOMING.includes(v.reservation.status);
    const groups: Record<Filter, ReservationView[]> = {
      necesitan: open.filter((v) => v.x.next !== null),
      casa: open.filter(inHouse),
      llegan: upcoming.filter((v) => startsWithin(v, 7)),
      captacion: open.filter((v) => v.x.phase === 'comercial'),
      senales: upcoming.filter(owes),
    };

    // Cifras de color que filtran «Lo primero»; tocar la activa la quita.
    const stat = (key: Filter, label: string, tone: 'alert' | 'warn' | 'ok' | null, feedbackId: string) => ({
      value: groups[key].length, label, tone: groups[key].length ? tone : null, feedbackId, onClick: () => { filter = filter === key && key !== 'necesitan' ? 'necesitan' : key; void paintData(); },
    });
    const stats = renderStats([
      stat('necesitan', 'Necesitan algo', 'alert', 'booking.inicio.cifras.necesitan'),
      stat('casa', 'En casa ahora', 'ok', 'booking.inicio.cifras.en_casa'),
      stat('llegan', 'Llegan en 7 días', 'warn', 'booking.inicio.cifras.llegan'),
      stat('captacion', 'En captación', null, 'booking.inicio.cifras.captacion'),
      ...(seesMoney ? [stat('senales', 'Señales por cobrar', 'warn', 'booking.inicio.cifras.senales')] : []),
    ], { label: 'Cómo va la casa' });
    const keys: Filter[] = ['necesitan', 'casa', 'llegan', 'captacion', ...(seesMoney ? ['senales' as const] : [])];
    stats.querySelectorAll('button').forEach((button, i) => { button.setAttribute('aria-pressed', String(keys[i] === filter)); button.dataset.filter = keys[i]!; });
    replace(statsHost, stats);

    // --- avisos con nombre (las 10 claves `data-notice` de siempre)
    const soon = (r: ReservationRow, days: number) => { const start = dayNumber(r.start_date); return start !== null && start >= now && start - now <= days; };
    const upcomingRows = upcoming.map((v) => v.reservation);
    const eventByReservation = new Map(events.map((e) => [e.reservation_id, e]));
    const notices: Array<[number, string, string, string?, string?]> = [
      [reservations.filter((r) => r.status === 'pre_reservada').length, 'pre-reserva pendiente de confirmar', 'pre-reservas pendientes de confirmar', undefined, 'pre'],
      [upcomingRows.filter((r) => soon(r, 30) && r.status !== 'pre_reservada' && (eventByReservation.get(r.id)?.final_guests ?? null) === null).length, 'evento próximo sin número final de personas', 'eventos próximos sin número final de personas', undefined, 'final'],
      [upcomingRows.filter((r) => soon(r, 30) && !r.briefing_received).length, 'reserva próxima sin briefing final', 'reservas próximas sin briefing final', undefined, 'briefing'],
    ];
    if (canWrite(client) && canRead(client, PORTAL_REQUESTS)) {
      const live = new Set(reservations.map((r) => r.id));
      const unseen = ((await client.list(PORTAL_REQUESTS)) as unknown as Array<{ reservation_id: string; status: string; deleted_at: string | null }>)
        .filter((p) => p.deleted_at === null && p.status === 'enviada' && live.has(p.reservation_id));
      const targets = new Set(unseen.map((p) => p.reservation_id));
      notices.unshift([unseen.length, 'petición del portal sin ver', 'peticiones del portal sin ver', targets.size === 1 ? `#/reservas/${[...targets][0]}` : '#/reservas', 'portal']);
    }
    if (seesMoney) notices.push([groups.senales.length, 'señal pendiente', 'señales pendientes', undefined, 'deposit']);
    // Huéspedes sin comunicar a SES (24 h desde la entrada): reservas que empiezan mañana como mucho o ya en curso.
    const boot = client.bootstrap();
    if (boot && canSeeGuests(boot.membership) && canRead(client, GUESTS)) {
      const urgent = new Set(reservations.filter((r) => guestModeOf(r) === 'ses' && ['confirmada', 'en_ejecucion'].includes(r.status)
        && (dayNumber(r.start_date) ?? Infinity) <= now + 1 && (dayNumber(r.end_date) ?? -Infinity) >= now).map((r) => r.id));
      const urgentEvents = new Set(events.filter((e) => urgent.has(e.reservation_id)).map((e) => e.id));
      const unsent = ((await client.list(GUESTS)) as unknown as Array<{ event_id: string; ses_status: string; preview?: boolean; deleted_at: string | null }>)
        .filter((g) => !g.preview && g.deleted_at === null && urgentEvents.has(g.event_id) && g.ses_status !== 'enviado_SES' && g.ses_status !== 'no_aplica').length;
      notices.unshift([unsent, 'huésped sin comunicar a SES', 'huéspedes sin comunicar a SES', unsent ? '#/huespedes' : undefined, 'ses_guests']);
    }
    // Reservas con SES sin comunicar pasadas 12 h desde el pago (plazo legal de 24 h): B2 con red; si falla, se calla.
    if (canWrite(client) && seesMoney) {
      const finance = new Map(views.flatMap((v) => (v.finance ? [[v.reservation.id, v.finance] as const] : [])));
      const ses = sesCandidates(client, reservations, finance);
      notices.unshift([ses.length, 'reserva sin comunicar a SES', 'reservas sin comunicar a SES', ses.length === 1 ? `#/reservas/${ses[0]}` : '#/ses', 'ses']);
    }
    if (canRead(client, NEEDS)) {
      const reservationOf = new Map(reservations.filter((r) => !['cancelada', 'perdida'].includes(r.status)).map((r) => [r.id, r]));
      const eventDates = new Map(events.filter((e) => reservationOf.has(e.reservation_id)).map((e) => [e.id, reservationOf.get(e.reservation_id)!]));
      const uncovered = uncoveredNeedsSoon(((await client.list(NEEDS)) as unknown as Array<{ id: string; event_id: string; persons: number; priority: string; status: string }>).filter((n) => eventDates.has(n.event_id)), eventDates, today());
      const targets = new Set(uncovered.map((n) => eventDates.get(n.event_id)!.id));
      notices.push([uncovered.length, 'refuerzo sin cubrir en los próximos 7 días', 'refuerzos sin cubrir en los próximos 7 días', targets.size === 1 ? `#/reservas/${[...targets][0]}` : '#/reservas', 'needs']);
    }
    const stays = await liveStays(client);
    if (stays.length) {
      const data = { assignments: (await client.list(ASSIGNMENTS)) as unknown as ClashAssignment[], events: events as unknown as Array<{ id: string; reservation_id: string; deleted_at: string | null }>, reservations: reservations as unknown as ClashReservation[], stays };
      const todayIso = today();
      const clashing = stays.filter((s) => s.to_date > todayIso && stayClashes(s, data).some((c) => c.kind === 'retiro')).length;
      notices.push([clashing, 'estancia que choca con un retiro', 'estancias que chocan con un retiro', '#/estancias', 'stays']);
    }
    if (canWrite(client) && joins) {
      const targets = new Set(joins.map((j) => j.reservationId));
      notices.unshift([joins.length, 'solicitud para apuntarse', 'solicitudes para apuntarse', targets.size === 1 ? `#/reservas/${[...targets][0]}` : '#/reservas', 'joins']);
    }
    if (disposed) return;
    const visible = notices.filter(([n]) => n > 0);
    const item = ([n, one, many, href, kind]: (typeof notices)[number]) => el('li', { dataset: href ? { notice: kind ?? 'needs' } : {}, class: ALWAYS_VISIBLE.has(kind ?? '') ? 'bk-notice-urgent' : null, 'data-feedback-id': 'booking.inicio.avisos.aviso', 'data-feedback-label': 'Aviso' }, el('span', { class: 'n' }, n),
      href ? el('a', { href, class: 'noticelink', 'data-feedback-id': 'booking.inicio.avisos.enlace', 'data-feedback-label': 'Ir al aviso' }, n === 1 ? one : many) : (n === 1 ? one : many));
    const urgentNotices = visible.filter(([, , , , kind]) => ALWAYS_VISIBLE.has(kind ?? ''));
    const otherNotices = visible.filter(([, , , , kind]) => !ALWAYS_VISIBLE.has(kind ?? ''));
    const othersOpen = (noticesHost.querySelector('#otherNotices') as HTMLDetailsElement | null)?.open ?? false;
    replace(noticesHost, visible.length === 0 ? null : el('section', { id: 'notices', 'aria-label': 'Avisos' },
      urgentNotices.length ? el('ul', { class: 'notices bk-notices-urgent' }, urgentNotices.map(item)) : null,
      otherNotices.length ? el('details', { id: 'otherNotices', class: 'bk-fold', open: othersOpen, 'data-feedback-id': 'booking.inicio.avisos.otros', 'data-feedback-label': 'Otros avisos' },
        el('summary', null, `Otros avisos · ${otherNotices.reduce((sum, [n]) => sum + n, 0)}`), el('ul', { class: 'notices' }, otherNotices.map(item))) : null));

    // --- Lo primero y la cola
    const shown = [...groups[filter]].sort((a, b) => (filter === 'necesitan' ? b.x.score - a.x.score : 0)
      || (dayNumber(a.reservation.start_date) ?? Infinity) - (dayNumber(b.reservation.start_date) ?? Infinity) || a.reservation.title.localeCompare(b.reservation.title, 'es'));
    const top = Math.max(1, ...shown.map((v) => v.x.score));
    const items: LeadItem[] = shown.map((v) => ({
      id: v.reservation.id,
      title: v.reservation.title,
      where: [v.reservation.start_date ? shortDay(v.reservation.start_date) : null, PHASE_LABELS[v.x.phase], v.x.people, v.reservation._pending ? 'Pendiente de sincronizar' : null].filter(Boolean).join(' · '),
      due: v.x.rush ?? nextText(v.x, set.seesAll),
      tone: v.x.next?.tone ?? (v.x.rush ? 'warn' : null),
      image: logos.get(v.reservation.id) ?? null,
      color: PHASE_COLORS[v.x.phase],
      medal: { name: v.reservation.title, image: logos.get(v.reservation.id) ?? null, color: PHASE_COLORS[v.x.phase] },
      weight: v.x.score / top,
    }));
    const lead = renderLead({
      title: FILTER_TITLES[filter], items, top: 3, max: 5, feedbackId: 'booking.inicio.primero',
      emptyText: filter === 'necesitan' ? 'Nada pendiente: ninguna reserva pide algo ahora.' : 'Ninguna reserva en este grupo.',
      onOpen: (it) => navigate(`#/reservas/${it.id}`),
      // La acción de la fase: «Siguiente» abre la ficha en el bloque de ese paso (el lector no ve acciones).
      extra: (it) => {
        const view = set.byId.get(it.id);
        const step = view?.x.next;
        return set.writable && step ? [el('button', { type: 'button', class: 'primary lead-btn', 'data-feedback-id': 'booking.inicio.primero.siguiente', 'data-feedback-label': 'Hacer lo siguiente',
          'aria-label': `${step.text}: ${it.title}`, onclick: () => { requestBlock(it.id, step.block); navigate(`#/reservas/${it.id}`); } }, step.text)] : [];
      },
    });
    lead.id = 'upcomingList';
    replace(leadHost, lead, filter !== 'necesitan'
      ? el('p', { class: 'hint' }, el('button', { type: 'button', class: 'linkbtn', id: 'homeFilterClear', 'data-feedback-id': 'booking.inicio.cifras.quitar', 'data-feedback-label': 'Ver lo primero', onclick: () => { filter = 'necesitan'; void paintData(); } }, 'Ver lo primero'))
      : null);
  }

  const name = client.bootstrap()?.profile.displayName;
  const card = (feedbackId: string, title: string, textBody: string, button: HTMLElement) =>
    el('article', { class: 'card', 'data-feedback-id': feedbackId, 'data-feedback-label': title }, el('h3', null, title), el('p', null, textBody), el('p', { style: 'margin-top:10px' }, button));
  const go = (id: string, feedbackId: string, label: string, hash: string) => el('button', { class: 'ghost', type: 'button', id, 'data-feedback-id': feedbackId, 'data-feedback-label': `Abrir ${label}`, onclick: () => navigate(hash) }, label);
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, name ? `Hola, ${name}` : 'Inicio'), el('p', null, 'Lo que pide atención hoy, lo primero.'))),
    statsHost,
    noticesHost,
    leadHost,
    el('details', { class: 'bk-fold', id: 'homeUtilities', 'data-feedback-id': 'booking.inicio.utilidades', 'data-feedback-label': 'Utilidades y cuenta' },
      el('summary', null, 'Utilidades y cuenta'),
      el('div', { class: 'cardgrid', style: 'margin-top:12px' },
        el('article', { class: 'card', 'data-feedback-id': 'booking.inicio.sincronizacion', 'data-feedback-label': 'Sincronización' },
          el('h3', null, 'Sincronización'),
          el('p', null, 'Estado del espejo local en este dispositivo.'),
          el('dl', { class: 'kv' }, el('dt', null, 'Red'), network, el('dt', null, 'Pendientes'), pending, el('dt', null, 'Último pull'), lastPull, el('dt', null, 'Rol'), role)),
        card('booking.inicio.espacios', 'Espacios y camas', 'Habitaciones con sus camas, salas y zonas exteriores, para asignar el alojamiento de cada reserva.', go('openSpacesHome', 'booking.inicio.espacios.abrir', 'Espacios y camas', '#/espacios')),
        canRead(client, STAYS) ? card('booking.inicio.estancias', 'Estancias', 'Quién duerme en casa fuera de los retiros: outsiders, con su cama por defecto, y staff.', go('openStaysHome', 'booking.inicio.estancias.abrir', 'Estancias', '#/estancias')) : null,
        canWrite(client) && canRead(client, RATES) ? card('booking.inicio.tarifas', 'Tarifas y condiciones', 'Tarifario, condiciones comerciales y tramos de cancelación para preparar las propuestas.', go('openRatesHome', 'booking.inicio.tarifas.abrir', 'Tarifas y condiciones', '#/tarifas')) : null,
        canRead(client, SES_SETTINGS) ? card('booking.inicio.ses', 'SES.HOSPEDAJES', 'Qué falta por comunicar, los rechazos y los partes de viajeros; el entorno y la pausa.', go('openSesHome', 'booking.inicio.ses.abrir', 'SES.HOSPEDAJES', '#/ses')) : null,
        // FB_2026_001: abierta como app instalada (Android, escritorio o iOS), el cuadro de instalar sobra
        isInstalled() ? null : el('article', { class: 'card', 'data-feedback-id': 'booking.inicio.instalar', 'data-feedback-label': 'Instalar en este dispositivo' },
          el('h3', null, 'Instalar en este dispositivo'),
          el('p', null, 'Como app instalada se abre a pantalla completa y funciona sin conexión.'),
          deferredInstall
            ? el('p', null, el('button', { class: 'ghost', type: 'button', style: 'margin-top:10px', 'data-feedback-id': 'booking.inicio.instalar.boton', 'data-feedback-label': 'Instalar Ikisai Booking', onclick: async () => { await deferredInstall?.prompt(); deferredInstall = null; } }, 'Instalar Ikisai Booking'))
            : el('p', { style: 'margin-top:8px' }, 'En Android: menú del navegador → «Instalar aplicación». En iPhone: Compartir → «Añadir a pantalla de inicio».')),
        card('booking.inicio.cuenta', 'Cuenta', name ? `Sesión iniciada como ${name}.` : 'Sesión iniciada.',
          el('button', { class: 'ghost', type: 'button', id: 'logoutHome', 'data-feedback-id': 'booking.inicio.cuenta.cerrar_sesion', 'data-feedback-label': 'Cerrar sesión', onclick: () => void logout() }, 'Cerrar sesión')),
      )),
  );

  paintStatus(client.status());
  const loadJoins = () => { if (canWrite(client)) void pendingJoins(client).then((j) => { if (disposed) return; joins = j; void paintData(); }); };
  window.addEventListener('online', loadJoins);
  loadJoins();
  void paintData();
  const repaint = () => void paintData();
  const offs = [
    client.onStatus(paintStatus),
    onSesPending(repaint),
    onLogos(repaint),
    ...[RESERVATIONS, EVENTS, FINANCE, GUESTS, NEEDS, STAYS, PORTAL_REQUESTS, PROPOSALS, ASSIGNMENTS].filter((t) => t === RESERVATIONS || canRead(client, t)).map((t) => client.onTable(t, repaint)),
  ];
  return () => { disposed = true; window.removeEventListener('online', loadJoins); offs.forEach((off) => off()); };
};

/** ¿Se está usando como app instalada? `display-mode` standalone/fullscreen/minimal-ui, o `navigator.standalone` en iOS. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const mode = (m: string) => typeof window.matchMedia === 'function' && window.matchMedia(`(display-mode: ${m})`).matches;
  return mode('standalone') || mode('fullscreen') || mode('minimal-ui') || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
