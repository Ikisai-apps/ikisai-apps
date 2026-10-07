import type { SyncStatus } from '@ikisai/sync-client';
import { el, formatDate, listRow, plural, replace } from '@ikisai/ui-kit';
import { canSeeGuests, dayNumber, depositStatus, guestModeOf, nights, uncoveredNeedsSoon } from '@ikisai/domain-booking';
import { EVENTS, FINANCE, GUESTS, NEEDS, RATES, RESERVATIONS, SES_SETTINGS, canRead, canWrite, dateRange, shortDay, statusLabel, today, type EventRow, type FinanceRow, type ReservationRow } from '../app/client.ts';
import { COMMUNICABLE_STATUSES, HOUR, acceptedReservationComm, fetchSes } from '../app/ses.ts';
import type { ViewMount } from './shell.ts';
import { fbMark } from './feedback.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event as InstallPromptEvent;
});

const UPCOMING = ['pre_reservada', 'confirmada', 'en_ejecucion'];
/** Reservas que Inicio vigila para el plazo de SES (las cerradas ya pasaron su momento). */
const SES_WATCHED = COMMUNICABLE_STATUSES.filter((status) => status !== 'cerrada');
const SES_MAX_CHECKS = 20;
const SES_NOTICE_AFTER_MS = 12 * HOUR;

