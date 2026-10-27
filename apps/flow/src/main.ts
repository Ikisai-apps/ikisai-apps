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

/**
 * Entradas (decisión de VG, 27-10; MUELA/equipo/feedback/flow/URLS_ENTRADA.md): `flow.ikisai.com/` es la entrada del equipo
 * (login del kit, menú común, PWA), como el resto de apps. La carta pública sigue aquí, en `/recorridos/carta`, pero se llega
 * desde ven.ikisai.com (la única entrada pública), con la identidad de visitante en los dos sentidos.
 * Las URL antiguas las redirige el worker con 301 (`public/_worker.js`); aquí se repite para el servidor de desarrollo y por si
 * una página vieja quedó en caché: `/equipo…` → `/`, `/carta` → ven.ikisai.com, `/?invitacion=` → la carta.
 */
export const CARTA_PATH = '/recorridos/carta';
const path = location.pathname.replace(/\/+$/, '') || '/';
const params = new URLSearchParams(location.search);

if (path === '/equipo' || path.startsWith('/equipo/')) {
  history.replaceState(null, '', `/${location.search}${location.hash}`);
  startStaffApp(root);
} else if (path === '/carta') {
  location.replace('https://ven.ikisai.com/');
} else if (path === CARTA_PATH || (path === '/' && params.has('invitacion'))) {
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
