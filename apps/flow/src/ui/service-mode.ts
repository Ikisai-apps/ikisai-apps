import { confirmDialog, el, icon, replace, toast } from '@ikisai/ui-kit';

/**
 * Modo servicio (FLOW-DIR-001 §7): pantalla encendida (Wake Lock) cuando el navegador lo permite, con indicador; se
 * vuelve a pedir al volver a primer plano y se dice si el sistema lo retira. Sonido y vibración opcionales, activados por
 * la persona (un gesto suyo desbloquea el audio), con un solo aviso por llegada de trabajo nuevo, nunca uno por cambio.
 * Siempre hay respaldo visual: los badges y la propia cola. No impide bloquear el equipo a mano.
 */
type WakeLockSentinel = { released: boolean; release(): Promise<void>; addEventListener(type: 'release', fn: () => void): void };
type WakeLockApi = { request(type: 'screen'): Promise<WakeLockSentinel> };

const KEY = 'ikisai-flow-servicio';

export interface ServiceMode {
  /** Botón para la cabecera. */
  button: HTMLButtonElement;
  /** Aviso de trabajo nuevo (lo llama la app cuando sube el número de pendientes). */
  notifyNew(): void;
  destroy(): void;
}

export function createServiceMode(): ServiceMode {
  const wake = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
  let on = false;
  let sound = false;
  let lock: WakeLockSentinel | null = null;
  let audio: AudioContext | null = null;
  let lastAlert = 0;

  try { const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '{}'); sound = !!saved.sound; } catch { /* sin almacenamiento */ }

  const label = el('span', { class: 'service-label' });
  const button = el('button', { type: 'button', class: 'iconbtn service-toggle', 'aria-pressed': 'false', onclick: () => void toggle() }, icon('sun', 20), label) as HTMLButtonElement;

  function paint(): void {
    const awake = !!lock && !lock.released;
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('is-on', on);
    button.title = !on ? 'Modo servicio: pantalla encendida y avisos' : awake ? 'Modo servicio: pantalla encendida' : 'Modo servicio: el sistema no deja mantener la pantalla encendida';
    replace(label, !on ? 'Servicio' : awake ? 'Encendida' : 'Sin bloqueo');
  }

  async function acquire(): Promise<void> {
    if (!on || !wake || document.visibilityState !== 'visible' || (lock && !lock.released)) { paint(); return; }
    try {
      lock = await wake.request('screen');
      lock.addEventListener('release', () => { paint(); });
    } catch { lock = null; }
    paint();
  }

  async function toggle(): Promise<void> {
    on = !on;
    if (on) {
      if (!wake) toast('Este navegador no deja mantener la pantalla encendida: ajusta el apagado automático del equipo.');
      // El sonido solo se activa con un gesto: este clic desbloquea el audio si la persona lo quiere.
      sound = await confirmDialog({ title: 'Modo servicio', text: '¿Avisar también con sonido y vibración cuando lleguen montaditos nuevos? Los avisos en pantalla siguen siempre.', confirmLabel: 'Sí, con sonido', cancelLabel: 'Solo pantalla' });
      try { sessionStorage.setItem(KEY, JSON.stringify({ sound })); } catch { /* sin almacenamiento */ }
      if (sound) { try { audio = new AudioContext(); await audio.resume(); } catch { audio = null; } }
      await acquire();
    } else {
      await lock?.release().catch(() => undefined);
      lock = null;
      paint();
    }
  }

  function notifyNew(): void {
    if (!on || !sound) return;
    const now = Date.now();
    if (now - lastAlert < 4000) return; // un aviso por tanda, no uno por unidad
    lastAlert = now;
    try { navigator.vibrate?.(120); } catch { /* sin vibración */ }
    if (audio) {
      const osc = audio.createOscillator(); const gain = audio.createGain();
      osc.frequency.value = 880; gain.gain.value = 0.08;
      osc.connect(gain).connect(audio.destination);
      osc.start(); osc.stop(audio.currentTime + 0.15);
    }
  }

  const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
  document.addEventListener('visibilitychange', onVisible);
  paint();

  return {
    button,
    notifyNew,
    destroy() { document.removeEventListener('visibilitychange', onVisible); void lock?.release().catch(() => undefined); void audio?.close().catch(() => undefined); },
  };
}
