/** Entrada sin sesión (API.md §9.1): enlace no válido o caducado, o nadie ha abierto todavía su enlace en este dispositivo. */
import { createLanguageSelect, el, fieldAttrs, icon, replace, toast } from '@ikisai/ui-kit';
import { i18n, t } from '../app/i18n.ts';
import { describeError, errorCode } from '../app/client.ts';
import { contactLine } from '../app/common-texts.ts';

export interface EntryOptions {
  /** Error del canje del enlace, si se llegó por `/i/<token>`. */
  error?: unknown;
  /** Muestra los accesos de la cuenta permanente (Google y código por correo) cuando el núcleo los active. */
  permanentAccount?: boolean;
  /** Entrada con código por correo (0108), si `auth/config` la tiene encendida. */
  emailCode?: { send(email: string): Promise<void>; enter(email: string, code: string): Promise<void> };
}

/** Lo escrito en el formulario del código sobrevive a los repintados (idioma, contacto que llega). */
const typed = { email: '', sent: false };

export function renderEntry(root: HTMLElement, options: EntryOptions = {}): () => void {
  const code = options.error ? errorCode(options.error) : '';
  let title = t('Entra con tu enlace');
  let text = t('Para entrar, abre el enlace que te enviamos por correo o por WhatsApp.');
  // El acceso de quien organiza no caduca (decisión de VG del 26-10-2026, Booking B19): un enlace solo deja de valer si
  // se revoca o se borra su reserva. Con uno nuevo se vuelve a ver todo, también los retiros pasados.
  if (code === 'LINK_EXPIRED') {
    title = t('Este enlace ya no está activo');
    text = t('Pídenos uno nuevo y volverás a ver todos tus retiros, también los pasados.');
  } else if (code === 'LINK_INVALID') {
    title = t('Este enlace no funciona');
    text = t('No es válido o ya no está activo. Pídenos uno nuevo.');
  } else if (options.error) {
    title = t('No hemos podido abrir tu enlace');
    text = describeError(options.error);
  }

  replace(root, el('main', { class: 'login orgentry', id: 'entry', 'data-feedback-id': 'organizers.entrada', 'data-feedback-label': 'Entrada' },
    el('div', { class: 'login-card' },
      el('div', { class: 'login-brand' }, el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('organizer', 22)), el('h1', null, 'Ikisai Organizers')),
      el('h2', { id: 'entryTitle', 'data-feedback-id': code ? 'organizers.entrada.enlace.error' : 'organizers.entrada.enlace.sin_sesion', 'data-feedback-label': title }, title),
      el('p', { id: 'entryText' }, text),
      el('p', { id: 'entryContact' }, code || options.error ? contactLine() : null),
      options.emailCode ? codeForm(options.emailCode) : null,
      !options.emailCode && options.permanentAccount ? el('div', { class: 'btnrow', id: 'permanentAccess' },
        el('p', { class: 'muted small' }, t('¿Ya guardaste tu acceso? Pronto podrás entrar aquí con tu cuenta de Google o con un código por correo.'))) : null,
      createLanguageSelect(i18n, { attrs: { id: 'langSelect' } }),
      el('p', { class: 'muted small orgentry-foot' }, t('Ikisai Organizers es el espacio de quienes organizan un retiro en Ikisai.')),
    )));
  return () => replace(root);
}

/** «¿No tienes el enlace a mano?»: el correo del enlace; el código llega en unos minutos y vale una vez. */
function codeForm(api: NonNullable<EntryOptions['emailCode']>): HTMLElement {
  // Inventario de campos (P15): el correo es el de la cuenta de portal; el código no se guarda en ningún sitio.
  const email = el('input', { type: 'email', id: 'codeEmail', autocomplete: 'email', inputmode: 'email', required: true, value: typed.email,
    ...fieldAttrs({ id: 'organizers.entrada.codigo.correo', label: 'Tu correo', entity: 'auth.users', prop: 'email', type: 'email', required: true, sensitivity: 'personal' }) }) as HTMLInputElement;
  const code = el('input', { type: 'text', id: 'codeInput', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '12',
    ...fieldAttrs({ id: 'organizers.entrada.codigo.codigo', storage: 'none', label: 'Código del correo', type: 'text', required: true, sensitivity: 'sensitive' }) }) as HTMLInputElement;
  const sendButton = el('button', { type: 'button', class: typed.sent ? 'ghost' : 'primary', id: 'codeSend', 'data-feedback-id': 'organizers.entrada.codigo.enviar', 'data-feedback-label': 'Enviarme un código' },
    typed.sent ? t('Enviar otro código') : t('Enviarme un código'));
  const enterButton = el('button', { type: 'button', class: 'primary', id: 'codeEnter', 'data-feedback-id': 'organizers.entrada.codigo.entrar', 'data-feedback-label': 'Entrar con el código' }, t('Entrar'));
  const step2 = el('div', { id: 'codeStep', hidden: !typed.sent },
    el('p', { class: 'muted small', id: 'codeSent' }, t('Si este correo tiene acceso, te llegará un código en unos minutos. Mira también en el correo no deseado.')),
    el('label', { class: 'field' }, el('span', null, t('Código del correo')), code),
    el('div', { class: 'btnrow' }, enterButton));
  sendButton.addEventListener('click', async () => {
    typed.email = email.value.trim();
    if (!typed.email || !email.checkValidity()) { email.reportValidity(); return; }
    sendButton.disabled = true;
    try {
      await api.send(typed.email);
      typed.sent = true;
      step2.hidden = false;
      sendButton.textContent = t('Enviar otro código');
      sendButton.className = 'ghost';
      code.focus();
    } catch (error) {
      toast(describeError(error));
    } finally {
      sendButton.disabled = false;
    }
  });
  enterButton.addEventListener('click', async () => {
    if (!code.value.trim()) { code.focus(); return; }
    enterButton.disabled = true;
    try {
      await api.enter(typed.email, code.value);
      typed.email = ''; typed.sent = false;
    } catch (error) {
      toast(describeError(error));
      enterButton.disabled = false;
    }
  });
  return el('section', { id: 'emailCode', class: 'orgcode', 'data-feedback-id': 'organizers.entrada.codigo', 'data-feedback-label': 'Entrar con un código por correo' },
    el('h3', null, t('¿No tienes el enlace a mano?')),
    el('p', { class: 'muted small' }, t('Escribe el correo con el que te escribimos y te mandamos un código para entrar.')),
    el('label', { class: 'field' }, el('span', null, t('Tu correo')), email),
    el('div', { class: 'btnrow' }, sendButton),
    step2);
}
