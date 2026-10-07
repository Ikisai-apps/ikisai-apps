/** SES.HOSPEDAJES (API §17.1): bloque «Registro de viajeros» de la ficha y ajuste global (entorno y pausa). */
import type { RowOperation, SyncClient, SyncedRow } from '@ikisai/sync-client';
import { confirmDialog, el, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { SES_DISABLED_REASONS, guestModeOf } from '@ikisai/domain-booking';
import { RESERVATIONS, SES_SETTINGS, canRead, canWrite, describeError, type ReservationRow } from '../app/client.ts';
import { GUEST_MODE_HELP, SES_ENVIRONMENT_LABELS, SES_REASON_LABELS, sesReasonText } from '../app/labels.ts';
import type { ViewMount } from './shell.ts';

type Row = SyncedRow & Record<string, any>;

export interface SesBlockInput {
  client: SyncClient;
  reservation: ReservationRow & Row;
  /** Fila de importes (solo la ven quienes tienen permiso); sirve para avisar de que hay importe. */
  finance: Row | null;
  editable: boolean;
  run(operations: RowOperation[], message: string): Promise<boolean>;
}

const hasAmount = (finance: Row | null): boolean => !!finance && finance.deleted_at === null && (Number(finance.final_amount) > 0 || Number(finance.budget_amount) > 0);

/** Bloque «Registro de viajeros»: interruptor de SES, motivo, «Pedir datos a los huéspedes» y el modo resultante. */
export function renderSesBlock({ client, reservation, finance, editable, run }: SesBlockInput): HTMLElement {
  const mode = guestModeOf(reservation);
  const enabled = reservation.ses_enabled !== false;
  const update = (fields: Record<string, unknown>, message: string) =>
    run([{ op: 'update', table: RESERVATIONS, id: reservation.id, expectedRevision: reservation.revision, fields }], message);

  let sheet: Sheet | null = null;
  function openReason(): void {
    const radios = new Map<string, HTMLInputElement>(SES_DISABLED_REASONS.map((reason) => [reason, el('input', { type: 'radio', name: 'sesReason', value: reason, id: `sesReason-${reason}` })]));
    const note = el('input', { type: 'text', id: 'sesNote', maxlength: 300, 'aria-label': 'Motivo (texto)', placeholder: 'Escribe el motivo', autocomplete: 'off',
      oninput: () => { if (note.value) radios.get('otro')!.checked = true; error.hidden = true; } });
    const error = el('p', { class: 'formerror', role: 'alert', hidden: true });
    const chosen = () => [...radios.values()].find((r) => r.checked)?.value ?? null;
    for (const radio of radios.values()) radio.addEventListener('change', () => { error.hidden = true; if (radio.value === 'otro') note.focus(); });
    const save = el('button', { class: 'primary', type: 'button', id: 'saveSesReason', onclick: async () => {
      const reason = chosen();
      const text = note.value.trim();
      const fail = (message: string) => { error.hidden = false; error.textContent = message; };
      if (!reason) return fail('Elige el motivo.');
      if (reason === 'otro' && !text) return fail('Escribe el motivo: es obligatorio con «Otro».');
      // Aviso, no bloqueo: una reserva con importe suele ser una prestación de servicios.
      if (reason === 'uso_privado' && hasAmount(finance)
        && !(await confirmDialog({ title: 'Reserva con importe', text: 'Esta reserva tiene importe. ¿Seguro que es sin contraprestación?', confirmLabel: 'Sí, es sin contraprestación' }))) return;
      save.disabled = true;
      const ok = await update({ ses_enabled: false, ses_disabled_reason: reason, ses_disabled_note: reason === 'otro' ? text : null }, 'SES desactivado para esta reserva.');
      save.disabled = false;
      if (ok) await sheet?.close(true);
    } }, 'Guardar');
    sheet = openSheet({
      title: 'Sin comunicar a SES',
      body: el('div', { class: 'rowform' },
        el('p', { class: 'hint' }, 'Indica por qué esta reserva no se comunica al registro de viajeros.'),
        el('fieldset', { class: 'sesreasons' }, el('legend', null, 'Motivo'),
          ...(['uso_privado', 'prueba'] as const).map((reason) => el('label', { class: 'check' }, radios.get(reason)!, el('span', null, SES_REASON_LABELS[reason]!))),
          el('div', { class: 'other' }, el('label', { class: 'check' }, radios.get('otro')!, el('span', null, 'Otro:')), note)),
        error),
      foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close(true) }, 'Cancelar')),
      onClose: () => { sheet = null; paintSwitch(); },
    });
  }

  const toggle = el('input', { type: 'checkbox', id: 'sesToggle', checked: enabled, disabled: !editable, onchange: () => {
    if (!toggle.checked) return openReason();
    // Reactivar es un clic; el aviso dice qué cambia. El motivo anterior se conserva.
    void update({ ses_enabled: true }, 'SES reactivado. Se pedirán los datos legales que falten.').then((ok) => { if (!ok) paintSwitch(); });
  } });
  function paintSwitch(): void { toggle.checked = reservation.ses_enabled !== false; }

  const collect = el('input', { type: 'checkbox', id: 'sesCollect', checked: reservation.collect_guest_data !== false, disabled: !editable, onchange: () => {
    void update({ collect_guest_data: collect.checked }, collect.checked ? 'Se pedirán datos a los huéspedes.' : 'Sin lista de huéspedes para esta reserva.').then((ok) => { if (!ok) collect.checked = !collect.checked; });
  } });

  return el('article', { class: 'card sesblock', id: 'blockSes' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Registro de viajeros')),
    el('label', { class: 'check' }, toggle, el('span', null, 'Comunicar a SES.HOSPEDAJES')),
    enabled ? null : el('p', { id: 'sesReason' }, `Sin comunicar a SES: ${sesReasonText(reservation.ses_disabled_reason, reservation.ses_disabled_note)}.`),
    enabled ? null : el('label', { class: 'check' }, collect, el('span', null, 'Pedir datos a los huéspedes')),
    el('p', { class: 'hint', id: 'sesModeHelp', dataset: { mode } }, `${GUEST_MODE_HELP[mode]}.`),
    editable ? null : el('p', { class: 'hint' }, 'Solo el equipo con permiso de edición puede cambiar estos ajustes.'));
}

