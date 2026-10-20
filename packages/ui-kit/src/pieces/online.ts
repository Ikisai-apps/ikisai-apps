/**
 * Desactivado con el motivo (MUELA-075, pieza 9): un botón que **necesita red** se apaga sin red y una línea dice por
 * qué, en vez de avisar después de pulsar. **Lo que funciona sin red con la cola de sincronización no se ata nunca**:
 * apagarlo por precaución rompería el modo sin red.
 * - `aria-disabled` (sigue siendo enfocable, así se oye el motivo) y el clic no llega a la app.
 * - El motivo va en una línea `.hint` enlazada con `aria-describedby`; con `retry`, lleva «Reintentar».
 * - Escucha `client.onStatus`; sin cliente, los eventos `online` y `offline` del navegador.
 */
import { el } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';

let uid = 0;

interface StatusSource {
  status(): { network: string };
  onStatus(listener: (status: { network: string }) => void): () => void;
}

export interface OnlineOptions {
  /** El `sync-client` de la app; sin él, `navigator.onLine`. */
  client?: StatusSource | null;
  /** Motivo; por defecto «Necesita conexión.». */
  reason?: string;
  /** «Reintentar» en la línea del motivo (p. ej. `() => client.sync()`). */
  retry?: () => void;
  /** Dónde va la línea del motivo; por defecto justo después del botón. */
  reasonHost?: HTMLElement;
  /**
   * Una línea de motivo ya hecha (`renderOfflineReason`) que comparten varios botones: se enseña si alguno está atado y
   * sin red, y no se crea otra.
   */
  line?: HTMLElement;
}

/** Línea de motivo para compartir entre varios botones (`bindOnline(boton, { line })`). Empieza oculta. */
export function renderOfflineReason(options: { reason?: string; retry?: () => void } = {}): HTMLElement {
  return el('p', { class: 'hint offline-why', id: `kit-offline-why-${++uid}`, hidden: true, role: 'status' },
    el('span', null, options.reason ?? kt('Necesita conexión.')),
    options.retry ? el('button', { type: 'button', class: 'linkbtn offline-retry', onclick: () => options.retry!() }, kt('Reintentar')) : null);
}

/** Ata un botón a la red. Devuelve la función que lo suelta (y deja el botón como estaba). */
export function bindOnline(button: HTMLElement, options: OnlineOptions = {}): () => void {
  const shared = !!options.line;
  const line = options.line ?? renderOfflineReason({ reason: options.reason, retry: options.retry });
  if (!line.id) line.id = `kit-offline-why-${++uid}`;
  const id = line.id;
  // La línea va justo después del botón; si aún no está en la página (se ata antes de montarlo), se coloca al cambiar.
  const place = () => { if (shared) return; if (options.reasonHost) { if (!line.isConnected) options.reasonHost.append(line); } else if (line.previousSibling !== button && button.parentNode) button.after(line); };
  place();
  queueMicrotask(place);
  const describedBefore = button.getAttribute('aria-describedby');
  const block = (e: Event) => { if (button.getAttribute('aria-disabled') === 'true') { e.preventDefault(); e.stopImmediatePropagation(); } };
  button.addEventListener('click', block, true);

  const apply = (online: boolean) => {
    place();
    if (shared) {
      button.dataset.offline = String(!online);
      // Compartida: se ve si algún botón atado a ella está sin red.
      const off = document.querySelector(`[aria-describedby~="${id}"][data-offline="true"]`) || !online;
      line.hidden = !off;
    } else line.hidden = online;
    button.classList.toggle('offline-off', !online);
    if (online) {
      button.removeAttribute('aria-disabled');
      if (describedBefore) button.setAttribute('aria-describedby', describedBefore); else button.removeAttribute('aria-describedby');
    } else {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-describedby', [describedBefore, id].filter(Boolean).join(' '));
    }
  };
  let off: () => void;
  if (options.client) {
    const c = options.client;
    apply(c.status().network !== 'offline');
    off = c.onStatus((s) => apply(s.network !== 'offline'));
  } else {
    const update = () => apply(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    off = () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }
  return () => { off(); apply(true); button.removeEventListener('click', block, true); delete button.dataset.offline; if (!shared) line.remove(); };
}
