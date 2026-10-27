import { confirmDialog, el, fieldAttrs, replace, toast } from '@ikisai/ui-kit';
import { isOnline } from '../app/actions.ts';
import { loadProjects } from '../app/data.ts';
import { describeError } from '../app/client.ts';
import { busyButton } from './sheets-common.ts';
import type { ViewMount } from './shell.ts';

/**
 * «Revisión de apertura» (pieza `review`, 0955; recorrido «Preparación y revisión de apertura», segundo flujo de VG). Los
 * datos viven en Tasks (docs/tasks/API.md §46.3, §46.4 y §59): Flow solo compone, con las capacidades del catálogo y el
 * token de la persona.
 * 1. Las revisiones del día (`tasks.reviews_day`): las que vencen hoy y las que siguen sin abrir de antes.
 * 2. Sus ítems por zona (`tasks.review_projection`): título, instrucciones, lo esperado, si es crítico y su estado.
 * 3. Marcar cada ítem «Bien» o «Incidencia» con su nota (`tasks.review_item_result`); una cantidad o una lectura llevan su
 *    valor. Un fallo crea en Tasks «Arreglar» y «Volver a comprobar»; solo un nuevo «Bien» lo verifica.
 * Las fotos y abrir la revisión se hacen en Tasks (enlace «Abrir en Tasks»).
 * Si el flujo tiene evento de Booking, arriba van las camas de esta noche (`booking.lodging_readiness`, Booking 1426): lista =
 * activa, colocada en el plano, libre o del evento y sin limpieza en curso en Tasks.
 */

interface Totals { items: number; critical: number; criticalDone: number; done: number; failed: number; pending: number }
interface DayReview { reviewId: string; title: string; eventRef: string | null; due: string | null; status: string; overdue: boolean; ready: boolean; totals: Totals }
interface Item {
  id: string; title: string; answer: 'check' | 'quantity' | 'photo' | 'reading' | 'note'; expected: { unit?: string; min?: number; max?: number; count?: number } | null;
  critical: boolean; instructions: string | null; state: 'pending' | 'ok' | 'failed' | 'verified'; value: number | null; text: string | null;
  corrective: { taskId: string; done: boolean } | null; recheck: { taskId: string; done: boolean } | null;
}
interface RoomReadiness { space_id: string; name: string; beds: number; ready: number; pending_cleaning: number; unplaced: number; inactive: number }
interface Projection { review: { id: string; title: string; status: string; ready: boolean }; zones: Array<{ zone: string; label: string; items: Item[] }>; totals: Totals }

const TASKS_REVIEW = 'https://tasks.ikisai.com/?campo=tasks.revision.abrir';
const STATE_LABEL: Record<Item['state'], string> = { pending: 'Pendiente', ok: 'Bien', failed: 'Incidencia', verified: 'Verificado' };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

