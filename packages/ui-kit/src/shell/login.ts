import { el, replace } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';

export interface LoginOptions {
  /** Nombre de la app, por ejemplo «Invoices»: se muestra como «Ikisai Invoices». */
  appName: string;
  /** Línea bajo el nombre: «Facturas, compras y gestoría». */
  tagline?: string;
  /** Inicia sesión; debe lanzar si falla. */
  onLogin(email: string, password: string): Promise<void>;
  /** Traduce errores del cliente a texto; `code === 'NETWORK'` ya tiene mensaje propio. */
  describeError?: (error: unknown) => string;
  /** Nota al pie (versión, aviso legal). */
  footnote?: string;
  /** Icono de la marca de la app; por defecto el genérico. */
  markIcon?: IconName;
  /** Ids de los controles, por si la app ya tiene pruebas que los usan; por defecto `email`, `password`, `loginSubmit`, `loginForm`, `loginError`. */
  ids?: { email?: string; password?: string; submit?: string; form?: string; error?: string };
  /** Título; por defecto «Ikisai <appName>». */
  title?: string;
}

/** Shell de login común: tarjeta centrada, formulario accesible, ayuda sin red y marca Ikisai. */
export function renderLogin(root: HTMLElement, options: LoginOptions): () => void {
  const title = options.title ?? `Ikisai ${options.appName}`;
  const ids = { email: 'email', password: 'password', submit: 'loginSubmit', form: 'loginForm', error: 'loginError', ...(options.ids ?? {}) };
  const error = el('p', { class: 'formerror', id: ids.error, role: 'alert', 'aria-live': 'assertive' });
  const email = el('input', { id: ids.email, name: 'email', type: 'email', autocomplete: 'username', required: true, inputmode: 'email', spellcheck: 'false', 'aria-describedby': ids.error });
  const password = el('input', { id: ids.password, name: 'password', type: 'password', autocomplete: 'current-password', required: true, minlength: '1' });
  const submit = el('button', { class: 'primary', type: 'submit', id: ids.submit }, 'Entrar');

  const form = el(
    'form',
    {
      class: 'login-form',
      id: ids.form,
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
            : options.describeError ? options.describeError(e) : 'No se pudo iniciar sesión.';
          password.focus();
          password.select();
        } finally {
          submit.disabled = false;
          submit.textContent = 'Entrar';
        }
      },
    },
    el('label', { class: 'field', for: ids.email }, el('span', null, 'Correo electrónico'), email),
    el('label', { class: 'field', for: ids.password }, el('span', null, 'Contraseña'), password),
    error,
    submit,
  );

  const offlineHelp = el(
    'details',
    null,
    el('summary', null, '¿Sin red?'),
    el('p', null,
      `${title} guarda en este dispositivo una copia de tus datos. Si ya iniciaste sesión antes, la app se abre directamente y puedes seguir consultando y editando sin conexión; los cambios quedan marcados como «pendientes» y se envían solos cuando vuelve la red. `,
      'Para iniciar sesión por primera vez sí necesitas conexión.'),
  );

  const offlineNote = el('p', { class: 'offline-ready', hidden: navigator.onLine }, 'Ahora mismo no hay conexión.');
  const onNetwork = () => { offlineNote.hidden = navigator.onLine; };
  window.addEventListener('online', onNetwork);
  window.addEventListener('offline', onNetwork);

  const card = el(
    'section',
    { class: 'login-card', 'aria-labelledby': 'loginTitle' },
    el('div', { class: 'login-brand' },
      el('div', { class: 'mark', 'aria-hidden': 'true' }, icon(options.markIcon ?? 'mark', 20)),
      el('h1', { id: 'loginTitle' }, title, options.tagline ? el('small', null, options.tagline) : null),
    ),
    form,
    offlineNote,
    offlineHelp,
    options.footnote ? el('p', { class: 'footnote' }, options.footnote) : null,
  );

  replace(root, el('main', { class: 'login' }, card));
  const previousTitle = document.title;
  document.title = `Entrar · ${title}`;
  email.focus();

  return () => {
    window.removeEventListener('online', onNetwork);
    window.removeEventListener('offline', onNetwork);
    if (document.title === `Entrar · ${title}`) document.title = previousTitle;
  };
}
