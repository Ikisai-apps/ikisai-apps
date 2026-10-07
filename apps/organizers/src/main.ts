import '@ikisai/ui-kit/ui-kit.css';
import './styles/app.css';
import { applyTheme } from '@ikisai/ui-kit';
import { createClient } from './app/client.ts';
import { createPortalApi } from './app/api.ts';
import { renderEntry } from './ui/entry.ts';
import { renderShell } from './ui/shell.ts';
import { initUpdates } from './updates.ts';

const root = document.getElementById('app');
if (!root) throw new Error('Falta el contenedor #app');

applyTheme();
const client = createClient();
let unmount: (() => void) | null = null;

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
  if (!error && client.session()) {
    unmount = renderShell(root!, { client, onLogout: () => { location.hash = ''; show(); } });
    return;
  }
  unmount = renderEntry(root!, { error });
  void createPortalApi(client).permanentAccount().then((on) => {
    if (on && !client.session()) { unmount?.(); unmount = renderEntry(root!, { error, permanentAccount: true }); }
  });
}

void boot();
