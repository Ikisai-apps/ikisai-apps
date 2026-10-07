/** SES.HOSPEDAJES (API §17): bloque «Registro de viajeros» de la ficha (interruptores y comunicaciones) y ajuste global (entorno y pausa). */
import type { RowOperation, SyncClient, SyncedRow } from '@ikisai/sync-client';
import { confirmDialog, el, formatDate, openSheet, replace, toast, type Child, type Sheet } from '@ikisai/ui-kit';
import { SES_DISABLED_REASONS, guestModeOf } from '@ikisai/domain-booking';
import { RESERVATIONS, SES_SETTINGS, canRead, canWrite, describeError, fullDay, type ReservationRow } from '../app/client.ts';
import { GUEST_MODE_HELP, SES_ENVIRONMENT_LABELS, SES_REASON_LABELS, sesReasonText } from '../app/labels.ts';
import {
  COMMUNICABLE_STATUSES, DEADLINE_TEXT, acceptedReservationComm, changedSinceCommunicated, deadlineLevel, fetchSes, liveReservationComm, paymentDateIsOld,
  guestReports, PV_IN_PROCESS, pendingCancellation, reservationComms, type SesCommunication, type SesStatus,
} from '../app/ses.ts';
import type { ViewMount } from './shell.ts';

type Row = SyncedRow & Record<string, any>;

export interface SesBlockInput {
  client: SyncClient;
  reservation: ReservationRow & Row;
  /** Evento operativo vivo: sus personas finales mandan sobre las previstas al comparar con lo comunicado. */
  event: Row | null;
  /** Fila de importes (solo la ven quienes tienen permiso); sirve para avisar de que hay importe y de la fecha de pago. */
  finance: Row | null;
  editable: boolean;
  run(operations: RowOperation[], message: string): Promise<boolean>;
}

export interface SesBlock {
  render(input: SesBlockInput): HTMLElement;
  destroy(): void;
}

const hasAmount = (finance: Row | null): boolean => !!finance && finance.deleted_at === null && (Number(finance.final_amount) > 0 || Number(finance.budget_amount) > 0);
const POLL_MS = 30_000;

const STATUS_LABEL: Record<SesStatus, string> = {
  preparada: 'Preparada', enviando: 'Enviando', en_proceso: 'En proceso en SES', aceptada: 'Aceptada', rechazada: 'Rechazada', anulada: 'Anulada', error: 'Error',
};
const HELD_TEXT: Record<string, string> = { PAUSED: 'Envíos en pausa', NOT_CONFIGURED: 'Faltan las credenciales de SES' };

/**
 * Bloque «Registro de viajeros»: interruptor de SES, motivo, «Pedir datos a los huéspedes», el modo resultante y, con red,
 * las comunicaciones a SES de la reserva (comunicar, estado, plazo de 24 h y anular). El envío es siempre con botón.
 */
