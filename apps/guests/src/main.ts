import '@ikisai/ui-kit/ui-kit.css';
import './styles/app.css';
import { applyTheme, initAppUpdates, readGuideLink, readReturnTo } from '@ikisai/ui-kit';
import { createClient } from './app/client.ts';
import { createGuestApi } from './app/api.ts';
import { onLocaleChange } from './app/i18n.ts';
import { loadPublicContact } from './app/common-texts.ts';
import { renderEntry } from './ui/entry.ts';
import { renderShell } from './ui/shell.ts';
import { redeemHandoff } from './app/visitor.ts';
import { isVisitorHash, renderVisitor, visitorEntry } from './ui/visitor.ts';

const root = document.getElementById('app');
if (!root) throw new Error('Falta el contenedor #app');

applyTheme();
const client = createClient();
let unmount: (() => void) | null = null;
let busy: () => boolean = () => false;
let entryError: unknown;
/** Ficha del enlace canjeado (C10, `sync-client` 0.7.1): «por enlace, ese retiro» aunque la cuenta tenga varios. Solo en memoria. */
let linkedGuestId: string | null = null;

// Versiones nuevas (kit 0.23): al abrir o al volver tras más de un minuto se aplican solas si es seguro, es decir, sin
// cambios por confirmar en la cola (que además sobrevive a una recarga, writer.ts).
initAppUpdates({ isSafe: () => !busy(), enabled: import.meta.env.PROD });

/**
 * Entrada (API.md §9.1): `/i/<token>` canjea el enlace personal y quita el token de la URL antes de pintar nada. Si en
 * el dispositivo había otra persona, `loginWithLink` cierra su sesión (y `onSessionEnd` borra su caché). Sin enlace, la
 * sesión guardada o la sesión única; si no hay ninguna, la pantalla de entrada.
 */
async function boot(): Promise<void> {
  // Visitantes por QR (§9.19): `/e/<código>` abre el portal del visitante, sin sesión ni datos.
  const visitor = visitorEntry(location.pathname, location.search);
  // Desde la carta de Flow llega además `v`: el traspaso de la misma identidad de visitante (un solo uso; sin él, caducado o
  // si este móvil ya tiene la suya, se sigue como estaba). La URL se limpia antes de canjearlo.
  const handoff = visitor ? new URLSearchParams(location.search).get('v') : null;
  // El Guiado de Flow llega con `?campo=…&paso=…&volver=…`: se guardan en la pestaña antes de limpiar la URL.
  if (visitor) { readReturnTo(); readGuideLink(); history.replaceState(null, '', `/${visitor}`); }
  if (handoff) await redeemHandoff(handoff).catch(() => false);
  const match = location.pathname.match(/^\/i\/([^/?#]*)\/?$/);
  if (match) {
    history.replaceState(null, '', '/');
    try {
      const grant = (await client.loginWithLink(match[1] ?? '')).grant as { guest_id?: unknown } | null | undefined;
      linkedGuestId = typeof grant?.guest_id === 'string' ? grant.guest_id.toLowerCase() : null;
    } catch (error) {
      // Sin callejón (VG, 28-10): una app instalada desde un enlace de un solo uso vuelve a él en cada arranque. Si ya hay
      // sesión guardada, se sigue con ella; si no, la entrada dice que caducó y enseña los eventos abiertos.
      entryError = error;
    }
  }
  try {
    await client.start();
  } catch (error) {
    console.warn('[guests] arranque sin red o sin sesión', error);
  }
  if (entryError && client.session()) entryError = null;
  show();
}

/** ¿Se está enseñando el portal del visitante? Cambia con el ancla (`#/v…`). */
let visitorMode = false;

function show(): void {
  unmount?.();
  unmount = null;
  visitorMode = isVisitorHash(location.hash);
  if (visitorMode) {
    unmount = renderVisitor(root!, client);
    return;
  }
  if (!entryError && client.session()) {
    unmount = renderShell(root!, {
      client,
      linkedGuestId,
      onLogout: () => { linkedGuestId = null; location.hash = ''; show(); },
      setBusy: (fn) => { busy = fn; },
    });
    return;
  }
  const paintEntry = (permanentAccount?: boolean) => {
    unmount?.();
    unmount = renderEntry(root!, { error: entryError, retry: () => location.reload(), ...(permanentAccount ? { permanentAccount } : {}) });
  };
  paintEntry();
  // Contacto público y cuenta permanente: si llegan, se vuelve a pintar la entrada con ellos.
  void Promise.all([loadPublicContact(), createGuestApi(client).permanentAccount()]).then(([, permanentAccount]) => {
    if (!client.session() || entryError) paintEntry(permanentAccount);
  });
}

// Cambio de idioma (selector de la cabecera o de la entrada): se repinta todo; la cola de guardado sigue en IndexedDB.
onLocaleChange(() => show());
// Entrar o salir del portal del visitante desde un enlace (`#/v…` ↔ el resto).
window.addEventListener('hashchange', () => { if (isVisitorHash(location.hash) !== visitorMode) show(); });

void boot();
