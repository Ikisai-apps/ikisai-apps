/**
 * Registro del service worker y versiones nuevas, común a todas las apps (antes cada una tenía su `updates.ts`, copia del
 * de Booking). Mismo protocolo con el `sw.js` de cada app: `CHECK_UPDATE_READY` → `UPDATE_READY`/`UPDATE_ABORT` →
 * `APPLY_UPDATE`; el SW pregunta a todas las pestañas y solo hace `skipWaiting` si todas responden «listo».
 *
 * **Novedad: la versión nueva se aplica sola al abrir cuando es seguro** (petición del usuario: su PWA se quedó en una
 * versión antigua porque nadie pulsó «Nueva versión disponible»). Mismo criterio que Tasks:
 * - «Al abrir» es arrancar la app **o volver a ella** tras más de un minuto en segundo plano (en Android la PWA no suele
 *   cerrarse).
 * - Solo dentro de una ventana corta (15 s) y **antes de la primera interacción**: nunca se recarga en mitad de algo.
 * - Solo si `isSafe()`: sin cola de cambios, conflictos, editor abierto ni fallo de sincronización (lo decide la app).
 * - Si no se puede, se queda el aviso de siempre (`ikisai:update-available` → banner «Nueva versión disponible»).
 */
import { kt } from '../i18n/i18n.ts';
import { toast } from '../toast.ts';

export interface AppUpdatesOptions {
  /** Verdadero cuando no hay editor con cambios, comandos o conflictos pendientes ni fallo de sincronización. */
  isSafe(): boolean;
  /** Registrar y buscar versiones (las apps pasan `import.meta.env.PROD`; en desarrollo no hay SW). Por defecto, sí. */
  enabled?: boolean;
  /** Ruta del service worker; por defecto `/sw.js`. */
  swUrl?: string;
  /** Aplicar sola la versión nueva al abrir si es seguro (por defecto sí). */
  autoApply?: boolean;
  /** Ventana tras abrir o volver en la que se puede aplicar sola (ms); por defecto 15 000. */
  autoWindowMs?: number;
  /** Tiempo en segundo plano a partir del cual volver cuenta como «abrir» (ms); por defecto 60 000. */
  resumeAfterMs?: number;
  /** Cada cuánto se busca versión nueva con la app visible (ms); por defecto 5 minutos. */
  checkEveryMs?: number;
}

export interface AppUpdates {
  /** Aplica la versión que espera (botón «Nueva versión disponible»). */
  apply(): void;
  /** Busca versión nueva ahora. */
  check(): Promise<void>;
  /** ¿Hay una versión esperando? */
  available(): boolean;
}

/** Decisión de aplicar sola (exportada para las pruebas). */
export function shouldAutoApply(input: { autoApply: boolean; openedAt: number; now: number; windowMs: number; interacted: boolean; safe: boolean }): boolean {
  return input.autoApply && !input.interacted && input.now - input.openedAt <= input.windowMs && input.safe;
}

export function initAppUpdates(options: AppUpdatesOptions): AppUpdates {
  const noop: AppUpdates = { apply() {}, async check() {}, available: () => false };
  if (options.enabled === false || typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !isSecureContext) return noop;

  const autoApply = options.autoApply ?? true;
  const windowMs = options.autoWindowMs ?? 15_000;
  const resumeAfter = options.resumeAfterMs ?? 60_000;
  let registration: ServiceWorkerRegistration | null = null;
  let locked = false;
  let unlockTimer: ReturnType<typeof setTimeout> | null = null;
  let openedAt = Date.now();
  let interacted = false;
  let hiddenAt: number | null = null;
  let auto = false;

  const unlock = () => { locked = false; if (unlockTimer) clearTimeout(unlockTimer); unlockTimer = null; };

  function apply(silent = false): void {
    if (!options.isSafe()) {
      if (!silent) toast(kt('Guarda y cierra el formulario; sincroniza o resuelve tus cambios pendientes antes de actualizar.'));
      return;
    }
    auto = silent;
    registration?.waiting?.postMessage({ type: 'APPLY_UPDATE' });
  }

  /** Hay versión esperando: se aplica sola si toca; si no, aviso (banner). */
  const announce = () => {
    if (!registration?.waiting) return;
    if (shouldAutoApply({ autoApply, openedAt, now: Date.now(), windowMs, interacted, safe: options.isSafe() })) {
      toast(kt('Actualizando a la versión nueva…'));
      apply(true);
      return;
    }
    window.dispatchEvent(new CustomEvent('ikisai:update-available', { detail: { apply: () => apply(false) } }));
  };

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; requestId?: string } | undefined;
    if (data?.type === 'UPDATE_ABORT') {
      unlock();
      if (!auto) toast(kt('Hay otra pestaña con cambios o un formulario abierto. Ciérrala o termina de guardar antes de actualizar.'));
      else window.dispatchEvent(new CustomEvent('ikisai:update-available', { detail: { apply: () => apply(false) } }));
      auto = false;
      return;
    }
    if (data?.type !== 'CHECK_UPDATE_READY') return;
    const ready = options.isSafe();
    locked = ready;
    if (ready) unlockTimer = setTimeout(unlock, 8000);
    (event.source as ServiceWorker | null)?.postMessage({ type: 'UPDATE_READY', requestId: data.requestId, ready });
  });

  // Durante el breve apretón de manos no se admiten ediciones nuevas; la primera interacción cierra la ventana automática.
  for (const name of ['pointerdown', 'click', 'keydown', 'submit'] as const) {
    document.addEventListener(name, (event) => {
      if (locked) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (name === 'pointerdown' || name === 'keydown') interacted = true;
    }, true);
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (locked) location.reload(); });

  const check = async () => { if (navigator.onLine) await registration?.update().catch(() => undefined); announce(); };

  // Volver a la app tras un rato fuera cuenta como abrir: ventana nueva y búsqueda de versión.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt !== null && Date.now() - hiddenAt >= resumeAfter) {
      openedAt = Date.now();
      interacted = false;
      void check();
    }
    hiddenAt = null;
  });

  navigator.serviceWorker
    .register(options.swUrl ?? '/sw.js')
    .then(async (current) => {
      registration = current;
      announce();
      current.addEventListener('updatefound', () => {
        const worker = current.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) announce();
        });
      });
      if (navigator.onLine) await current.update().catch(() => undefined);
    })
    .catch(() => undefined);

  window.addEventListener('online', () => { void registration?.update().catch(() => undefined); });
  setInterval(() => {
    if (!document.hidden && navigator.onLine) void registration?.update().catch(() => undefined);
  }, options.checkEveryMs ?? 5 * 60 * 1000);

  return { apply: () => apply(false), check, available: () => !!registration?.waiting };
}
