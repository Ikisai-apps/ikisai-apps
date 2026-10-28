import { el, replace } from '@ikisai/ui-kit';
import { isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { loadProjects } from '../app/data.ts';
import type { ViewMount } from './shell.ts';

/**
 * Recepción «por puestos» del alojamiento libre (0958; decisión de VG, 28-10), como la barra: un carril por puesto. Las
 * tarjetas salen de la lectura de Booking `booking.reception_board` (el evento del flujo, hoy) y cada una abre la pantalla
 * real de Booking donde se hace. Una solicitud saca trabajo en varios puestos a la vez; no hay tarjeta que viaje. Flow no
 * guarda nada: los datos son de Booking.
 */
export type Puesto = 'solicitud_cobro' | 'camas' | 'registro' | 'peticiones' | 'salida';
interface BoardItem { puesto: Puesto; ref: string; title: string; subtitle?: string | null; status?: 'pendiente' | 'en_curso' | 'hecho' | string; route?: string | null; anchor?: string | null }

const EMPTY: Record<Puesto, string> = {
  solicitud_cobro: 'No hay solicitudes por cobrar.',
  camas: 'No hay camas, comidas ni extras por colocar.',
  registro: 'No falta ningún registro de viajeros.',
  peticiones: 'No hay peticiones de huéspedes.',
  salida: 'Hoy no sale nadie.',
};
const STATUS: Record<string, string> = { pendiente: 'Pendiente', en_curso: 'En curso', hecho: 'Hecho' };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
/** La pantalla real de Booking: con «Volver a Flow», el campo señalado y su ruta (solo `#/…`). */
function bookingUrl(item: BoardItem): string {
  const route = item.route && /^#\/[\w\-/?=&.%]*$/.test(item.route) ? item.route : '#/recepcion';
  const field = item.anchor && /^booking\.[a-z0-9_.-]+$/.test(item.anchor) ? `&campo=${encodeURIComponent(item.anchor)}` : '';
  return `https://booking.ikisai.com/?desde=flow&volver=${encodeURIComponent(location.href)}&titulo=Flow${field}${route}`;
}

export function mountReception(puesto: Puesto): ViewMount {
  return ({ main, client, projectId }) => {
    const host = el('div', { class: 'reception', 'data-feedback-id': `flow.recepcion.${puesto}` });
    main.append(host);
    let alive = true;

    async function paint(): Promise<void> {
      if (!isOnline(client)) { replace(host, el('p', { class: 'muted' }, 'La recepción necesita conexión.')); return; }
      const project = projectId ? (await loadProjects(client)).find((p) => p.id === projectId) : null;
      if (!project?.booking_event_id) { replace(host, el('p', { class: 'muted' }, 'Este flujo no tiene evento de Booking.')); return; }
      let items: BoardItem[];
      try {
        const out = await client.api<{ result: BoardItem[] | { items?: BoardItem[] } }>('/capabilities/booking.reception_board/invoke',
          { method: 'POST', json: { event_id: project.booking_event_id, day: today() } });
        items = Array.isArray(out.result) ? out.result : out.result?.items ?? [];
      } catch (error) {
        if (!alive) return;
        replace(host, el('p', { class: 'formerror', role: 'alert' }, `No se ha podido leer la recepción de Booking: ${describeError(error)}`),
          el('button', { type: 'button', class: 'ghost', onclick: () => void paint() }, 'Reintentar'));
        return;
      }
      if (!alive) return;
      const mine = items.filter((i) => i.puesto === puesto).sort((a, b) => Number(a.status === 'hecho') - Number(b.status === 'hecho'));
      if (!mine.length) { replace(host, el('p', { class: 'muted' }, EMPTY[puesto])); return; }
      replace(host, el('div', { class: 'flows', role: 'list', 'aria-label': 'Trabajo de este puesto' }, ...mine.map((i) => el('div', { class: `qcard reception-card is-${i.status ?? 'pendiente'}`, role: 'listitem' },
        el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }, i.title), i.subtitle ? el('small', { class: 'qcard-sub muted' }, i.subtitle) : null),
        el('span', { class: 'qcard-state' }, STATUS[i.status ?? 'pendiente'] ?? i.status ?? ''),
        el('a', { class: 'button ghost small', href: bookingUrl(i), target: '_blank', rel: 'noopener' }, 'Abrir en Booking ↗')))));
    }

    replace(host, el('p', { class: 'muted' }, 'Cargando…'));
    void paint();
    // Al volver a la pestaña (después de hacerlo en Booking) y cada 30 s, se relee.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void paint(); }, 30_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void paint(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  };
}