export function createSesBlock(): SesBlock {
  let input: SesBlockInput | null = null;
  let items: SesCommunication[] | null = null;
  let loadError: string | null = null;
  let actionError: string | null = null;
  let loading = false;
  let again = false;
  let busy = false;
  let sheet: Sheet | null = null;
  const host = el('article', { class: 'card sesblock', id: 'blockSes', 'data-feedback-id': 'booking.reserva.ses', 'data-feedback-label': 'Registro de viajeros' });
  const comms = el('div', { id: 'sesComms', 'data-feedback-id': 'booking.reserva.ses.comunicaciones', 'data-feedback-label': 'Comunicaciones a SES' });

  async function refresh(): Promise<void> {
    const o = input;
    if (!o || !o.editable || !navigator.onLine) return paintComms();
    if (loading) { again = true; return; }
    loading = true;
    try {
      items = await fetchSes(o.client, o.reservation.id);
      loadError = null;
    } catch (error) {
      loadError = describeError(error);
    } finally {
      loading = false;
      paintComms();
      if (again) { again = false; void refresh(); }
    }
  }

  async function act(path: string, message: (status: string) => string): Promise<boolean> {
    if (busy || !input) return false;
    busy = true;
    actionError = null;
    paintComms();
    let ok = false;
    try {
      const out = await input.client.api<{ id: string; status: string }>(path, { method: 'POST', json: {} });
      toast(message(out.status));
      ok = true;
    } catch (error) {
      actionError = describeError(error);
      toast(actionError);
    } finally {
      busy = false;
      await refresh();
    }
    return ok;
  }

  const communicate = () => act(`/ses/${encodeURIComponent(input!.reservation.id)}/rh`, (status) => `Reserva enviada a SES: ${STATUS_LABEL[status as SesStatus]?.toLowerCase() ?? status}.`);
  const cancelPath = (accepted: SesCommunication) => `/ses/${encodeURIComponent(input!.reservation.id)}/cancel/${encodeURIComponent(accepted.id)}`;

  async function cancel(accepted: SesCommunication): Promise<boolean> {
    if (!input) return false;
    const go = await confirmDialog({ title: 'Anular en SES', text: 'Se anula en SES la comunicación de esta reserva. Después podrás volver a comunicarla con los datos al día.', confirmLabel: 'Anular en SES', danger: true });
    return go ? act(cancelPath(accepted), () => 'Anulación enviada a SES.') : false;
  }

  /** Tras guardar el motivo con una comunicación aceptada: ofrece anularla en SES. */
  async function offerCancel(): Promise<void> {
    const accepted = items ? acceptedReservationComm(items) : null;
    if (!accepted || !input || !navigator.onLine) return;
    const go = await confirmDialog({ title: 'Anular la comunicación en SES', text: 'Esta reserva ya está comunicada a SES. ¿Quieres anular ahora esa comunicación?', confirmLabel: 'Anular la comunicación en SES', danger: true });
    if (go) await act(cancelPath(accepted), () => 'Anulación enviada a SES.');
  }

  function paintComms(): void {
    const o = input;
    if (!o || !o.editable) return replace(comms, null);
    const { reservation, finance, event } = o;
    const enabled = reservation.ses_enabled !== false;
    const online = navigator.onLine;
    const list = items ?? [];
    const registeredAt = typeof finance?.payment_registered_at === 'string' ? finance.payment_registered_at : null;
    const latest = reservationComms(list)[0] ?? null;
    const accepted = acceptedReservationComm(list);
    const live = liveReservationComm(list);
    const cancelling = accepted ? pendingCancellation(list, accepted.id) : null;
    const changed = !!accepted && changedSinceCommunicated(reservation, event?.final_guests as number | null | undefined, accepted);
    const canceller = (id: string, label: string): HTMLElement => el('button', { class: 'ghost small', type: 'button', id, 'data-feedback-id': 'booking.reserva.ses.anular', 'data-feedback-label': 'Anular en SES', disabled: !online || busy || !!cancelling, onclick: () => void cancel(accepted!) }, label);

    const out: Child[] = [];
    if (!online) out.push(el('p', { class: 'hint', id: 'sesOffline', role: 'status' }, 'Sin conexión: el estado de SES y los envíos necesitan red. Se actualizará al reconectar.'));
    if (loadError && online) out.push(el('p', { class: 'formerror', id: 'sesLoadError', role: 'alert' }, loadError));

    // Aviso de cambios: la comunicación aceptada ya no refleja la reserva.
    if (accepted && changed) {
      out.push(el('div', { class: 'banner alert', id: 'sesChanged', role: 'alert', 'data-feedback-id': 'booking.reserva.ses.aviso_cambios', 'data-feedback-label': 'Aviso de cambios' },
        el('span', null, 'La reserva cambió desde que se comunicó: anula y vuelve a comunicar'), canceller('sesCancelChanged', 'Anular en SES')));
    }

    // Plazo de 24 h: desde el momento legal de la comunicación o, sin comunicación, desde el registro del pago.
    if (enabled && !accepted && COMMUNICABLE_STATUSES.includes(reservation.status)) {
      const level = deadlineLevel(latest && latest.status !== 'anulada' ? latest.legal_start_at ?? registeredAt : registeredAt);
      if (level && level !== 'ok') out.push(el('div', { class: `banner ${level === 'warn' ? 'warn' : 'alert'}`, id: 'sesDeadline', 'data-feedback-id': 'booking.reserva.ses.plazo', 'data-feedback-label': 'Plazo de 24 horas', role: level === 'warn' ? 'status' : 'alert', dataset: { level } }, el('span', null, DEADLINE_TEXT[level])));
      if (paymentDateIsOld(finance?.payment_date, registeredAt)) {
        out.push(el('p', { class: 'hint', id: 'sesPaymentOld', role: 'status' }, `El pago es del ${fullDay(String(finance!.payment_date))}: el plazo legal puede haber vencido.`));
      }
    }

    if (latest) {
      const held = latest.status === 'preparada' ? HELD_TEXT[String(latest.error_code)] ?? null : null;
      const detail: Child[] = [];
      if (latest.status === 'aceptada') detail.push(`Comunicada a SES${latest.ses_code ? ` · código ${latest.ses_code}` : ''}${latest.accepted_at ? ` · ${formatDate(latest.accepted_at)}` : ''}`);
      if (latest.status === 'rechazada') detail.push(el('span', { class: 'sesreject' }, latest.error_text || 'SES rechazó la comunicación.'), ' Corrige los datos y vuelve a comunicar.');
      if (latest.status === 'error') detail.push(`Se reintentará automáticamente${latest.error_text ? `: ${latest.error_text}` : '.'}`);
      if (latest.status === 'anulada' && latest.cancelled_at) detail.push(`Anulada el ${formatDate(latest.cancelled_at)}`);
      out.push(el('div', { class: 'sesstatus', id: 'sesStatus', 'data-feedback-id': 'booking.reserva.ses.estado', 'data-feedback-label': 'Estado de la comunicación', dataset: { status: latest.status } },
        el('div', { class: 'chips' },
          el('span', { class: `chip${latest.status === 'rechazada' || latest.status === 'error' ? ' alert' : latest.status === 'aceptada' ? '' : ' pending'}`, id: 'sesStatusChip', 'data-feedback-id': 'booking.reserva.ses.estado.chip', 'data-feedback-label': 'Estado' }, STATUS_LABEL[latest.status] ?? latest.status),
          held ? el('span', { class: 'chip pending', id: 'sesHeld' }, held) : null,
          latest.environment === 'pre' ? el('span', { class: 'chip', id: 'sesEnv' }, SES_ENVIRONMENT_LABELS.pre) : null),
        detail.length ? el('p', { class: 'hint', id: 'sesStatusDetail', 'data-feedback-id': 'booking.reserva.ses.estado.detalle', 'data-feedback-label': 'Detalle', 'data-feedback-ignore': '' }, ...detail) : null));
    }
    // Partes de viajeros (llegada): resumen y enlace a la pantalla de huéspedes, donde se cierra la entrada.
    const reports = guestReports(list);
    if (reports.length) {
      const done = reports.filter((c) => c.status === 'aceptada').length;
      const going = reports.filter((c) => PV_IN_PROCESS.includes(c.status)).length;
      const refused = reports.filter((c) => c.status === 'rechazada').length;
      const parts = [done ? `${done} ${done === 1 ? 'parte aceptado' : 'partes aceptados'}` : null, going ? `${going} en proceso` : null, refused ? `${refused} ${refused === 1 ? 'rechazado' : 'rechazados'}` : null].filter(Boolean);
      out.push(el('p', { class: 'hint', id: 'sesReports', 'data-feedback-id': 'booking.reserva.ses.partes', 'data-feedback-label': 'Partes de viajeros' },
        `Partes de viajeros: ${parts.join(' · ')}. `, event ? el('a', { class: 'noticelink', href: `#/huespedes/${event.id}` }, 'Ver huéspedes') : null));
    }
    if (cancelling) out.push(el('p', { class: 'hint', id: 'sesCancelling' }, `Anulación en SES: ${STATUS_LABEL[cancelling.status].toLowerCase()}${cancelling.status === 'error' && cancelling.error_text ? ` (${cancelling.error_text})` : ''}.`));
    if (actionError) out.push(el('p', { class: 'formerror', id: 'sesActionError', role: 'alert' }, actionError));

    const buttons: Child[] = [];
    if (enabled && !live && COMMUNICABLE_STATUSES.includes(reservation.status)) {
      if (registeredAt) buttons.push(el('button', { class: 'primary small', type: 'button', id: 'sesCommunicate', 'data-feedback-id': 'booking.reserva.ses.comunicar', 'data-feedback-label': 'Comunicar reserva a SES', disabled: !online || busy, onclick: () => void communicate() }, 'Comunicar reserva a SES'));
      else out.push(el('p', { class: 'hint', id: 'sesNeedsPayment' }, 'Se podrá comunicar cuando se registre el pago.'));
    }
    if (accepted && !changed) buttons.push(canceller('sesCancel', 'Anular en SES'));
    if (buttons.length) out.push(el('div', { class: 'choices', style: 'margin-top:8px' }, ...buttons));
    replace(comms, ...out);
  }

  function render(next: SesBlockInput): HTMLElement {
    input = next;
    const { reservation, finance, editable, run } = next;
    const mode = guestModeOf(reservation);
    const enabled = reservation.ses_enabled !== false;
    const update = (fields: Record<string, unknown>, message: string) =>
      run([{ op: 'update', table: RESERVATIONS, id: reservation.id, expectedRevision: reservation.revision, fields }], message);

    function openReason(): void {
      const radios = new Map<string, HTMLInputElement>(SES_DISABLED_REASONS.map((reason) => [reason, el('input', { type: 'radio', name: 'sesReason', value: reason, id: `sesReason-${reason}` })]));
      const note = el('input', { type: 'text', id: 'sesNote', 'data-feedback-id': 'booking.reserva.ses.motivo.nota', 'data-feedback-label': 'Motivo escrito', maxlength: 300, 'aria-label': 'Motivo (texto)', placeholder: 'Escribe el motivo', autocomplete: 'off',
        oninput: () => { if (note.value) radios.get('otro')!.checked = true; error.hidden = true; } });
      const error = el('p', { class: 'formerror', role: 'alert', hidden: true });
      const chosen = () => [...radios.values()].find((r) => r.checked)?.value ?? null;
      for (const radio of radios.values()) radio.addEventListener('change', () => { error.hidden = true; if (radio.value === 'otro') note.focus(); });
      const save = el('button', { class: 'primary', type: 'button', id: 'saveSesReason', 'data-feedback-id': 'booking.reserva.ses.motivo.guardar', 'data-feedback-label': 'Guardar', onclick: async () => {
        const reason = chosen();
        const text = note.value.trim();
        const fail = (message: string) => { error.hidden = false; error.textContent = message; };
        // Con un parte de viajeros aceptado el servidor lo impediría (`SES_ALREADY_REGISTERED`): se avisa antes, con el mismo texto.
        if (guestReports(items ?? []).some((c) => c.status === 'aceptada')) return fail(describeError({ code: 'SES_ALREADY_REGISTERED' }));
        if (!reason) return fail('Elige el motivo.');
        if (reason === 'otro' && !text) return fail('Escribe el motivo: es obligatorio con «Otro».');
        // Aviso, no bloqueo: una reserva con importe suele ser una prestación de servicios.
        if (reason === 'uso_privado' && hasAmount(finance)
          && !(await confirmDialog({ title: 'Reserva con importe', text: 'Esta reserva tiene importe. ¿Seguro que es sin contraprestación?', confirmLabel: 'Sí, es sin contraprestación' }))) return;
        save.disabled = true;
        const ok = await update({ ses_enabled: false, ses_disabled_reason: reason, ses_disabled_note: reason === 'otro' ? text : null }, 'SES desactivado para esta reserva.');
        save.disabled = false;
        if (ok) { await sheet?.close(true); await offerCancel(); }
      } }, 'Guardar');
      sheet = openSheet({
        title: 'Sin comunicar a SES',
        body: el('div', { class: 'rowform', 'data-feedback-id': 'booking.reserva.ses.motivo', 'data-feedback-label': 'Sin comunicar a SES' },
          el('p', { class: 'hint' }, 'Indica por qué esta reserva no se comunica al registro de viajeros.'),
          el('fieldset', { class: 'sesreasons', 'data-feedback-id': 'booking.reserva.ses.motivo.opciones', 'data-feedback-label': 'Motivo' }, el('legend', null, 'Motivo'),
            ...(['uso_privado', 'prueba'] as const).map((reason) => el('label', { class: 'check' }, radios.get(reason)!, el('span', null, SES_REASON_LABELS[reason]!))),
            el('div', { class: 'other' }, el('label', { class: 'check' }, radios.get('otro')!, el('span', null, 'Otro:')), note)),
          error),
        foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.reserva.ses.motivo.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close(true) }, 'Cancelar')),
        onClose: () => { sheet = null; paintSwitch(); },
      });
    }

    const toggle = el('input', { type: 'checkbox', id: 'sesToggle', 'data-feedback-id': 'booking.reserva.ses.interruptor', 'data-feedback-label': 'Comunicar a SES.HOSPEDAJES', checked: enabled, disabled: !editable, onchange: () => {
      if (!toggle.checked) return openReason();
      // Reactivar es un clic; el aviso dice qué cambia. El motivo anterior se conserva.
      void update({ ses_enabled: true }, 'SES reactivado. Se pedirán los datos legales que falten.').then((ok) => { if (!ok) paintSwitch(); });
    } });
    function paintSwitch(): void { toggle.checked = reservation.ses_enabled !== false; }

    const collect = el('input', { type: 'checkbox', id: 'sesCollect', 'data-feedback-id': 'booking.reserva.ses.pedir_datos', 'data-feedback-label': 'Pedir datos a los huéspedes', checked: reservation.collect_guest_data !== false, disabled: !editable, onchange: () => {
      void update({ collect_guest_data: collect.checked }, collect.checked ? 'Se pedirán datos a los huéspedes.' : 'Sin lista de huéspedes para esta reserva.').then((ok) => { if (!ok) collect.checked = !collect.checked; });
    } });

    replace(host,
      el('div', { class: 'cardhead' }, el('h3', null, 'Registro de viajeros')),
      el('label', { class: 'check' }, toggle, el('span', null, 'Comunicar a SES.HOSPEDAJES')),
      enabled ? null : el('p', { id: 'sesReason', 'data-feedback-id': 'booking.reserva.ses.motivo.texto', 'data-feedback-label': 'Motivo registrado', 'data-feedback-ignore': '' }, `Sin comunicar a SES: ${sesReasonText(reservation.ses_disabled_reason, reservation.ses_disabled_note)}.`),
      enabled ? null : el('label', { class: 'check' }, collect, el('span', null, 'Pedir datos a los huéspedes')),
      el('p', { class: 'hint', id: 'sesModeHelp', 'data-feedback-id': 'booking.reserva.ses.modo', 'data-feedback-label': 'Modo de huéspedes', dataset: { mode } }, `${GUEST_MODE_HELP[mode]}.`),
      comms,
      editable ? null : el('p', { class: 'hint' }, 'Solo el equipo con permiso de edición puede cambiar estos ajustes.'));
    paintComms();
    void refresh();
    ensureTimer();
    return host;
  }

  // Mientras haya algo enviándose o en proceso se consulta cada 30 s; el resto del tiempo solo se repinta el plazo.
  let timer: ReturnType<typeof setInterval> | null = null;
  const onNet = () => { paintComms(); if (navigator.onLine) void refresh(); };
  function ensureTimer(): void {
    if (timer) return;
    timer = setInterval(() => {
      if (!input?.editable) return;
      if (navigator.onLine && items?.some((c) => c.status === 'en_proceso' || c.status === 'enviando')) void refresh();
      else if (items) paintComms();
    }, POLL_MS);
    window.addEventListener('online', onNet);
    window.addEventListener('offline', onNet);
  }

  return {
    render,
    destroy() {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener('online', onNet);
      window.removeEventListener('offline', onNet);
      void sheet?.close(true);
    },
  };
}

