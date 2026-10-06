import '@ikisai/ui-kit/ui-kit.css';
import './styles/app.css';
import { applyTheme, renderLogin } from '@ikisai/ui-kit';
import { createClient, describeError } from './app/client.ts';
import { safeToUpdate } from './app/guard.ts';
import { clearPhotoCache } from './app/photos.ts';
import { renderShell } from './ui/shell.ts';
import { initUpdates } from './updates.ts';

const root = document.getElementById('app');
if (!root) throw new Error('Falta el contenedor #app');

applyTheme();
const client = createClient();
let unmountShell: (() => void) | null = null;
let unmountLogin: (() => void) | null = null;

initUpdates({ isSafe: () => safeToUpdate(client) });

async function boot(): Promise<void> {
  try {
    // Carga el espejo local y, si hay sesión y red, bootstrap + snapshot + primer pull.
    await client.start();
  } catch (error) {
    console.warn('[food] arranque sin red o sin sesión', error);
  }
  route();
}

function route(): void {
  unmountShell?.();
  unmountShell = null;
  unmountLogin?.();
  unmountLogin = null;
  if (client.session()) {
    unmountShell = renderShell(root!, {
      client,
      onLogout: () => {
        void clearPhotoCache();
        location.hash = '';
        route();
      },
    });
  } else {
    unmountLogin = renderLogin(root!, {
      appName: 'Food',
      tagline: 'Recetario, menús, compra y preparación',
      describeError,
      async onLogin(email, password) {
        await client.login(email, password);
        await client.start();
        route();
      },
    });
  }
}

void boot();
