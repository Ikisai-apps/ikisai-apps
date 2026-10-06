import type { SyncStatus } from '@ikisai/sync-client';
import { el, formatDate, listRow, plural, replace } from '@ikisai/ui-kit';
import { canSeeGuests, dayNumber, depositStatus, nights } from '@ikisai/domain-booking';
import { EVENTS, FINANCE, GUESTS, RESERVATIONS, canRead, dateRange, shortDay, statusLabel, today, type EventRow, type FinanceRow, type ReservationRow } from '../app/client.ts';
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

const UPCOMING = ['pre_reservada', 'confirmada', 'en_ejecucion'];

/** Inicio: qué viene y qué requiere atención (canon §3). Todo se calcula con el espejo local. */
export const mountHome: ViewMount = ({ main, client, navigate, logout }) => {
  const upcomingHost = el('div');
  const noticesHost = el('div');
  const network = el('dd');
  const pending = el('dd');
  const lastPull = el('dd');
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
          return listRow({
            id: r.id,
            title: `${shortDay(r.start_date).toUpperCase()} · ${r.title}`,
            meta: [r.expected_guests !== null ? plural(r.expected_guests, 'persona', 'personas') : null, n !== null ? plural(n, 'noche', 'noches') : null, dateRange(r)],
            chips: [el('span', { class: 'chip', dataset: { status: r.status } }, statusLabel(r.status))],
            pending: r._pending === true,
            onClick: () => navigate('#/reservas'),
            label: `Ver ${r.title} en Reservas`,
          });
        })));

    const soon = (r: ReservationRow, days: number) => { const start = dayNumber(r.start_date); return start !== null && start >= now && start - now <= days; };
    const notices: Array<[number, string, string]> = [
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
      const urgent = new Set(reservations.filter((r) => ['confirmada', 'en_ejecucion'].includes(r.status)
        && (dayNumber(r.start_date) ?? Infinity) <= now + 1 && (dayNumber(r.end_date) ?? -Infinity) >= now).map((r) => r.id));
      const urgentEvents = new Set(events.filter((e) => urgent.has(e.reservation_id)).map((e) => e.id));
      const unsent = ((await client.list(GUESTS)) as unknown as Array<{ event_id: string; ses_status: string }>)
        .filter((g) => urgentEvents.has(g.event_id) && g.ses_status !== 'enviado_SES' && g.ses_status !== 'no_aplica').length;
      notices.push([unsent, 'huésped sin comunicar a SES', 'huéspedes sin comunicar a SES']);
    }
    const visible = notices.filter(([n]) => n > 0);
    replace(noticesHost, visible.length === 0
      ? null
      : [el('div', { class: 'sectionlabel' }, 'Requiere atención'),
         el('ul', { class: 'notices', id: 'notices' }, visible.map(([n, one, many]) => el('li', null, el('span', { class: 'n' }, n), n === 1 ? one : many)))]);
  }

  const name = client.bootstrap()?.profile.displayName;
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, name ? `Hola, ${name}` : 'Inicio'), el('p', null, 'Qué viene y qué requiere atención.'))),
    el('div', { class: 'sectionlabel' }, 'Próximas'),
    upcomingHost,
    noticesHost,
    el('div', { class: 'cardgrid', style: 'margin-top:18px' },
      el('article', { class: 'card' },
        el('h3', null, 'Sincronización'),
        el('p', null, 'Estado del espejo local en este dispositivo.'),
        el('dl', { class: 'kv' }, el('dt', null, 'Red'), network, el('dt', null, 'Pendientes'), pending, el('dt', null, 'Último pull'), lastPull, el('dt', null, 'Rol'), role),
      ),
      el('article', { class: 'card' },
        el('h3', null, 'Instalar en este dispositivo'),
        el('p', null, 'Como app instalada se abre a pantalla completa y funciona sin conexión.'),
        deferredInstall
          ? el('p', null, el('button', { class: 'ghost', type: 'button', style: 'margin-top:10px', onclick: async () => { await deferredInstall?.prompt(); deferredInstall = null; } }, 'Instalar Ikisai Booking'))
          : el('p', { style: 'margin-top:8px' }, 'En Android: menú del navegador → «Instalar aplicación». En iPhone: Compartir → «Añadir a pantalla de inicio».'),
      ),
      el('article', { class: 'card' },
        el('h3', null, 'Cuenta'),
        el('p', null, name ? `Sesión iniciada como ${name}.` : 'Sesión iniciada.'),
        el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', id: 'logoutHome', onclick: () => void logout() }, 'Cerrar sesión')),
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
  ];
  return () => offs.forEach((off) => off());
};