/** Pantalla `#/ses`: entorno (pruebas o real) y pausa de envíos. Solo el propietario edita. */
export const mountSes: ViewMount = ({ main, client }) => {
  const host = el('div');
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
    const environment = el('select', { id: 'sesEnvironment', 'aria-label': 'Entorno', disabled: !editable, onchange: async () => {
      const value = environment.value;
      if (value === 'prod' && !(await confirmDialog({ title: 'Pasar a entorno real', text: 'Desde ahora se enviarán comunicaciones reales a SES.HOSPEDAJES. Confirma solo si las credenciales y los datos son los definitivos.', confirmLabel: 'Pasar a real' }))) {
        environment.value = String(settings.environment);
        return;
      }
      await save({ environment: value }, value === 'prod' ? 'Entorno real activado.' : 'Entorno de pruebas activado.');
    } }, Object.entries(SES_ENVIRONMENT_LABELS).map(([value, text]) => el('option', { value }, text)));
    environment.value = String(settings.environment);
    const paused = el('input', { type: 'checkbox', id: 'sesPaused', checked: settings.paused === true, disabled: !editable, onchange: () => {
      void save({ paused: paused.checked }, paused.checked ? 'Envíos pausados.' : 'Envíos reanudados.').then((ok) => { if (!ok) paused.checked = !paused.checked; });
    } });
    replace(host, el('article', { class: 'card sessettings', id: 'sesSettings' },
      el('label', { class: 'field' }, el('span', null, 'Entorno'), environment),
      el('label', { class: 'check' }, paused, el('span', null, 'Pausar envíos')),
      el('p', { class: 'hint' }, settings.paused === true ? 'Los envíos están en pausa: no saldrá ninguna comunicación.' : 'Las comunicaciones se envían con normalidad.'),
      editable ? null : el('p', { class: 'hint' }, 'Solo un propietario puede cambiar estos ajustes.')));
  }

  void paint();
  const offs = [client.onTable(SES_SETTINGS, () => void paint())];
  return () => offs.forEach((off) => off());
};
