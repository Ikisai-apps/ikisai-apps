import './styles/tokens.css';
import './styles/app.css';
import { createClient } from './app/client.ts';
import { safeToUpdate } from './app/guard.ts';
import { renderLogin } from './ui/login.ts';
import { renderShell } from './ui/shell.ts';
import { initUpdates } from './updates.ts';

const root = document.getElementById('app');
if (!root) throw new Error('Falta el contenedor #app');

const client = createClient();
let unmountShell: (() => void) | null = null;

initUpdates({ isSafe: () => safeToUpdate(client) });

async function boot(): Promise<void> {
  try {
    // Carga el espejo local y, si hay sesión y red, bootstrap + snapshot + primer pull.
    await client.start();
  } catch (error) {
    console.warn('[invoices] arranque sin red o sin sesión', error);
  }
  route();
}

function route(): void {
  unmountShell?.();
  unmountShell = null;
  if (client.session()) {
    unmountShell = renderShell(root!, {
      client,
      onLogout: () => {
        location.hash = '';
        route();
      },
    });
  } else {
    renderLogin(root!, {
      async onLogin(email, password) {
        await client.login(email, password);
        await client.start();
        route();
      },
    });
  }
}

void boot();
