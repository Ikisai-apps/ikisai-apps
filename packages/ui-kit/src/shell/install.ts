/**
 * Promoción de la instalación (portales y apps): «Instala la app» con su alternativa web.
 * - Guarda el `beforeinstallprompt` de Chromium (Android, escritorio) en cuanto se importa el kit, para poder lanzar el
 *   instalador desde un botón propio.
 * - Abierta ya como app instalada (`display-mode` standalone/fullscreen/minimal-ui o `navigator.standalone` en iOS), no
 *   se promociona nada.
 * - Si el navegador no deja instalar desde la página (iPhone, Firefox…), explica cómo hacerlo en ese sistema y ofrece
 *   «Seguir en la web».
 * - «Ahora no» se recuerda por dispositivo (`ikisai-install-dismissed:<app>`), con caducidad.
 */
import { el } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { icon, type IconName } from '../icons.ts';
import { openSheet, type Sheet } from '../overlay/sheet.ts';

interface InstallEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallEvent | null = null;
const promptListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallEvent;
    for (const l of promptListeners) l();
  });
  window.addEventListener('appinstalled', () => { deferred = null; for (const l of promptListeners) l(); });
}

/** ¿Se está usando como app instalada? */
export function isAppInstalled(): boolean {
  const mode = (m: string) => typeof matchMedia === 'function' && matchMedia(`(display-mode: ${m})`).matches;
  return mode('standalone') || mode('fullscreen') || mode('minimal-ui') || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export type InstallPlatform = 'ios' | 'android' | 'desktop';
export function installPlatform(): InstallPlatform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

export interface InstallPromptOptions {
  /** Nombre que se instala: «Ikisai Guests». */
  appName: string;
  /** Id para recordar «Ahora no» en el dispositivo. */
  app: string;
  markIcon?: IconName;
  /** Días que se respeta «Ahora no»; por defecto 14. */
  snoozeDays?: number;
  /** Se llama tras instalar o elegir la web (p. ej. para medir con `usage.track`). */
  onOutcome?: (outcome: 'installed' | 'dismissed' | 'web') => void;
  /** Dónde montar la hoja (apps con CSS acotado). */
  container?: () => HTMLElement;
}

export interface InstallPrompt {
  /** El navegador deja lanzar el instalador desde un botón (Chromium con `beforeinstallprompt`). */
  canPrompt(): boolean;
  isInstalled(): boolean;
  /** ¿Conviene promocionar? No instalada y sin «Ahora no» reciente. */
  shouldPromote(): boolean;
  /** Lanza el instalador del navegador si se puede; si no, abre la hoja con las instrucciones. */
  install(): Promise<'installed' | 'dismissed' | 'instructions'>;
  /** Hoja «Instala la app» con el botón o las instrucciones, «Seguir en la web» y «Ahora no». */
  openSheet(): Sheet;
  /** Tarjeta para la pantalla de inicio (o `null` si está instalada). */
  card(): HTMLElement | null;
  onChange(listener: () => void): () => void;
}

export function createInstallPrompt(options: InstallPromptOptions): InstallPrompt {
  const key = `ikisai-install-dismissed:${options.app}`;
  const snooze = (options.snoozeDays ?? 14) * 86_400_000;

  const dismissedRecently = () => {
    try { const at = Number(localStorage.getItem(key) ?? 0); return at > 0 && Date.now() - at < snooze; } catch { return false; }
  };
  const remember = () => { try { localStorage.setItem(key, String(Date.now())); } catch { /* */ } };

  function steps(): HTMLElement {
    const platform = installPlatform();
    const items = platform === 'ios'
      ? [kt('Abre esta página en Safari.'), kt('Toca Compartir (el cuadrado con la flecha).'), kt('Elige «Añadir a pantalla de inicio».')]
      : platform === 'android'
        ? [kt('Abre el menú del navegador (⋮).'), kt('Elige «Instalar aplicación» o «Añadir a pantalla de inicio».')]
        : [kt('Busca el icono de instalar en la barra de direcciones, o abre el menú del navegador.'), kt('Elige «Instalar {app}».', { app: options.appName })];
    return el('ol', { class: 'install-steps', dataset: { platform } }, ...items.map((t) => el('li', null, t)));
  }

  async function install(): Promise<'installed' | 'dismissed' | 'instructions'> {
    if (!deferred) { openInstallSheet(); return 'instructions'; }
    const event = deferred;
    deferred = null;
    await event.prompt();
    const { outcome } = await event.userChoice;
    const result = outcome === 'accepted' ? 'installed' : 'dismissed';
    options.onOutcome?.(result);
    return result;
  }

  function openInstallSheet(): Sheet {
    let sheet: Sheet | null = null;
    const can = !!deferred;
    const installButton = can ? el('button', { type: 'button', class: 'primary install-now', onclick: async () => { await sheet?.close(true); void install(); } }, icon('download', 18), kt('Instalar {app}', { app: options.appName })) : null;
    const web = el('button', { type: 'button', class: 'ghost install-web', onclick: () => { remember(); options.onOutcome?.('web'); void sheet?.close(true); } }, kt('Seguir en la web'));
    const later = el('button', { type: 'button', class: 'linkbtn install-later', onclick: () => { remember(); options.onOutcome?.('dismissed'); void sheet?.close(true); } }, kt('Ahora no'));
    sheet = openSheet({
      title: kt('Instala la app'),
      container: options.container?.(),
      body: el('div', { class: 'install-sheet' },
        el('div', { class: 'install-head' },
          el('span', { class: 'mark', 'aria-hidden': 'true' }, icon(options.markIcon ?? 'mark', 22)),
          el('p', null, kt('Con {app} en tu pantalla de inicio se abre al momento, a pantalla completa, y funciona aunque no haya cobertura.', { app: options.appName }))),
        can ? null : el('p', { class: 'hint' }, kt('Tu navegador no deja instalarla desde aquí. Puedes hacerlo así:')),
        can ? null : steps(),
        el('p', { class: 'hint' }, kt('También puedes seguir usándola en el navegador: es la misma app.'))),
      foot: el('div', { class: 'install-foot' }, later, web, installButton),
    });
    return sheet;
  }

  function card(): HTMLElement | null {
    if (isAppInstalled()) return null;
    return el('article', { class: 'card install-card' },
      el('h3', null, kt('Instala {app}', { app: options.appName })),
      el('p', { class: 'hint' }, kt('Se abre al momento y funciona sin cobertura.')),
      el('p', null, el('button', { type: 'button', class: 'ghost install-open', onclick: () => void install() }, icon('download', 16), kt('Instalar'))));
  }

  return {
    canPrompt: () => !!deferred,
    isInstalled: isAppInstalled,
    shouldPromote: () => !isAppInstalled() && !dismissedRecently(),
    install,
    openSheet: openInstallSheet,
    card,
    onChange(listener) { promptListeners.add(listener); return () => promptListeners.delete(listener); },
  };
}
