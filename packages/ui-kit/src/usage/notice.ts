/**
 * Aviso al equipo sobre la medición de uso (USO.md §5; aprobado por el usuario): la primera vez, una hoja con
 * «Entendido» → `POST usage/consent`. Hasta aceptarlo, el servidor agrega sin persona (el kit mide igual).
 * - Se pregunta `GET usage/consent` una vez por carga mientras no conste la aceptación en este dispositivo.
 * - No pisa una hoja de la app: si hay una abierta, espera a que se cierre.
 * - Cerrar sin «Entendido» no acepta: vuelve a salir la próxima vez.
 */
import { el } from '../dom.ts';
import { currentSheet, openSheet, type Sheet } from '../overlay/sheet.ts';
import type { FeedbackApi } from '../feedback/client.ts';
import { kt } from '../i18n/i18n.ts';

export interface UsageNoticeOptions {
  api: FeedbackApi;
  userId: () => string | null;
  /** Retraso antes de mostrarlo (ms), para no salir encima del arranque; por defecto 1500. */
  delayMs?: number;
  /** Dónde montar la hoja; por defecto `document.body`. */
  container?: () => HTMLElement;
}

export const USAGE_NOTICE_TEXT = 'Ikisai mide qué funciones se usan para mejorar las herramientas. Lo ve solo Víctor; no se usa para evaluar a nadie.';

const flag = (user: string) => `ikisai-usage-notice:${user}`;

/** Muestra el aviso si la cuenta aún no lo ha aceptado. Resuelve con la hoja abierta o `null`. */
export async function showUsageNotice(options: UsageNoticeOptions): Promise<Sheet | null> {
  const user = options.userId();
  if (!user) return null;
  try { if (localStorage.getItem(flag(user))) return null; } catch { /* sin almacenamiento */ }
  let consentedAt: string | null = null;
  try { consentedAt = (await options.api<{ consentedAt: string | null }>('/usage/consent')).consentedAt ?? null; }
  catch { return null; /* sin red: otra vez será */ }
  if (consentedAt) { try { localStorage.setItem(flag(user), consentedAt); } catch { /* */ } return null; }
  await new Promise((r) => setTimeout(r, options.delayMs ?? 1500));
  while (currentSheet()?.isOpen()) await new Promise((r) => setTimeout(r, 1000));
  if (options.userId() !== user) return null;

  const status = el('p', { class: 'fb-status', role: 'status' });
  const ok = el('button', { type: 'button', class: 'primary usage-ok' }, kt('Entendido')) as HTMLButtonElement;
  const sheet = openSheet({
    title: kt('Mejoramos las herramientas con su uso'),
    body: el('div', { class: 'usage-notice' },
      el('p', null, kt(USAGE_NOTICE_TEXT)),
      el('p', { class: 'hint' }, kt('Se cuenta qué botones y pantallas se usan y cuántas veces, por día. Nunca lo que escribes, ni los datos de clientes o huéspedes, ni la hora exacta.')),
      status),
    foot: ok,
    container: options.container?.(),
  });
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      const { consentedAt: at } = await options.api<{ consentedAt: string }>('/usage/consent', { method: 'POST', json: {} });
      try { localStorage.setItem(flag(user), at ?? new Date().toISOString()); } catch { /* */ }
      await sheet.close(true);
    } catch {
      ok.disabled = false;
      status.className = 'fb-status error';
      status.textContent = kt('No se pudo guardar. Prueba otra vez con conexión.');
    }
  });
  return sheet;
}
