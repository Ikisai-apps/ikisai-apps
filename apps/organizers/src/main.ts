import '@ikisai/ui-kit/ui-kit.css';
import './styles/app.css';
import { applyTheme } from '@ikisai/ui-kit';
import { createClient } from './app/client.ts';
import { createPortalApi } from './app/api.ts';
import { loadPublicContact } from './app/common-texts.ts';
import { i18n } from './app/i18n.ts';
import { renderEntry } from './ui/entry.ts';
import { renderShell } from './ui/shell.ts';
import { initUpdates } from './updates.ts';

const root = document.getElementById('app');
if (!root) throw new Error('Falta el contenedor #app');

applyTheme();
const client = createClient();
let unmount: (() => void) | null = null;
/** Error de la entrada y si se acaba de entrar por enlace, para repintar igual al cambiar de idioma. */
let lastError: unknown;
let fromLink = false;

// Sin cola de cambios ni espejo: actualizar el shell es seguro salvo con un formulario a medias (sus borradores
// quedan guardados en el dispositivo, así que tampoco se pierde nada).
initUpdates({ isSafe: () => true });

/**
 * Entrada (API.md §9.1): `/i/<token>` canjea el enlace personal y quita el token de la URL antes de pintar nada.
 * Sin enlace, la sesión guardada o la sesión única; si no hay ninguna, la pantalla de entrada.
 */
async function boot(): Promise<void> {
  const match = location.pathname.match(/^\/i\/([^/?#]*)\/?$/);
  if (match) {
    history.replaceState(null, '', '/');
    try {
      await client.loginWithLink(match[1] ?? '');
      fromLink = true;
    } catch (error) {
      show(error);
      return;
    }
  }
  try {
    await client.start();
  } catch (error) {
    console.warn('[organizers] arranque sin red o sin sesión', error);
  }
  show();
}

function show(error?: unknown): void {
  unmount?.();
  unmount = null;
  lastError = error;
  if (!error && client.session()) {
    unmount = renderShell(root!, { client, fromLink, onLogout: () => { location.hash = ''; show(); } });
    fromLink = false;
    return;
  }
  unmount = renderEntry(root!, { error });
  // Contacto público y cuenta permanente: si llegan, se vuelve a pintar la entrada con ellos.
  void Promise.all([loadPublicContact(), createPortalApi(client).permanentAccount()]).then(([, permanentAccount]) => {
    if (!client.session()) { unmount?.(); unmount = renderEntry(root!, { error, permanentAccount }); }
  });
}

// Cambio de idioma (selector ES | EN): se repinta lo que haya en pantalla en el idioma nuevo.
i18n.onChange(() => show(lastError));

void boot();