export const mountReview: ViewMount = ({ main, client, projectId }) => {
  const host = el('div', { class: 'review', 'data-feedback-id': 'flow.revision', 'data-feedback-label': 'Revisión de apertura' });
  main.append(el('h1', { class: 'col-title' }, 'Revisión de apertura'), host);
  let alive = true;

  async function invoke<T>(capability: string, body: Record<string, unknown>): Promise<T> {
    const out = await client.api<{ result: T }>(`/capabilities/${capability}/invoke`, { method: 'POST', json: body });
    return out.result;
  }
  const failed = (what: string, retry: () => void, error: unknown) => replace(host,
    el('p', { class: 'formerror', role: 'alert' }, `No se han podido cargar ${what}: ${describeError(error)}`),
    el('button', { type: 'button', class: 'ghost', onclick: retry }, 'Reintentar'));

  /** 1. Las revisiones que tocan hoy. */
  async function showDay(): Promise<void> {
    if (!isOnline(client)) { replace(host, el('p', { class: 'muted' }, 'La revisión necesita conexión.')); return; }
    replace(host, el('p', { class: 'muted' }, 'Cargando…'));
    let items: DayReview[];
    try {
      const raw = await invoke<DayReview[] | { items?: DayReview[]; reviews?: DayReview[] }>('tasks.reviews_day', { date: today() });
      items = Array.isArray(raw) ? raw : raw.items ?? raw.reviews ?? [];
    }
    catch (error) { if (alive) failed('las revisiones de hoy', () => void showDay(), error); return; }
    if (!alive) return;
    const beds = await bedsBlock();
    if (!alive) return;
    if (!items.length) { replace(host, beds, el('p', { class: 'muted' }, 'Hoy no hay revisiones pendientes. Se crean en Tasks, desde la plantilla.')); return; }
    replace(host, beds, el('div', { class: 'flows', role: 'list', 'aria-label': 'Revisiones de hoy' }, ...items.map((r) => el('div', { class: 'qcard', role: 'listitem' },
      el('button', { type: 'button', class: 'qcard-main', onclick: () => void showReview(r.reviewId) },
        el('span', { class: 'qcard-text' },
          el('strong', { class: 'qcard-title' }, r.title),
          el('small', { class: 'qcard-sub muted' }, [r.overdue ? 'de días anteriores' : 'hoy', `${r.totals.done} de ${r.totals.items} hechos`,
            r.totals.failed ? `${r.totals.failed} con incidencia` : '', `críticos ${r.totals.criticalDone}/${r.totals.critical}`].filter(Boolean).join(' · '))),
        el('span', { class: `qcard-state${r.ready ? ' is-ready' : ''}` }, r.status === 'opened' ? 'Abierta' : r.ready ? 'Lista para abrir' : 'En curso'))))));
  }

  /** Camas de esta noche del evento del flujo (si lo hay): cuántas están listas y qué falta por habitación. */
  async function bedsBlock(): Promise<HTMLElement | null> {
    const project = projectId ? (await loadProjects(client)).find((x) => x.id === projectId) : null;
    if (!project?.booking_event_id) return null;
    let rooms: RoomReadiness[];
    try {
      const raw = await invoke<RoomReadiness[] | { rooms?: RoomReadiness[]; items?: RoomReadiness[] }>('booking.lodging_readiness', { night: today(), event_id: project.booking_event_id });
      rooms = Array.isArray(raw) ? raw : raw.rooms ?? raw.items ?? [];
    } catch (error) { return el('p', { class: 'formerror', role: 'alert' }, `No se han podido leer las camas de Booking: ${describeError(error)}`); }
    if (!rooms.length) return null;
    const total = rooms.reduce((n, r) => n + r.beds, 0), ready = rooms.reduce((n, r) => n + r.ready, 0);
    const why = (r: RoomReadiness) => [r.pending_cleaning ? `${r.pending_cleaning} por limpiar` : '', r.unplaced ? `${r.unplaced} sin colocar en el plano` : '', r.inactive ? `${r.inactive} inactivas` : ''].filter(Boolean).join(' · ');
    const missing = rooms.filter((r) => r.ready < r.beds);
    return el('section', { class: 'review-beds', 'aria-label': 'Camas de esta noche', 'data-feedback-id': 'flow.revision.camas' },
      el('h2', { class: 'review-title' }, `Camas para esta noche: ${ready} de ${total} listas`),
      missing.length ? el('ul', { class: 'review-items' }, ...missing.map((r) => el('li', { class: 'review-item' },
        el('strong', null, `${r.name}: ${r.ready} de ${r.beds}`), why(r) ? el('p', { class: 'muted small' }, why(r)) : null)))
        : el('p', { class: 'muted small' }, 'Todas las habitaciones están listas.'));
  }

  /** 2. Los ítems de una revisión, por zona. */
  async function showReview(reviewId: string): Promise<void> {
    replace(host, el('p', { class: 'muted' }, 'Cargando…'));
    let p: Projection;
    try { p = await invoke<Projection>('tasks.review_projection', { reviewId }); }
    catch (error) { if (alive) failed('los ítems de la revisión', () => void showReview(reviewId), error); return; }
    if (!alive) return;
    const head = el('div', { class: 'review-head' },
      el('button', { type: 'button', class: 'ghost small', onclick: () => void showDay() }, '‹ Revisiones de hoy'),
      el('h2', { class: 'review-title', tabindex: '-1' }, p.review.title),
      el('p', { class: `review-ready${p.review.ready ? ' is-ready' : ''}`, role: 'status' },
        p.review.status === 'opened' ? 'Abierta.' : p.review.ready ? 'Lista para abrir: todos los críticos están bien.'
          : `Faltan críticos: ${p.totals.criticalDone} de ${p.totals.critical}.`,
        ' ', el('a', { href: TASKS_REVIEW, target: '_blank', rel: 'noopener' }, 'Abrir en Tasks ↗')));
    replace(host, head, ...p.zones.map((z) => el('section', { class: 'review-zone', 'aria-label': z.label },
      el('h3', null, z.label), el('ul', { class: 'review-items' }, ...z.items.map((it) => itemRow(reviewId, it))))));
    (head.querySelector('h2') as HTMLElement).focus();
  }

  /** 3. Un ítem: estado, instrucciones y «Bien» / «Incidencia» (con valor si es cantidad o lectura). */
  function itemRow(reviewId: string, it: Item): HTMLElement {
    const numeric = it.answer === 'quantity' || it.answer === 'reading';
    const expected = it.expected ? (it.expected.count != null ? `esperado: ${it.expected.count}`
      : [it.expected.min != null ? `mín. ${it.expected.min}` : '', it.expected.max != null ? `máx. ${it.expected.max}` : ''].filter(Boolean).join(' · ') + (it.expected.unit ? ` ${it.expected.unit}` : '')) : '';
    const valueInput = numeric ? el('input', { ...fieldAttrs({ id: 'flow.revision.valor', type: 'number' }), type: 'text', inputmode: 'decimal', autocomplete: 'off',
      'aria-label': `Valor de ${it.title}${it.expected?.unit ? ` (${it.expected.unit})` : ''}`, value: it.value == null ? '' : String(it.value), class: 'review-value' }) as HTMLInputElement : null;
    const mark = async (result: 'ok' | 'fail') => {
      let text: string | undefined;
      if (result === 'fail' || it.answer === 'note') {
        const area = el('textarea', { ...fieldAttrs({ id: 'flow.revision.nota', type: 'text' }), rows: '3', maxlength: '500', 'aria-label': 'Nota' }) as HTMLTextAreaElement;
        const ok = await confirmDialog({ title: result === 'fail' ? 'Incidencia' : 'Observación', text: it.title, confirmLabel: result === 'fail' ? 'Guardar incidencia' : 'Guardar', body: el('label', null, 'Nota', area) });
        if (!ok) return;
        text = area.value.trim() || undefined;
        if (result === 'fail' && !text) { toast('Cuenta qué pasa en la nota.'); return; }
      }
      let value: number | undefined;
      if (valueInput) {
        const v = Number(valueInput.value.replace(',', '.'));
        if (valueInput.value.trim() === '' || !Number.isFinite(v)) { toast('Pon el valor medido.'); valueInput.focus(); return; }
        value = it.answer === 'quantity' ? Math.round(v) : v;
      }
      try {
        const out = await invoke<{ state: Item['state'] }>('tasks.review_item_result', { itemId: it.id, result, ...(value != null ? { value } : {}), ...(text ? { text } : {}) });
        toast(out.state === 'failed' ? 'Incidencia guardada: en Tasks quedan «Arreglar» y «Volver a comprobar».' : out.state === 'verified' ? 'Verificado.' : 'Marcado bien.');
      } catch (error) { toast(describeError(error)); return; }
      await showReview(reviewId);
    };
    return el('li', { class: `review-item is-${it.state}${it.critical ? ' is-critical' : ''}`, 'data-feedback-id': `flow.revision.item` },
      el('div', { class: 'review-item-head' },
        el('strong', null, it.title),
        it.critical ? el('span', { class: 'pill is-critical' }, 'Crítico') : null,
        el('span', { class: 'pill' }, STATE_LABEL[it.state])),
      it.instructions ? el('p', { class: 'muted small' }, it.instructions) : null,
      expected ? el('p', { class: 'muted small' }, expected) : null,
      it.state === 'failed' && it.corrective ? el('p', { class: 'small' }, it.corrective.done ? 'Arreglado: falta volver a comprobar.' : 'Pendiente de arreglar en Tasks.') : null,
      it.answer === 'photo' ? el('p', { class: 'muted small' }, 'Lleva foto: márcalo en Tasks.') : el('div', { class: 'flow-actions' },
        valueInput,
        busyButton({ class: 'ghost' }, 'Incidencia', () => mark('fail')),
        busyButton({ class: 'primary' }, it.state === 'failed' ? 'Bien (verificar)' : 'Bien', () => mark('ok'))));
  }

  void showDay().catch((error) => failed('las revisiones de hoy', () => void showDay(), error));
  return () => { alive = false; };
};
