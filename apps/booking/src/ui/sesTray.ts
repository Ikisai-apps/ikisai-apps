/**
 * `#/ses` como bandeja (tanda 27, MUELA-038 y 067 §4): el veredicto, las franjas de pruebas y pausa, «Comunicar las n» y
 * una línea por reserva agrupada por estado (`renderTray` del kit), con las áreas que añadió la revisión (reintentando,
 * retenidas, cambió, anulación y partes). Lee B2 (`GET /ses`) con red; sin red lo dice. Sin nombres ni documentos de
 * huéspedes: solo recuentos. El lector no llega aquí (Sin acceso, nada de SES en el DOM).
 */
import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, deadlineText, el, renderChecks, renderMedal, renderTray, replace, toast, type TrayRow } from '@ikisai/ui-kit';
import { canSeeGuests } from '@ikisai/domain-booking';
import { SES_AREAS, SES_PROBLEM_AREAS, fetchSesOverview, sesOverview, type SesArea, type SesOverview, type SesRow } from '../app/ses.ts';
import { describeError, shortDay } from '../app/client.ts';
import { PHASE_COLORS } from '../app/experience.ts';
import { retreatLogos } from '../app/logos.ts';
import { phaseOf } from '@ikisai/domain-booking';

const AREA_LABELS: Record<SesArea, string> = {
  corregir: 'Corregir', cambio: 'Cambió tras comunicarse', listas: 'Listas para comunicar', retenidas: 'Retenidas (pausa o sin credenciales)',
  reintentando: 'Reintentando (error)', partes: 'Partes de viajeros', antes_de_llegar: 'Huéspedes antes de llegar', en_proceso: 'En proceso',
  anulacion: 'Anulación en curso', esperando_pago: 'Esperando el pago', comunicadas: 'Comunicadas', sin_ses: 'Sin SES',
};
const FOLDED: readonly SesArea[] = ['comunicadas', 'sin_ses'];
/** Cada comprobación en verde, con su frase. */
const CLEAR_TEXT: Partial<Record<SesArea, string>> = {
  corregir: 'Nada que corregir', cambio: 'Ninguna cambió tras comunicarse', listas: 'Ninguna esperando a comunicarse', retenidas: 'Ninguna retenida',
  reintentando: 'Ningún error reintentándose', partes: 'Partes de viajeros al día', antes_de_llegar: 'Huéspedes listos antes de llegar',
};

export interface SesTrayOptions {
  client: SyncClient;
  navigate(hash: string): void;
  /** Editor u owner: acciones de un toque. */
  writable: boolean;
  /** Solo el propietario: abre «Ajustes del servicio» (retenidas sin credenciales). */
  openSettings?: () => void;
}

