import '@ikisai/ui-kit/ui-kit.css';
import './styles/app.css';
import { applyTheme, initAppUpdates, renderLogin } from '@ikisai/ui-kit';
import { createClient, describeError } from './app/client.ts';
import { safeToUpdate } from './app/guard.ts';
import { mountCarta } from './public/carta.ts';
import { renderShell } from './ui/shell.ts';

const root = document.getElementById('app');
if (!root) throw new Error('Falta el contenedor #app');

applyTheme();

/** Carta pública (canon V1 §3): `/carta`, sin sesión ni espejo local. Lo demás es la app del personal. */
const isPublic = /^\/carta\/?$/.test(location.pathname);

if (isPublic) {
  mountCarta(root);
} else {
  startStaffApp(root);
}

function startStaffApp(root: HTMLElement): void {
  const client = createClient();
  let unmountShell: (() => void) | null = null;
  let unmountLogin: (() => void) | null = null;

  // Versiones nuevas (kit 0.23): se aplican solas al abrir si es seguro; si no, queda el aviso de siempre.
  initAppUpdates({ isSafe: () => safeToUpdate(client), enabled: import.meta.env.PROD });

  async function boot(): Promise<void> {
    try {
      // Carga el espejo local y, si hay sesión y red, bootstrap + snapshot + primer pull (o entra con la sesión única).
      await client.start();
    } catch (error) {
      console.warn('[flow] arranque sin red o sin sesión', error);
    }
    route();
  }

  function route(): void {
    unmountShell?.();
    unmountShell = null;
    unmountLogin?.();
    unmountLogin = null;
    if (client.session()) {
      unmountShell = renderShell(root, {
        client,
        onLogout: () => {
          location.hash = '';
          route();
        },
      });
    } else {
      unmountLogin = renderLogin(root, {
        appName: 'Flow',
        markIcon: 'sync',
        tagline: 'Pedidos, preparación y entrega',
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
}
