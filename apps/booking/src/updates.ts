/**
 * Registro del service worker y activación coordinada (patrón heredado de ikisai-tasks-ref/app/updates.js).
 * Actualizar el shell nunca debe interrumpir un formulario abierto ni una cola pendiente:
 * el SW pregunta a todas las pestañas y solo hace skipWaiting si todas responden «listo».
 */
import { toast } from './ui/toast.ts';

export interface UpdatesOptions {
  /** Verdadero cuando no hay editor con cambios ni comandos/conflictos pendientes. */
  isSafe(): boolean;
}

export function initUpdates(options: UpdatesOptions): void {
  if (!('serviceWorker' in navigator) || !isSecureContext || !import.meta.env.PROD) return;

  let registration: ServiceWorkerRegistration | null = null;
  let locked = false;
  let unlockTimer: ReturnType<typeof setTimeout> | null = null;

  const unlock = () => {
    locked = false;
    if (unlockTimer) clearTimeout(unlockTimer);
    unlockTimer = null;
  };

  const announce = () => {
    if (!registration?.waiting) return;
    window.dispatchEvent(new CustomEvent('ikisai:update-available', { detail: { apply } }));
  };

  function apply(): void {
    if (!options.isSafe()) {
      toast('Guarda y cierra el formulario; sincroniza o resuelve tus cambios pendientes antes de actualizar.');
      return;
    }
    registration?.waiting?.postMessage({ type: 'APPLY_UPDATE' });
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; requestId?: string } | undefined;
    if (data?.type === 'UPDATE_ABORT') {
      unlock();
      toast('Hay otra pestaña con cambios o un formulario abierto. Ciérrala o termina de guardar antes de actualizar.');
      return;
    }
    if (data?.type !== 'CHECK_UPDATE_READY') return;
    const ready = options.isSafe();
    locked = ready;
    if (ready) unlockTimer = setTimeout(unlock, 8000);
    (event.source as ServiceWorker | null)?.postMessage({ type: 'UPDATE_READY', requestId: data.requestId, ready });
  });

  // Durante el breve apretón de manos no se admiten ediciones nuevas.
  for (const name of ['pointerdown', 'click', 'keydown', 'submit'] as const) {
    document.addEventListener(name, (event) => {
      if (locked) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (locked) location.reload();
  });

  navigator.serviceWorker
    .register('/sw.js')
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

  window.addEventListener('online', () => registration?.update().catch(() => undefined));
  setInterval(() => {
    if (!document.hidden && navigator.onLine) registration?.update().catch(() => undefined);
  }, 5 * 60 * 1000);
}
