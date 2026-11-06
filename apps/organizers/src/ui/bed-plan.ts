/**
 * «Ver en la planta» dentro de Reparto de camas (FB_2026_061; decisión de VG del 05-11, O-C2 b). El mapa de espacios del
 * kit con las habitaciones del retiro y sus camas (forma de Booking, `app/bed-plan.ts`) y, en cada cama, quién duerme. Al
 * tocar una cama se abre la misma hoja que en la lista para asignarla. El mapa se pide al abrir el desplegable; sus URL
 * firmadas duran 10 minutos, así que se vuelve a pedir pasados 9. Sin mapa en Recursos o sin ninguna habitación del retiro
 * en él, no sale nada: la lista de abajo dice lo mismo.
 */
import { createMemorySpaceSource, createSpaceMap, el, replace } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { t } from '../app/i18n.ts';
import { planIndex, planLayer, toFloorPlans, toRows, withBedLayouts, type PlanBed, type PlanRoom, type PortalPlans } from '../app/bed-plan.ts';
import { loading } from './common.ts';
import type { ViewContext } from './shell.ts';

const FRESH_MS = 9 * 60_000;
let memo: { at: number; plans: Promise<PortalPlans> } | null = null;

function plansOf(ctx: Pick<ViewContext, 'api'>): Promise<PortalPlans> {
  if (memo && Date.now() - memo.at < FRESH_MS) return memo.plans;
  const plans = ctx.api.plans();
  memo = { at: Date.now(), plans };
  plans.catch(() => { memo = null; });
  return plans;
}

export interface BedPlanState { open: boolean }

export function renderBedPlan(ctx: Pick<ViewContext, 'api'>, rooms: PlanRoom[], nameOf: (guestId: string) => string,
  onBed: (room: PlanRoom, bed: PlanBed) => void, state: BedPlanState): HTMLElement {
  const host = el('div', { id: 'bedPlan', hidden: true });
  const index = planIndex(rooms);
  if (!index.size) return host;
  const body = el('div', { class: 'orgbedplan-body' });
  const box = el('details', { class: 'orgfold orgbedplan', 'data-feedback-id': 'organizers.alojamiento.planta', 'data-feedback-label': 'Ver en la planta' },
    el('summary', null, t('Ver en la planta')), body) as HTMLDetailsElement;

  async function paint(): Promise<void> {
    replace(body, loading());
    try {
      const raw = await plansOf(ctx);
      if (!raw.spaces.some((s) => index.has(s.id) && s.planId)) {
        replace(body, el('p', { class: 'muted small', id: 'bedPlanNone' }, t('Ikisai aún no ha dibujado estas habitaciones en el plano.')));
        return;
      }
      const data = withBedLayouts(raw, rooms);
      const map = createSpaceMap({
        source: createMemorySpaceSource(toRows(data.spaces)),
        plans: toFloorPlans(data),
        planUrl: (fileId) => data.plans.find((x) => x.fileId === fileId)?.url ?? '',
        mode: 'map',
        bedIcons: true,
        label: t('Planta con camas'),
        feedbackId: 'organizers.alojamiento.planta.mapa',
        filter: (s) => index.has(s.id),
        layer: (s) => {
          const hit = index.get(s.id);
          return hit ? planLayer(hit, nameOf, {
            free: t('Libre'), requested: t('Pendiente de aprobar'), group: t('Reservada para tu grupo'),
            roomFree: (free, total) => t('{free} de {total} camas libres', { free, total }),
          }) : null;
        },
        onPick: (s) => { const hit = index.get(s.id); if (hit?.bed) onBed(hit.room, hit.bed); },
      });
      replace(body, map.element);
    } catch (error) {
      replace(body, el('p', { class: 'muted small' }, describeError(error)),
        el('button', { type: 'button', class: 'ghost small', id: 'bedPlanRetry', onclick: () => void paint() }, t('Reintentar')));
    }
  }

  let shown = false;
  const show = () => { if (box.open && !shown) { shown = true; void paint(); } };
  box.addEventListener('toggle', () => { state.open = box.open; show(); });
  // El reparto se repinta tras cada cambio: si estaba abierto, sigue abierto y con lo nuevo.
  if (state.open) { box.open = true; show(); }
  replace(host, box);
  host.hidden = false;
  return host;
}
