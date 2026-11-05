/**
 * El plano de Ikisai en Experiencia › Alojamiento (FB_2026_061; decisión de VG del 05-11, O-C2 a). Es el plano del centro de
 * Central (`site_plan_file_id` de `central.portal_place_projection`, servido al portal con C8), el mismo que ven los
 * asistentes en Guests. Va en un desplegable: al abrirlo, la imagen o, si es un PDF, «Abrir el plano (PDF)». Sin plano, no
 * sale nada. La planta con las camas de Booking es la O-C2 b.
 */
import { el, replace } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { t } from '../app/i18n.ts';
import { loading } from './common.ts';
import type { ViewContext } from './shell.ts';

interface Place { site_plan_file_id?: string | null }

export function renderCenterPlan(ctx: Pick<ViewContext, 'api'>): HTMLElement {
  const host = el('div', { id: 'centerPlan', hidden: true });
  void ctx.api.readAny<{ rows?: Place[]; items?: Place[] }>('central.portal_place_projection').then((out) => {
    const fileId = (out.value.rows ?? out.value.items ?? [])[0]?.site_plan_file_id;
    if (!fileId) return;
    const body = el('div', { class: 'orgplan-body' });
    const box = el('details', { class: 'orgfold orgplan', 'data-feedback-id': 'organizers.alojamiento.plano', 'data-feedback-label': 'Plano de Ikisai' },
      el('summary', null, t('Plano de Ikisai')), body) as HTMLDetailsElement;
    let asked = false;
    box.addEventListener('toggle', () => {
      if (!box.open || asked) return;
      asked = true;
      replace(body, loading());
      // URL firmada de 5 minutos: se pide al abrir, no al pintar.
      ctx.api.portalFile(fileId).then((file) => replace(body, file.mime === 'application/pdf'
        ? el('a', { class: 'btn', id: 'centerPlanPdf', href: file.url, target: '_blank', rel: 'noopener noreferrer' }, t('Abrir el plano (PDF)'))
        : el('img', { id: 'centerPlanImg', class: 'orgplan-img', src: file.url, alt: t('Plano de Ikisai'), loading: 'lazy' })))
        .catch((error) => { asked = false; replace(body, el('p', { class: 'muted small' }, describeError(error))); });
    });
    replace(host, box);
    host.hidden = false;
  }).catch(() => undefined);
  return host;
}