/** Pantalla `#/ses`: entorno (pruebas o real) y pausa de envíos. Solo el propietario edita. */
export const mountSes: ViewMount = ({ main, client }) => {
  const host = el('div', { 'data-feedback-id': 'booking.ses.ajustes', 'data-feedback-label': 'Ajustes de SES' });
  const owner = client.bootstrap()?.membership.role === 'owner';
  replace(main, el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'SES.HOSPEDAJES'), el('p', null, 'Ajustes de las comunicaciones al registro de viajeros.'))), host);

  async function paint(): Promise<void> {
    if (!canRead(client, SES_SETTINGS)) return replace(host, el('div', { class: 'empty plain' }, el('strong', null, 'Sin acceso'), 'Estos ajustes los ven el equipo editor y los propietarios.'));
    const settings = ((await client.list(SES_SETTINGS)) as Row[]).find((row) => row.deleted_at === null) ?? null;
    if (!settings) return replace(host, el('div', { class: 'empty' }, el('strong', null, 'Sin ajustes todavía'), 'Aún no se han sincronizado. Vuelve a probar con conexión.'));
    const editable = owner && canWrite(client);
    const save = async (fields: Record<string, unknown>, message: string): Promise<boolean> => {
      try {
        await client.commit([{ op: 'update', table: SES_SETTINGS, id: settings.id, expectedRevision: settings.revision, fields }]);
        toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`);
        return true;
      } catch (error) {
        toast(describeError(error));
        void paint();
        return false;
      }
    };
    const environment = el('select', { id: 'sesEnvironment', 'data-feedback-id': 'booking.ses.ajustes.entorno', 'data-feedback-label': 'Entorno', 'aria-label': 'Entorno', disabled: !editable, onchange: async () => {
      const value = environment.value;
      if (value === 'prod' && !(await confirmDialog({ title: 'Pasar a entorno real', text: 'Desde ahora se enviarán comunicaciones reales a SES.HOSPEDAJES. Confirma solo si las credenciales y los datos son los definitivos.', confirmLabel: 'Pasar a real' }))) {
        environment.value = String(settings.environment);
        return;
      }
      await save({ environment: value }, value === 'prod' ? 'Entorno real activado.' : 'Entorno de pruebas activado.');
    } }, Object.entries(SES_ENVIRONMENT_LABELS).map(([value, text]) => el('option', { value }, text)));
    environment.value = String(settings.environment);
    const paused = el('input', { type: 'checkbox', id: 'sesPaused', 'data-feedback-id': 'booking.ses.ajustes.pausa', 'data-feedback-label': 'Pausar envíos', checked: settings.paused === true, disabled: !editable, onchange: () => {
      void save({ paused: paused.checked }, paused.checked ? 'Envíos pausados.' : 'Envíos reanudados.').then((ok) => { if (!ok) paused.checked = !paused.checked; });
    } });
    replace(host, el('article', { class: 'card sessettings', id: 'sesSettings', 'data-feedback-id': 'booking.ses.ajustes.tarjeta', 'data-feedback-label': 'Entorno y pausa' },
      el('label', { class: 'field' }, el('span', null, 'Entorno'), environment),
      el('label', { class: 'check' }, paused, el('span', null, 'Pausar envíos')),
      el('p', { class: 'hint' }, settings.paused === true ? 'Los envíos están en pausa: no saldrá ninguna comunicación.' : 'Las comunicaciones se envían con normalidad.'),
      editable ? null : el('p', { class: 'hint' }, 'Solo un propietario puede cambiar estos ajustes.')));
  }

  void paint();
  const offs = [client.onTable(SES_SETTINGS, () => void paint())];
  return () => offs.forEach((off) => off());
};
