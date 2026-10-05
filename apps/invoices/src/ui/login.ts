import { el, icon, replace } from './dom.ts';
import { describeError } from '../app/client.ts';

export interface LoginOptions {
  /** Inicia sesión; debe lanzar si falla. */
  onLogin(email: string, password: string): Promise<void>;
}

export function renderLogin(root: HTMLElement, options: LoginOptions): void {
  const error = el('p', { class: 'formerror', id: 'loginError', role: 'alert', 'aria-live': 'assertive' });
  const email = el('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'username', required: true, inputmode: 'email', spellcheck: 'false', 'aria-describedby': 'loginError' });
  const password = el('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, minlength: '1' });
  const submit = el('button', { class: 'primary', type: 'submit' }, 'Entrar');

  const form = el(
    'form',
    {
      class: 'login-form',
      novalidate: true,
      onsubmit: async (event: Event) => {
        event.preventDefault();
        error.textContent = '';
        if (!email.value.trim() || !password.value) {
          error.textContent = 'Escribe tu correo y tu contraseña.';
          (email.value.trim() ? password : email).focus();
          return;
        }
        submit.disabled = true;
        submit.textContent = 'Entrando…';
        try {
          await options.onLogin(email.value.trim().toLowerCase(), password.value);
        } catch (e) {
          const code = (e as { code?: string }).code;
          error.textContent = code === 'NETWORK'
            ? 'No hay conexión. Para iniciar sesión por primera vez hace falta red; si ya entraste antes en este dispositivo, tu copia local sigue disponible al reconectar.'
            : describeError(e);
          password.focus();
          password.select();
        } finally {
          submit.disabled = false;
          submit.textContent = 'Entrar';
        }
      },
    },
    el('label', { class: 'field' }, el('span', null, 'Correo electrónico'), email),
    el('label', { class: 'field' }, el('span', null, 'Contraseña'), password),
    error,
    submit,
  );

  const offlineHelp = el(
    'details',
    null,
    el('summary', null, '¿Sin red?'),
    el('p', null,
      'Ikisai Invoices guarda en este dispositivo una copia de tus datos. Si ya iniciaste sesión antes, la app se abre directamente y puedes seguir consultando y editando sin conexión; los cambios quedan marcados como «pendientes» y se envían solos cuando vuelve la red. ',
      'Para iniciar sesión por primera vez sí necesitas conexión.'),
  );

  const card = el(
    'section',
    { class: 'login-card', 'aria-labelledby': 'loginTitle' },
    el('div', { class: 'login-brand' },
      el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('mark', 20)),
      el('h1', { id: 'loginTitle' }, 'Ikisai Invoices', el('small', null, 'Facturas, compras y gestoría')),
    ),
    form,
    !navigator.onLine ? el('p', { class: 'offline-ready' }, 'Ahora mismo no hay conexión.') : null,
    offlineHelp,
  );

  replace(root, el('main', { class: 'login' }, card));
  document.title = 'Entrar · Ikisai Invoices';
  email.focus();
}