/** Pinta la bandeja en `host`; devuelve `refresh`. */
export function createSesTray(host: HTMLElement, o: SesTrayOptions) {
  let disposed = false;
  let busy = false;
  const boot = o.client.bootstrap();
  const seesGuests = boot ? canSeeGuests(boot.membership) : false;
  // «Antes de llegar» y «Partes» llevan datos de huéspedes (recuentos y el texto de SES, que puede nombrarlos).
  const GUEST_AREAS: readonly SesArea[] = ['antes_de_llegar', 'partes'];
  const shown = (a: SesArea) => seesGuests || !GUEST_AREAS.includes(a);

  const open = (row: SesRow, block = 'blockSes') => o.navigate(`#/reservas/${row.item.reservation.id}${block === 'huespedes' && row.item.reservation.event_id ? '' : ''}`);
  const guestsOf = (row: SesRow) => (row.item.reservation.event_id ? `#/huespedes/${row.item.reservation.event_id}` : null);

  async function communicate(row: SesRow): Promise<boolean> {
    try {
      await o.client.api(`/ses/${encodeURIComponent(row.item.reservation.id)}/rh`, { method: 'POST', json: {} });
      return true;
    } catch (error) {
      toast(`${row.item.reservation.title ?? 'Reserva'}: ${describeError(error)}`);
      return false;
    }
  }

  /** «Comunicar las n»: una a una por la ruta de siempre, tras confirmar con el entorno, cada reserva y la pausa. */
  async function communicateAll(view: SesOverview): Promise<void> {
    const rows = view.byArea.listas;
    if (!rows.length || busy) return;
    const real = view.settings?.environment === 'prod';
    const names = rows.map((r) => `· ${r.item.reservation.title ?? 'Reserva'}${r.item.reservation.code ? ` (${r.item.reservation.code})` : ''}`).join('\n');
    const go = await confirmDialog({
      title: `Comunicar ${rows.length === 1 ? 'la reserva' : `las ${rows.length} reservas`} a SES`,
      text: `${real ? 'Entorno REAL: se comunican de verdad a SES.HOSPEDAJES.' : 'Entorno de pruebas: no llega a la policía.'}\n${names}${view.settings?.paused ? '\nLos envíos están en pausa: quedarán preparadas y saldrán solas al reanudarlos.' : ''}`,
      confirmLabel: real ? 'Comunicar de verdad' : 'Comunicar en pruebas',
    });
    if (!go) return;
    busy = true;
    let ok = 0;
    for (const row of rows) if (await communicate(row)) ok += 1;
    busy = false;
    toast(`${ok} de ${rows.length} ${rows.length === 1 ? 'comunicada' : 'comunicadas'}${view.settings?.paused ? ' (en pausa: saldrán al reanudar)' : ''}.`);
    void refresh();
  }

  function line(row: SesRow, view: SesOverview): TrayRow {
    const r = row.item.reservation;
    const comm = row.communication;
    const what: string[] = [];
    if (row.target) what.push(`SES dice: ${comm?.error_text ?? comm?.error_code ?? 'error'}`);
    if (row.area === 'retenidas') what.push(comm?.error_code === 'NOT_CONFIGURED' ? 'Faltan las credenciales de SES' : 'Envíos en pausa: el plazo sigue corriendo');
    if (row.area === 'reintentando') what.push(`Se reintentará automáticamente${comm?.attempts ? ` · ${comm.attempts} intentos` : ''}`);
    if (row.area === 'cambio') what.push(r.ses_enabled ? 'La reserva cambió desde que se comunicó: anula y vuelve a comunicar' : 'SES se desactivó después de comunicarla: anula la comunicación');
    if (row.area === 'esperando_pago') what.push('Se podrá comunicar cuando se registre el pago');
    if (row.area === 'sin_ses') what.push(r.ses_disabled_reason ? `Sin SES: ${r.ses_disabled_note || r.ses_disabled_reason}` : 'Sin SES');
    if ((row.area === 'antes_de_llegar' || row.area === 'partes') && row.item.guests) {
      const g = row.item.guests;
      what.push([g.incomplete ? `Corregir · ${g.incomplete}` : null, g.unsigned ? `${g.unsigned} sin firmar` : null, g.ready ? `${g.ready} listos para el envío` : null, g.pending_report ? `${g.pending_report} sin parte` : null].filter(Boolean).join(' · ') || 'Todo listo');
    }
    if (row.oldPayment) what.push('El pago es antiguo: el plazo cuenta desde que se registró');
    const actions: TrayRow['actions'] = [];
    if (o.writable) {
      if (row.action === 'comunicar') actions.push({ label: 'Comunicar', primary: true, attrs: { 'data-feedback-id': 'booking.ses.reserva.comunicar', 'data-feedback-label': 'Comunicar' }, onClick: () => void communicate(row).then((done) => { if (done) { toast('Reserva enviada a SES.'); void refresh(); } }) });
      if (row.action === 'anular' || row.action === 'corregir') actions.push({ label: row.target?.label ?? (row.action === 'anular' ? 'Anular en la ficha' : 'Revisar la reserva'), primary: true, attrs: { 'data-feedback-id': 'booking.ses.reserva.corregir', 'data-feedback-label': 'Corregir' }, onClick: () => open(row) });
      if (row.area === 'retenidas' && comm?.error_code === 'NOT_CONFIGURED' && o.openSettings) actions.push({ label: 'Ajustes del servicio', primary: true, attrs: { 'data-feedback-id': 'booking.ses.reserva.ajustes', 'data-feedback-label': 'Ajustes del servicio' }, onClick: () => o.openSettings!() });
      if (row.action === 'huespedes' && guestsOf(row)) actions.push({ label: 'Corregir en Huéspedes', primary: true, attrs: { 'data-feedback-id': 'booking.ses.reserva.huespedes', 'data-feedback-label': 'Corregir en Huéspedes' }, onClick: () => o.navigate(guestsOf(row)!) });
    }
    actions.push({ label: 'Abrir', attrs: { 'data-feedback-id': 'booking.ses.reserva.abrir', 'data-feedback-label': 'Abrir' }, onClick: () => open(row) });
    return {
      id: r.id,
      title: r.title ?? 'Reserva',
      medal: renderMedal({ name: r.title ?? '?', image: retreatLogos(o.client).get(r.id) ?? null, color: PHASE_COLORS[phaseOf(r.status as never)], size: 44 }),
      who: [r.start_date ? shortDay(r.start_date) : null, r.code].filter(Boolean).join(' · ') || null,
      when: row.deadline ? deadlineText(row.deadline.dueAt, { prefix: row.deadline.msLeft < 0 ? 'Venció el' : 'Vence el' }) : null,
      clash: what.filter(Boolean),
      chips: [comm && comm.environment !== 'prod' ? el('span', { class: 'chip' }, 'Pruebas') : null, view.settings?.paused && row.deadline ? el('span', { class: 'chip warn' }, 'En pausa') : null].filter(Boolean) as HTMLElement[],
      actions,
      rejected: row.area === 'corregir',
      attrs: { 'data-ses-area': row.area },
    };
  }

  function paint(view: SesOverview): void {
    // Lo de huéspedes, solo con permiso de huéspedes; el veredicto cuenta lo mismo que las comprobaciones.
    const areas = SES_AREAS.filter(shown);
    const checked = SES_PROBLEM_AREAS.filter(shown);
    const problems = view.rows.filter((r) => checked.includes(r.area));
    const first = problems.sort((a, b) => (a.deadline ? Date.parse(a.deadline.dueAt) : Infinity) - (b.deadline ? Date.parse(b.deadline.dueAt) : Infinity))[0] ?? null;
    const firstText = first ? `${first.item.reservation.title ?? 'Reserva'}${first.deadline ? ` · ${deadlineText(first.deadline.dueAt, { prefix: 'vence el' })}` : ` · ${AREA_LABELS[first.area].toLowerCase()}`}` : '';
    const verdict = renderChecks({
      label: 'Cómo vamos con SES',
      verdict: problems.length ? `${problems.length} ${problems.length === 1 ? 'cosa por resolver' : 'cosas por resolver'} · La primera: ${firstText}` : 'Todo en regla',
      items: [
        ...checked.map((a) => ({ ok: view.byArea[a].length === 0, text: view.byArea[a].length ? `${AREA_LABELS[a]}: ${view.byArea[a].length}` : CLEAR_TEXT[a] ?? AREA_LABELS[a] })),
        { ok: view.settings?.environment === 'prod' && !view.settings?.paused, text: !view.settings ? 'El servicio, sin ajustes' : `El servicio: ${view.settings.environment === 'prod' ? 'real' : 'pruebas'}${view.settings.paused ? ', en pausa' : ''}` },
      ],
    });
    verdict.id = 'sesVerdict';
    verdict.setAttribute('data-feedback-id', 'booking.ses.veredicto');
    verdict.setAttribute('data-feedback-label', 'Veredicto');
    const all = o.writable && view.byArea.listas.length > 0
      ? el('button', { type: 'button', class: 'primary', id: 'sesCommunicateAll', 'data-feedback-id': 'booking.ses.comunicar_todas', 'data-feedback-label': 'Comunicar las listas', onclick: () => void communicateAll(view) },
          view.byArea.listas.length === 1 ? 'Comunicar la reserva lista' : `Comunicar las ${view.byArea.listas.length}`) : null;
    const tray = renderTray({
      label: 'Reservas por estado de la comunicación',
      groups: areas.filter((a) => view.byArea[a].length > 0).map((a) => ({ key: a, label: `${SES_PROBLEM_AREAS.includes(a) ? '! ' : ''}${AREA_LABELS[a]}`, rows: view.byArea[a].map((row) => line(row, view)), collapsed: FOLDED.includes(a) })),
      emptyTitle: 'Nada que comunicar', emptyText: 'Ninguna reserva confirmada con pago reciente.',
    });
    tray.id = 'sesTray';
    replace(host, verdict, all ? el('p', { class: 'bk-ses-all' }, all) : null, tray);
  }

  async function refresh(): Promise<void> {
    if (!navigator.onLine) {
      replace(host, el('div', { class: 'banner warn', id: 'sesOffline', role: 'status' }, 'Sin conexión: el estado de SES y los envíos necesitan red. La pausa se puede cambiar abajo y se enviará al reconectar.'));
      return;
    }
    try {
      const data = await fetchSesOverview(o.client);
      if (!disposed) paint(sesOverview(data));
    } catch (error) {
      if (!disposed) replace(host, el('p', { class: 'hint', id: 'sesTrayError', role: 'status' }, `No se pudo leer el estado de SES: ${describeError(error)}`));
    }
  }

  void refresh();
  const timer = window.setInterval(() => { if (!busy) void refresh(); }, 30_000);
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
  return { refresh, destroy: () => { disposed = true; window.clearInterval(timer); window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); } };
}
