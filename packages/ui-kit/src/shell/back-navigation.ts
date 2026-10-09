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
 *
 * **Sin `history.back()` asíncronos al cerrar por la interfaz:** una hoja cerrada con su botón, Escape o el fondo deja
 * su entrada **marcada como muerta** (`replaceState`, síncrono), y «atrás» se salta las muertas. Antes, un «atrás»
 * propio en vuelo podía deshacer una navegación que llegaba justo después (Food: cerrar el lanzador y navegar a
 * `#/maquinaria`; «Crear menú» → `#/menus/…`).
 */
import { confirmDialog } from '../overlay/dialog.ts';
import { kt } from '../i18n/i18n.ts';

export interface BackNavigationOptions {
  /** URL del inicio. Por defecto `#/` si la app navega por hash (`#/…`), si no `/`. */
  home?: string;
  /** Pregunta antes de salir desde el inicio (por defecto sí). */
  confirmExit?: boolean;
}

type Entry = { ikisai?: 'root' | 'guard' | 'overlay' | 'dead'; overlay?: number };

let installed = false;
let ignorePops = 0;
let nextOverlay = 1;
/** Hojas y diálogos abiertos, el último arriba: «atrás» cierra el de arriba. */
const overlays: { id: number; close: () => void }[] = [];
let asking = false;
let homeUrl = '/';
/** Estado de la entrada actual (se siguen `pushState`, `replaceState`, `hashchange` y `popstate`). */
let current: Entry | null = null;
/** «Atrás» automático para saltar una entrada muerta: el siguiente `popstate` no aplica la regla de «venir de una muerta». */
let skipping = false;
/** Largo de la historia: un `popstate` que lo cambia es una navegación nueva (Chrome lo dispara al cambiar `location.hash`), no un «atrás». */
let knownLength = 0;

const asEntry = (state: unknown): Entry | null => (state && typeof state === 'object' ? state as Entry : null);

function urlOf(home: string): string {
  return home.startsWith('#') ? `${location.pathname}${location.search}${home}` : home;
}

async function askExit(confirmExit: boolean): Promise<void> {
  if (asking) return;
  if (!confirmExit) { ignorePops += 1; history.back(); return; }
  asking = true;
  const close = await confirmDialog({ title: kt('¿Cerrar la app?'), confirmLabel: kt('Cerrar'), cancelLabel: kt('Cancelar') });
  asking = false;
  if (close) {
    // Desde la raíz (o desde la entrada muerta que deja el diálogo encima), un paso más atrás sale de la app.
    ignorePops += 1;
    history.go(current?.ikisai === 'dead' ? -2 : -1);
  } else {
    history.pushState({ ikisai: 'guard' } satisfies Entry, '', urlOf(homeUrl));
  }
}

export function installBackNavigation(options: BackNavigationOptions = {}): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  homeUrl = options.home ?? (location.hash.startsWith('#/') || location.hash === '#' ? '#/' : '/');
  const confirmExit = options.confirmExit ?? true;

  // Seguir la entrada actual también cuando navega la app.
  const rawPush = history.pushState.bind(history);
  const rawReplace = history.replaceState.bind(history);
  history.pushState = (state: unknown, title: string, url?: string | URL | null) => { rawPush(state, title, url); current = asEntry(state); knownLength = history.length; };
  history.replaceState = (state: unknown, title: string, url?: string | URL | null) => { rawReplace(state, title, url); current = asEntry(state); knownLength = history.length; };
  window.addEventListener('hashchange', () => { current = asEntry(history.state); knownLength = history.length; });

  const here = `${location.pathname}${location.search}${location.hash}`;
  const atHome = urlOf(homeUrl) === here || (homeUrl === '#/' && (location.hash === '' || location.hash === '#' || location.hash === '#/'));
  history.replaceState({ ikisai: 'root' } satisfies Entry, '', urlOf(homeUrl));
  history.pushState({ ikisai: 'guard' } satisfies Entry, '', urlOf(homeUrl));
  if (!atHome) history.pushState(null, '', here);

  window.addEventListener('popstate', () => {
    const left = current;
    current = asEntry(history.state);
    // Navegación por fragmento (`location.hash = …`): entrada nueva, no un «atrás».
    if (history.length !== knownLength) { knownLength = history.length; return; }
    if (ignorePops > 0) { ignorePops -= 1; return; }
    // Hoja o diálogo abierto: «atrás» lo cierra (su entrada ya se ha consumido).
    const top = overlays.pop();
    if (top) { top.close(); return; }
    const wasSkipping = skipping;
    skipping = false;
    // Se ha caído en una entrada muerta (una hoja ya cerrada, o una de hoja que ya no está): se salta.
    if (current?.ikisai === 'dead' || (current?.ikisai === 'overlay' && !overlays.some((o) => o.id === current?.overlay))) {
      skipping = true;
      history.back();
      return;
    }
    // Se venía de una entrada muerta: la de debajo es la misma pantalla, así que «atrás» sigue un paso más.
    if (!wasSkipping && left?.ikisai === 'dead' && current?.ikisai !== 'root') {
      skipping = true;
      history.back();
      return;
    }
    if (current?.ikisai === 'root') void askExit(confirmExit);
  });
}

export interface OverlayHandle {
  /** Cerrado por otra vía (botón, Escape, fondo): su entrada queda muerta y «atrás» la salta. */
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
      // Síncrono: si su entrada sigue arriba, queda muerta (misma URL). Si la app ya navegó, esa entrada está debajo y
      // «atrás» la saltará al pasar por ella.
      if (current?.ikisai === 'overlay' && current.overlay === id) history.replaceState({ ikisai: 'dead' } satisfies Entry, '', location.href);
    },
    setClose(next) { entry.close = next; },
    active: () => overlays.includes(entry),
  };
}

/** Para las pruebas: ¿está instalado? */
export function backNavigationInstalled(): boolean { return installed; }
