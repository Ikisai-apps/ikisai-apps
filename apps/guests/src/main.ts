import '@ikisai/ui-kit/ui-kit.css';
import './styles/app.css';
import { applyTheme } from '@ikisai/ui-kit';
import { createClient } from './app/client.ts';
import { createGuestApi } from './app/api.ts';
import { loadPublicContact } from './app/common-texts.ts';
import { renderEntry } from './ui/entry.ts';
import { renderShell } from './ui/shell.ts';
import { initUpdates } from './updates.ts';

const root = document.getElementById('app');
if (!root) throw new Error('Falta el contenedor #app');

applyTheme();
const client = createClient();
let unmount: (() => void) | null = null;
let busy: () => boolean = () => false;
let entryError: unknown;

// Actualizar el shell solo sin cambios por confirmar (la cola también sobrevive a una recarga, writer.ts).
initUpdates({ isSafe: () => !busy() });

/**
 * Entrada (API.md §9.1): `/i/<token>` canjea el enlace personal y quita el token de la URL antes de pintar nada. Si en
 * el dispositivo había otra persona, `loginWithLink` cierra su sesión (y `onSessionEnd` borra su caché). Sin enlace, la
 * sesión guardada o la sesión única; si no hay ninguna, la pantalla de entrada.
 */
async function boot(): Promise<void> {
  const match = location.pathname.match(/^\/i\/([^/?#]*)\/?$/);
  if (match) {
    history.replaceState(null, '', '/');
    try {
      await client.loginWithLink(match[1] ?? '');
    } catch (error) {
      entryError = error;
      show();
      return;
    }
  }
  try {
    await client.start();
  } catch (error) {
    console.warn('[guests] arranque sin red o sin sesión', error);
  }
  show();
}

function show(): void {
  unmount?.();
  unmount = null;
  if (!entryError && client.session()) {
    unmount = renderShell(root!, {
      client,
      onLogout: () => { location.hash = ''; show(); },
      repaint: show,
      setBusy: (fn) => { busy = fn; },
    });
    return;
  }
  const paintEntry = (permanentAccount?: boolean) => {
    unmount?.();
    unmount = renderEntry(root!, { error: entryError, ...(permanentAccount ? { permanentAccount } : {}), repaint: () => paintEntry(permanentAccount) });
  };
  paintEntry();
  // Contacto público y cuenta permanente: si llegan, se vuelve a pintar la entrada con ellos.
  void Promise.all([loadPublicContact(), createGuestApi(client).permanentAccount()]).then(([, permanentAccount]) => {
    if (!client.session() || entryError) paintEntry(permanentAccount);
  });
}

void boot();
