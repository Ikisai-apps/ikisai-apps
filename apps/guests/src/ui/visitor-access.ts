/**
 * «Guarda tu acceso» del visitante (ENTRADA_PUBLICA.md, tarjeta 3; núcleo C11 v2, 0106): con un correo, optativo, y un
 * código de un solo uso que llega a ese correo, el acceso de este móvil queda guardado y se recupera en otro móvil con el
 * mismo correo. Si el correo ya guardaba otro acceso, este móvil pasa a ese (es la misma persona; lo de este móvil sin
 * guardar no se fusiona). El núcleo nunca dice si un correo existe y no guarda el correo en claro: aquí solo se enseña su
 * pista («v•••@g•••.com»). «Quitar el correo» lo desliga. Sin identidad todavía, se crea al pedir el código (es un gesto).
 * (El «Guarda tu acceso» del huésped con enlace es otra pieza: `access.ts`.)
 */
import { announceSaved, el, fieldAttrs, replace, toast } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import { ensureVisitor, errorCodeOf, forgetEmail, sendEmailCode, verifyEmailCode, visitorMe, visitorToken } from '../app/visitor.ts';
import { whyNote } from './common.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function accessError(error: unknown): string {
  switch (errorCodeOf(error)) {
    case 'NETWORK': return t('error.offline');
    case 'CODE_INVALID': return t('vaccess.codeInvalid');
    case 'RATE_LIMITED': return t('vaccess.rateLimited');
    default: return t('error.generic');
  }
}

/** El bloque, plegado; `changed` repinta la pantalla (p. ej. al recuperar otro acceso). */
export function accessBox(eventCode: string | null, changed: () => void): HTMLElement {
  const body = el('div', { class: 'gaccess-body' });
  const box = el('details', { class: 'card gcard gaccess', id: 'visitorAccess', 'data-feedback-id': 'guests.visitante.acceso', 'data-feedback-label': 'Guarda tu acceso' },
    el('summary', null, t('vaccess.title')), body) as HTMLDetailsElement;
  let painted = false;
  box.addEventListener('toggle', () => { if (box.open && !painted) { painted = true; void paint(); } });

  const paint = async () => {
    replace(body, el('p', { class: 'small' }, t('common.loading')));
    let hint: string | null = null;
    if (visitorToken()) {
      try { const me = await visitorMe(); hint = me.emailSaved ? me.emailHint ?? '' : null; } catch { /* sin poder leerlo, se ofrece guardar */ }
    }
    if (hint !== null) {
      replace(body,
        el('p', { id: 'accessSaved' }, t('vaccess.saved', { hint })),
        el('p', { class: 'small' }, t('vaccess.savedText')),
        el('button', { type: 'button', class: 'ghost', id: 'accessForget', 'data-feedback-id': 'guests.visitante.acceso.quitar', 'data-feedback-label': 'Quitar el correo',
          onclick: async () => {
            try { await forgetEmail(); toast(t('vaccess.forgotten')); void paint(); } catch (error) { toast(accessError(error)); }
          } }, t('vaccess.forget')));
      return;
    }
    askEmail();
  };

  /** Paso 1: el correo. Paso 2: el código que llega. */
  const askEmail = () => {
    const email = el('input', { id: 'accessEmail', class: 'input', type: 'email', inputmode: 'email', autocomplete: 'email', maxlength: '200',
      ...fieldAttrs({ id: 'guests.visitante.acceso.correo', type: 'email', required: false, sensitivity: 'personal', confirm: 'event', storage: 'none' }) }) as HTMLInputElement;
    const why = el('div', { 'aria-live': 'polite' });
    const send = el('button', { type: 'submit', class: 'primary', id: 'accessSend', 'data-feedback-id': 'guests.visitante.acceso.enviar', 'data-feedback-label': 'Enviarme un código' }, t('vaccess.send')) as HTMLButtonElement;
    replace(body,
      el('p', { class: 'small' }, t('vaccess.text')),
      el('form', { novalidate: '', onsubmit: async (e: Event) => {
        e.preventDefault();
        const value = email.value.trim();
        if (!EMAIL.test(value)) { email.focus(); replace(why, whyNote('accessWhy', t('vaccess.emailBad'))); return; }
        send.disabled = true;
        try {
          await ensureVisitor(eventCode);
          await sendEmailCode(value);
          askCode(value);
        } catch (error) {
          send.disabled = false;
          replace(why, whyNote('accessWhy', accessError(error)));
        }
      } },
      el('label', { class: 'field', for: 'accessEmail' }, el('span', null, t('vaccess.email')), email, el('span', { class: 'small' }, t('vaccess.emailWhy'))),
      why, send));
  };

  const askCode = (email: string) => {
    const code = el('input', { id: 'accessCode', class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '10',
      ...fieldAttrs({ id: 'guests.visitante.acceso.codigo', type: 'text', required: true, sensitivity: 'internal', confirm: 'event', storage: 'none' }) }) as HTMLInputElement;
    const why = el('div', { 'aria-live': 'polite' });
    const ok = el('button', { type: 'submit', class: 'primary', id: 'accessVerify', 'data-feedback-id': 'guests.visitante.acceso.verificar', 'data-feedback-label': 'Guardar el acceso' }, t('vaccess.verify')) as HTMLButtonElement;
    replace(body,
      el('p', { id: 'accessSent' }, t('vaccess.sent', { email })),
      el('form', { novalidate: '', onsubmit: async (e: Event) => {
        e.preventDefault();
        const value = code.value.replace(/\s+/g, '');
        if (!value) { code.focus(); return; }
        ok.disabled = true;
        try {
          const out = await verifyEmailCode(email, value);
          // Para el Guiado: el acceso queda guardado.
          announceSaved('guests.visitante.acceso.correo'); announceSaved('guests.visitante.acceso.codigo');
          toast(out.recovered ? t('vaccess.recovered') : t('vaccess.done'));
          if (out.recovered) changed(); else void paint();
        } catch (error) {
          ok.disabled = false;
          replace(why, whyNote('accessWhy', accessError(error)));
        }
      } },
      el('label', { class: 'field', for: 'accessCode' }, el('span', null, t('vaccess.code')), code),
      why, ok,
      el('button', { type: 'button', class: 'ghost small', id: 'accessAgain', onclick: () => askEmail() }, t('vaccess.again'))));
    code.focus();
  };
  return box;
}
