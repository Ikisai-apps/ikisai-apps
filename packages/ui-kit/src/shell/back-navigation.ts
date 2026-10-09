/**
 * «Atrás» dentro de la app (FB_2026_025): antes, «atrás» en cualquier pantalla cerraba la PWA.
 * - Desde cualquier pantalla, «atrás» vuelve a la anterior dentro de la app o, si no la hay, al **inicio**.
 * - Desde el inicio, «atrás» pregunta «¿Cerrar la app?» (Cerrar / Cancelar); con «Cerrar» la deja salir.
 * - Con una hoja o un diálogo del kit abiertos, «atrás» **los cierra primero** (cada uno apila su propia entrada).
 * Lo instala `createAppShell` (las apps no hacen nada); Tasks, que tiene su propia cáscara, llama a
 * `installBackNavigation()` al arrancar.
 *
 * Historia que se monta al arrancar: `[raíz: inicio] → [guardia: inicio] → (pantalla de entrada, si no es el inicio)`.
 * «Atrás» en la guardia enseña el inicio; «atrás» en la raíz es «salir» → diálogo; «Cancelar» repone la guardia.
 */
import { confirmDialog } from '../overlay/dialog.ts';
import { kt } from '../i18n/i18n.ts';

export interface BackNavigationOptions {
  /** URL del inicio. Por defecto `#/` si la app navega por hash (`#/…`), si no `/`. */
  home?: string;
  /** Pregunta antes de salir desde el inicio (por defecto sí). */
  confirmExit?: boolean;
}

type Entry = { ikisai?: 'root' | 'guard' | 'overlay'; overlay?: number };

let installed = false;
let ignorePops = 0;
let nextOverlay = 1;
/** Hojas y diálogos abiertos, el último arriba: «atrás» cierra el de arriba. */
const overlays: { id: number; close: () => void }[] = [];
let asking = false;
let homeUrl = '/';

const stateOf = (): Entry => (history.state && typeof history.state === 'object' ? history.state as Entry : {});

function urlOf(home: string): string {
  return home.startsWith('#') ? `${location.pathname}${location.search}${home}` : home;
}

/** Espera al `popstate` que provoca un `history.back()` propio (sin tratarlo como navegación). */
function backQuietly(): Promise<void> {
  return new Promise((resolve) => {
    ignorePops += 1;
    const done = () => { window.removeEventListener('popstate', done); setTimeout(resolve, 0); };
    window.addEventListener('popstate', done);
    history.back();
  });
}

async function askExit(confirmExit: boolean): Promise<void> {
  if (asking) return;
  if (!confirmExit) { await backQuietly(); return; }
  asking = true;
  const close = await confirmDialog({ title: kt('¿Cerrar la app?'), confirmLabel: kt('Cerrar'), cancelLabel: kt('Cancelar') });
  asking = false;
  // El diálogo tenía su propia entrada: se espera a volver a la raíz antes de seguir.
  for (let i = 0; i < 20 && stateOf().ikisai !== 'root'; i++) await new Promise((r) => setTimeout(r, 25));
  if (close) {
    // Desde la raíz, un paso más atrás sale de la app (en la PWA, se cierra).
    ignorePops += 1;
    history.back();
  } else {
    history.pushState({ ikisai: 'guard' } satisfies Entry, '', urlOf(homeUrl));
  }
}

export function installBackNavigation(options: BackNavigationOptions = {}): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  homeUrl = options.home ?? (location.hash.startsWith('#/') || location.hash === '#' ? '#/' : '/');
  const confirmExit = options.confirmExit ?? true;
  const here = `${location.pathname}${location.search}${location.hash}`;
  const atHome = urlOf(homeUrl) === here || (homeUrl === '#/' && (location.hash === '' || location.hash === '#' || location.hash === '#/'));
  history.replaceState({ ikisai: 'root' } satisfies Entry, '', urlOf(homeUrl));
  history.pushState({ ikisai: 'guard' } satisfies Entry, '', urlOf(homeUrl));
  if (!atHome) history.pushState(null, '', here);

  window.addEventListener('popstate', () => {
    if (ignorePops > 0) { ignorePops -= 1; return; }
    // Hoja o diálogo abierto: «atrás» lo cierra (su entrada ya se ha consumido).
    const top = overlays.pop();
    if (top) { top.close(); return; }
    if (stateOf().ikisai === 'root') void askExit(confirmExit);
  });
}

export interface OverlayHandle {
  /** Cerrado por otra vía (botón, Escape, fondo): quita su entrada de la historia. */
  release(): void;
  /** La entrada pasa a cerrar otra cosa (una hoja que sustituye a la anterior hereda su entrada). */
  setClose(close: () => void): void;
  /** ¿Sigue registrada (no se ha cerrado con «atrás»)? */
  active(): boolean;
}

/**
 * Registra una hoja o diálogo abierto: apila su entrada en la historia. «Atrás» la consume y llama a `close`.
 * Sin `installBackNavigation`, no hace nada.
 */
export function trackOverlay(close: () => void): OverlayHandle {
  const inert: OverlayHandle = { release() {}, setClose() {}, active: () => false };
  if (!installed) return inert;
  const id = nextOverlay++;
  const entry = { id, close };
  overlays.push(entry);
  history.pushState({ ikisai: 'overlay', overlay: id } satisfies Entry, '', location.href);
  return {
    release() {
      const at = overlays.indexOf(entry);
      if (at < 0) return; // ya cerrado con «atrás»
      overlays.splice(at, 1);
      // Solo se quita su entrada si sigue arriba: si la app navegó con la hoja abierta, no se deshace esa navegación.
      if (stateOf().ikisai === 'overlay' && stateOf().overlay === id) { ignorePops += 1; history.back(); }
    },
    setClose(next) { entry.close = next; },
    active: () => overlays.includes(entry),
  };
}

/** Para las pruebas: ¿está instalado? */
export function backNavigationInstalled(): boolean { return installed; }
