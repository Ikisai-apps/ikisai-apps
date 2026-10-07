/**
 * Guía de adopción del feedback, el revisor y el uso en una app interna (Tasks, Finance, Central, Food, Booking).
 * Este archivo **compila con `tsc`** (está en el `include` del kit): si cambia una firma, la guía se rompe aquí antes que
 * en las apps. Cópialo cambiando `APP` y la manera de leer la pantalla actual.
 *
 * Piezas:
 * 1. `createFeedback`: modo «Señalar para comentar», composer, borradores y bandeja.
 * 2. `createFeedbackReview`: modo «Revisor de QA» (solo aparece en la cuenta del dueño).
 * 3. `createUsage`: uso de funcionalidades (y el aviso al equipo la primera vez).
 * 4. `createAppLauncher({ feedback, review, center })`: los dos interruptores y la entrada «Sugerencias y QA» van en el
 *    panel de la marca. **No hace falta ningún botón en la cabecera.**
 * Marca los controles con significado con `data-feedback-id="<app>.<pantalla>.<sección>.<elemento>"` y
 * `data-feedback-label`; las zonas con datos personales que no deben disparar el gesto, con `data-feedback-ignore`.
 */
import type { SyncClient } from '@ikisai/sync-client';
import {
  createAppLauncher,
  createAppShell,
  createFeedback,
  createFeedbackReview,
  createUsage,
  openFeedbackCenter,
  type LauncherCatalog,
} from '../src/index.ts';

const APP = 'booking';

export function adoptFeedback(root: HTMLElement, client: SyncClient, screen: () => { id: string; label: string }) {
  const api = client.api.bind(client);
  const userId = () => client.bootstrap()?.profile.userId ?? null;
  let catalog: LauncherCatalog | null = null;

  const feedback = createFeedback({
    app: APP,
    api,
    userId,
    role: () => client.bootstrap()?.membership.role ?? null,
    syncSummary: () => {
      const s = client.status();
      return { pending: s.pendingCommands + s.pendingBlobs, conflicts: s.conflicts, lastSyncAt: s.lastPullAt, cursor: s.cursor };
    },
    fallbackNode: () => ({ id: screen().id, path: [screen().label] }),
  });
  const review = createFeedbackReview({ api, app: APP, appDomain: (id) => catalog?.items.find((a) => a.id === id)?.domain });
  const usage = createUsage({ app: APP, api, userId });
  const offSessionEnd = client.onSessionEnd((id) => { void feedback.clear(id); void usage.clear(id); });

  const launcher = createAppLauncher({
    current: APP,
    fetchApps: async () => (catalog = await client.api<LauncherCatalog>('/apps')),
    feedback,
    review,
    center: () => { openFeedbackCenter({ api, app: APP, canEdit: () => client.bootstrap()?.membership.role !== 'reader', feedback }); },
  });
  const shell = createAppShell(root, { appName: 'Booking', markIcon: 'bed', nav: [], launcher });

  // En las 5–10 operaciones importantes: éxito y error.
  const save = (write: () => Promise<void>) => usage.run(`${APP}.reserva.guardar`, write);

  return { shell, feedback, review, usage, save, destroy: () => { offSessionEnd(); feedback.destroy(); review.destroy(); usage.destroy(); shell.destroy(); } };
}
