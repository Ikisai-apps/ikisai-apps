/**
 * «Ver en el plano» desplegable (MUELA-025 y 071, pieza común de Guests `verEnPlano`): se abre dentro, sin salir de la
 * pantalla. Hoy no hay planos de zonas (`floor_plans` y `plan_shape` no existen), así que dentro va dónde está, en texto,
 * y el plano del centro que se sube en Central (`site_plan_file_id`): la imagen o, si es un PDF, «Abrir el plano (PDF)».
 * Cuando exista el dibujo de zonas, irá arriba con el sitio resaltado y el fichero quedará como enlace secundario.
 * El plano se pide al abrir el desplegable, una sola vez (URL de 5 minutos de `portal-files`). Sin plano y sin texto, nada;
 * sin plano pero con texto, solo la línea del sitio.
 */
import { el, icon, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { t } from '../app/i18n.ts';
import type { PortalReads } from '../app/portal.ts';

export interface PlanOptions {
  /** Dónde está, en texto («Sala grande»). */
  place: string | null;
  /** Rótulo del desplegable; por defecto, `place`. */
  label?: string | null;
  id?: string;
  reads?: PortalReads | null;
  /** Marca de feedback del desplegable, con id y etiqueta literales en cada pantalla (con `fbMark` de common.ts). */
  mark?: (node: HTMLElement) => void;
}

/** Línea del sitio sin plano: chincheta y texto. */
function placeLine(place: string): HTMLElement {
  return el('span', { class: 'small gplace' }, icon('pin', 14), el('span', null, place));
}

/**
 * El desplegable, o la línea del sitio si no hay plano del centro. El plano del centro se conoce al leer el lugar
 * (con caché), así que la decisión es asíncrona: devuelve un hueco que se rellena.
 */
export function verEnPlano(options: PlanOptions): HTMLElement | null {
  const place = options.place?.trim() || null;
  if (!options.reads) return place ? placeLine(place) : null;
  const reads = options.reads;
  const host = el('span', { class: 'gplan-host', ...(options.id ? { id: `${options.id}Host` } : {}) }, place ? placeLine(place) : null);
  void reads.place().then((loaded) => {
    const p = loaded?.value;
    if (!p?.site_plan_file_id) return;
    const box = el('div', { class: 'gplan-box' });
    const details = el('details', { class: 'gplan', ...(options.id ? { id: options.id } : {}) },
      el('summary', null, icon('pin', 16), el('span', { class: 'gplan-label' }, options.label ?? place ?? p.name ?? t('plan.center')),
        el('span', { class: 'gplan-hint' }, t('plan.see'))),
      box) as HTMLDetailsElement;
    options.mark?.(details);
    let done = false;
    details.addEventListener('toggle', () => {
      if (!details.open || done) return;
      done = true;
      replace(box, el('p', { class: 'small' }, t('plan.loading')));
      const where = el('p', { class: 'small gplan-where' }, icon('pin', 14), ' ', el('strong', null, place ?? p.name ?? t('plan.center')), p.name && place ? ` · ${p.name}` : '');
      if (p.site_plan_mime === 'application/pdf') {
        replace(box, where, el('button', { type: 'button', class: 'ghost small', 'data-feedback-id': 'guests.info.plano.abrir', 'data-feedback-label': 'Abrir el plano (PDF)',
          onclick: async () => {
            try { window.open((await reads.fileUrl(p.site_plan_file_id!)).url, '_blank', 'noopener'); } catch (error) { toast(describeError(error)); }
          } }, icon('download', 16), t('plan.openPdf')));
        return;
      }
      void reads.fileUrl(p.site_plan_file_id!).then(({ url }) => {
        replace(box, where, el('img', { class: 'gplan-img', src: url, alt: t('plan.alt', { name: p.name ?? t('plan.center') }), loading: 'lazy' }));
      }).catch((error) => replace(box, where, el('p', { class: 'small' }, describeError(error))));
    });
    replace(host, details);
  }).catch(() => undefined);
  return host;
}