/** Inicio: qué viene y qué requiere atención (canon §3). Todo se calcula con el espejo local. */
export const mountHome: ViewMount = ({ main, client, navigate, logout }) => {
  const upcomingHost = el('div', { 'data-feedback-id': 'booking.inicio.proximas', 'data-feedback-label': 'Próximas' });
  const noticesHost = el('div', { 'data-feedback-id': 'booking.inicio.avisos', 'data-feedback-label': 'Requiere atención' });
  const network = el('dd');
  const pending = el('dd');
  const lastPull = el('dd');
  // Reservas con SES, pago registrado hace más de 12 h y sin comunicación aceptada (se consulta solo con red y solo a las candidatas).
  let sesUnsent = new Set<string>();
  let sesCheckedKey = '';
  let sesCheckedAt = 0;
  let disposed = false;
  const role = el('dd');

  function paintStatus(status: SyncStatus): void {
    network.textContent = status.network === 'online' ? 'En línea' : status.network === 'offline' ? 'Sin conexión' : status.network === 'syncing' ? 'Sincronizando…' : 'Error';
    pending.textContent = String(status.pendingCommands + status.pendingBlobs);
    lastPull.textContent = formatDate(status.lastPullAt);
    const boot = client.bootstrap();
    role.textContent = boot ? { owner: 'Propietario', editor: 'Editor', reader: 'Solo lectura' }[boot.membership.role] : '—';
  }

  async function paintData(): Promise<void> {
    const now = dayNumber(today())!;
    const reservations = ((await client.list(RESERVATIONS)) as ReservationRow[]).filter((r) => !r.archived_at);
    const events = (await client.list(EVENTS)) as EventRow[];
    const eventByReservation = new Map(events.map((e) => [e.reservation_id, e]));
    const finance = canRead(client, FINANCE) ? new Map(((await client.list(FINANCE)) as FinanceRow[]).map((f) => [f.id, f])) : null;

    const upcoming = reservations
      .filter((r) => UPCOMING.includes(r.status) && (dayNumber(r.end_date) ?? Infinity) >= now)
      .sort((a, b) => (dayNumber(a.start_date) ?? Infinity) - (dayNumber(b.start_date) ?? Infinity));

    replace(upcomingHost, upcoming.length === 0
      ? el('div', { class: 'empty' }, el('strong', null, 'Nada a la vista'), 'No hay pre-reservas ni reservas confirmadas próximas.')
      : el('ul', { class: 'list', id: 'upcomingList', 'aria-label': 'Próximas reservas' }, upcoming.slice(0, 6).map((r) => {
          const n = nights(r.start_date, r.end_date);
          return fbMark(listRow({
            id: r.id,
            title: `${shortDay(r.start_date).toUpperCase()} · ${r.title}`,
            meta: [r.expected_guests !== null ? plural(r.expected_guests, 'persona', 'personas') : null, n !== null ? plural(n, 'noche', 'noches') : null, dateRange(r)],
            chips: [el('span', { class: 'chip', dataset: { status: r.status } }, statusLabel(r.status))],
            pending: r._pending === true,
            onClick: () => navigate('#/reservas'),
            label: `Ver ${r.title} en Reservas`,
          }), 'booking.inicio.proximas.fila', 'Reserva próxima');
        })));

    const soon = (r: ReservationRow, days: number) => { const start = dayNumber(r.start_date); return start !== null && start >= now && start - now <= days; };
    const notices: Array<[number, string, string, string?, string?]> = [
      [reservations.filter((r) => r.status === 'pre_reservada').length, 'pre-reserva pendiente de confirmar', 'pre-reservas pendientes de confirmar'],
      [upcoming.filter((r) => soon(r, 30) && r.status !== 'pre_reservada' && (eventByReservation.get(r.id)?.final_guests ?? null) === null).length, 'evento próximo sin número final de personas', 'eventos próximos sin número final de personas'],
      [upcoming.filter((r) => soon(r, 30) && !r.briefing_received).length, 'reserva próxima sin briefing final', 'reservas próximas sin briefing final'],
    ];
    if (finance) {
      notices.push([upcoming.filter((r) => ['pendiente', 'parcial'].includes(depositStatus(finance.get(r.id)))).length, 'señal pendiente', 'señales pendientes']);
    }
    // Huéspedes sin comunicar a SES (plazo de 24 h desde la entrada): reservas que empiezan mañana como mucho o ya en curso.
    const boot = client.bootstrap();
    if (boot && canSeeGuests(boot.membership)) {
      // Solo cuentan las reservas que se comunican a SES: sin SES no hay nada que comunicar.
      const urgent = new Set(reservations.filter((r) => guestModeOf(r) === 'ses' && ['confirmada', 'en_ejecucion'].includes(r.status)
        && (dayNumber(r.start_date) ?? Infinity) <= now + 1 && (dayNumber(r.end_date) ?? -Infinity) >= now).map((r) => r.id));
      const urgentEvents = new Set(events.filter((e) => urgent.has(e.reservation_id)).map((e) => e.id));
      const unsent = ((await client.list(GUESTS)) as unknown as Array<{ event_id: string; ses_status: string }>)
        .filter((g) => urgentEvents.has(g.event_id) && g.ses_status !== 'enviado_SES' && g.ses_status !== 'no_aplica').length;
      notices.push([unsent, 'huésped sin comunicar a SES', 'huéspedes sin comunicar a SES']);
    }
    // Reservas con SES sin comunicar pasadas 12 h desde el pago (el plazo legal es de 24 h): se pregunta a la API solo por las candidatas.
    if (canWrite(client) && finance) {
      const candidates = reservations.filter((r) => r.ses_enabled !== false && SES_WATCHED.includes(r.status))
        .map((r) => ({ id: r.id, at: Date.parse(String(finance.get(r.id)?.payment_registered_at ?? '')) }))
        .filter((c) => Number.isFinite(c.at) && Date.now() - c.at > SES_NOTICE_AFTER_MS)
        .sort((a, b) => a.at - b.at).slice(0, SES_MAX_CHECKS).map((c) => c.id);
      const key = candidates.join(',');
      if (navigator.onLine && candidates.length > 0 && (key !== sesCheckedKey || Date.now() - sesCheckedAt > 60_000)) {
        sesCheckedKey = key;
        sesCheckedAt = Date.now();
        void Promise.allSettled(candidates.map(async (id) => ({ id, accepted: acceptedReservationComm(await fetchSes(client, id)) !== null }))).then((results) => {
          if (disposed) return;
          // Si una consulta falla no se avisa de esa reserva: mejor callar que acusar sin saberlo.
          const next = new Set(results.flatMap((r) => (r.status === 'fulfilled' && !r.value.accepted ? [r.value.id] : [])));
          const changed = next.size !== sesUnsent.size || [...next].some((id) => !sesUnsent.has(id));
          sesUnsent = next;
          if (changed) void paintData();
        });
      }
      const pending = candidates.filter((id) => sesUnsent.has(id));
      notices.push([pending.length, 'reserva sin comunicar a SES', 'reservas sin comunicar a SES', pending.length === 1 ? `#/reservas/${pending[0]}` : '#/reservas', 'ses']);
    }
    // Refuerzos sin cubrir en los próximos 7 días (fechas de la reserva de cada evento; no cuentan reservas canceladas, perdidas ni archivadas).
    let needsHref = '#/reservas';
    if (canRead(client, NEEDS)) {
      const reservationOf = new Map(reservations.filter((r) => !['cancelada', 'perdida'].includes(r.status)).map((r) => [r.id, r]));
      const eventDates = new Map(events.filter((e) => reservationOf.has(e.reservation_id)).map((e) => [e.id, reservationOf.get(e.reservation_id)!]));
      const uncovered = uncoveredNeedsSoon(((await client.list(NEEDS)) as unknown as Array<{ id: string; event_id: string; persons: number; priority: string; status: string }>).filter((n) => eventDates.has(n.event_id)), eventDates, today());
      const targets = new Set(uncovered.map((n) => eventDates.get(n.event_id)!.id));
      if (targets.size === 1) needsHref = `#/reservas/${[...targets][0]}`;
      notices.push([uncovered.length, 'refuerzo sin cubrir en los próximos 7 días', 'refuerzos sin cubrir en los próximos 7 días', needsHref]);
    }
    const visible = notices.filter(([n]) => n > 0);
    replace(noticesHost, visible.length === 0
      ? null
      : [el('div', { class: 'sectionlabel' }, 'Requiere atención'),
         el('ul', { class: 'notices', id: 'notices' }, visible.map(([n, one, many, href, kind]) => el('li', { dataset: href ? { notice: kind ?? 'needs' } : {}, 'data-feedback-id': 'booking.inicio.avisos.aviso', 'data-feedback-label': 'Aviso' }, el('span', { class: 'n' }, n),
           href ? el('a', { href, class: 'noticelink', 'data-feedback-id': 'booking.inicio.avisos.enlace', 'data-feedback-label': 'Ir al aviso' }, n === 1 ? one : many) : (n === 1 ? one : many))))]);
  }

  const name = client.bootstrap()?.profile.displayName;
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, name ? `Hola, ${name}` : 'Inicio'), el('p', null, 'Qué viene y qué requiere atención.'))),
    el('div', { class: 'sectionlabel' }, 'Próximas'),
    upcomingHost,
    noticesHost,
    el('div', { class: 'cardgrid', style: 'margin-top:18px' },
      el('article', { class: 'card', 'data-feedback-id': 'booking.inicio.sincronizacion', 'data-feedback-label': 'Sincronización' },
        el('h3', null, 'Sincronización'),
        el('p', null, 'Estado del espejo local en este dispositivo.'),
        el('dl', { class: 'kv' }, el('dt', null, 'Red'), network, el('dt', null, 'Pendientes'), pending, el('dt', null, 'Último pull'), lastPull, el('dt', null, 'Rol'), role),
      ),
      el('article', { class: 'card', 'data-feedback-id': 'booking.inicio.espacios', 'data-feedback-label': 'Espacios y camas' },
        el('h3', null, 'Espacios y camas'),
        el('p', null, 'Habitaciones con sus camas, salas y zonas exteriores, para asignar el alojamiento de cada reserva.'),
        el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', id: 'openSpacesHome', 'data-feedback-id': 'booking.inicio.espacios.abrir', 'data-feedback-label': 'Abrir Espacios y camas', onclick: () => navigate('#/espacios') }, 'Espacios y camas')),
      ),
      canWrite(client) && canRead(client, RATES) ? el('article', { class: 'card', 'data-feedback-id': 'booking.inicio.tarifas', 'data-feedback-label': 'Tarifas y condiciones' },
        el('h3', null, 'Tarifas y condiciones'),
        el('p', null, 'Tarifario, condiciones comerciales y tramos de cancelación para preparar las propuestas.'),
        el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', id: 'openRatesHome', 'data-feedback-id': 'booking.inicio.tarifas.abrir', 'data-feedback-label': 'Abrir Tarifas y condiciones', onclick: () => navigate('#/tarifas') }, 'Tarifas y condiciones')),
      ) : null,
      canRead(client, SES_SETTINGS) ? el('article', { class: 'card', 'data-feedback-id': 'booking.inicio.ses', 'data-feedback-label': 'SES.HOSPEDAJES' },
        el('h3', null, 'SES.HOSPEDAJES'),
        el('p', null, 'Entorno de las comunicaciones (pruebas o real) y pausa de envíos.'),
        el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', id: 'openSesHome', 'data-feedback-id': 'booking.inicio.ses.abrir', 'data-feedback-label': 'Abrir SES.HOSPEDAJES', onclick: () => navigate('#/ses') }, 'SES.HOSPEDAJES')),
      ) : null,
      // FB_2026_001: abierta como app instalada (Android, escritorio o iOS), el cuadro de instalar sobra
      isInstalled() ? null : el('article', { class: 'card', 'data-feedback-id': 'booking.inicio.instalar', 'data-feedback-label': 'Instalar en este dispositivo' },
        el('h3', null, 'Instalar en este dispositivo'),
        el('p', null, 'Como app instalada se abre a pantalla completa y funciona sin conexión.'),
        deferredInstall
          ? el('p', null, el('button', { class: 'ghost', type: 'button', style: 'margin-top:10px', 'data-feedback-id': 'booking.inicio.instalar.boton', 'data-feedback-label': 'Instalar Ikisai Booking', onclick: async () => { await deferredInstall?.prompt(); deferredInstall = null; } }, 'Instalar Ikisai Booking'))
          : el('p', { style: 'margin-top:8px' }, 'En Android: menú del navegador → «Instalar aplicación». En iPhone: Compartir → «Añadir a pantalla de inicio».'),
      ),
      el('article', { class: 'card', 'data-feedback-id': 'booking.inicio.cuenta', 'data-feedback-label': 'Cuenta' },
        el('h3', null, 'Cuenta'),
        el('p', null, name ? `Sesión iniciada como ${name}.` : 'Sesión iniciada.'),
        el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', id: 'logoutHome', 'data-feedback-id': 'booking.inicio.cuenta.cerrar_sesion', 'data-feedback-label': 'Cerrar sesión', onclick: () => void logout() }, 'Cerrar sesión')),
      ),
    ),
  );

  paintStatus(client.status());
  void paintData();
  const offs = [
    client.onStatus(paintStatus),
    client.onTable(RESERVATIONS, () => void paintData()),
    client.onTable(EVENTS, () => void paintData()),
    client.onTable(GUESTS, () => void paintData()),
    ...(canRead(client, NEEDS) ? [client.onTable(NEEDS, () => void paintData())] : []),
  ];
  return () => { disposed = true; offs.forEach((off) => off()); };
};

/** ¿Se está usando como app instalada? `display-mode` standalone/fullscreen/minimal-ui, o `navigator.standalone` en iOS. */
export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const mode = (m: string) => typeof window.matchMedia === 'function' && window.matchMedia(`(display-mode: ${m})`).matches;
  return mode('standalone') || mode('fullscreen') || mode('minimal-ui') || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
