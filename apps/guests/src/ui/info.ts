/**
 * Información práctica (API.md §9.7 y §13.4): el lugar de Ikisai (`central.portal_place_projection`: dirección del lugar,
 * enlace del mapa y plano, que puede ser imagen o PDF y se abre con `portal-files`), los textos de Central (`info.*`) en el
 * idioma elegido y el contacto. Es información de Ikisai: sale siempre, no depende de lo que configure el organizador.
 * Se guarda en el dispositivo para leerla sin cobertura.
 */
import { el, icon, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { commonText, contactEmail, contactPhone, INFO_KEYS } from '../app/common-texts.ts';
import { t } from '../app/i18n.ts';
import type { PortalReads } from '../app/portal.ts';
import { backLink, centralText } from './common.ts';

export function mountInfo(main: HTMLElement, base: string, during: boolean, reads?: PortalReads): () => void {
  let alive = true;
  const phone = contactPhone();
  const email = contactEmail();
  const sections = INFO_KEYS.map((key) => ({ key, text: commonText(key) })).filter((s) => s.text);
  const place = el('div', { id: 'infoPlace' });
  const contact = el('section', { class: 'card gcard', id: 'infoContact', 'data-feedback-id': 'guests.info.contacto', 'data-feedback-label': 'Contacto de Ikisai' },
    el('h3', null, t('info.contact')),
    el('div', { class: 'btnrow' },
      phone ? el('a', { class: during ? 'primary' : 'ghost', href: `tel:${phone.replace(/\s+/g, '')}`, id: 'infoCall', 'data-feedback-id': 'guests.info.contacto.llamar', 'data-feedback-label': 'Llamar a Ikisai' }, icon('help', 16), t('home.call', { phone })) : null,
      email ? el('a', { class: 'ghost', href: `mailto:${email}`, id: 'infoMail', 'data-feedback-id': 'guests.info.contacto.escribir', 'data-feedback-label': 'Escribir a Ikisai' }, t('info.write', { email })) : null));
  replace(main,
    backLink(base),
    el('div', { class: 'pagehead' }, el('h2', null, t('info.title')), el('p', { class: 'muted' }, t('info.intro'))),
    place,
    during ? contact : null,
    sections.length
      ? el('div', { id: 'infoSections' }, ...sections.map(({ key, text }, index) => el('details', { class: 'card ggroup', 'data-key': key, open: index === 0 ? '' : null,
        'data-feedback-id': 'guests.info.seccion.abrir', 'data-feedback-label': 'Sección de información' },
        el('summary', null, el('span', null, text!.title ?? t(`info.${key.slice(5)}`))),
        centralText(text!.body, text!.spanishOnly))))
      : el('p', { class: 'card gcard muted', id: 'infoSoon' }, t('info.soon')),
    during ? null : contact);

  // El lugar llega de Central (con caché). El plano se abre con una URL de 5 minutos (C8).
  void reads?.place().then((loaded) => {
    if (!alive || !loaded) return;
    const p = loaded.value;
    const map = p.map_url && /^https:\/\//.test(p.map_url) ? p.map_url : null;
    const openPlan = async () => {
      try {
        const { url } = await reads.fileUrl(p.site_plan_file_id!);
        window.open(url, '_blank', 'noopener');
      } catch (error) {
        toast(describeError(error));
      }
    };
    if (!p.address && !map && !p.site_plan_file_id) return;
    replace(place, el('section', { class: 'card gcard', 'data-feedback-id': 'guests.info.lugar', 'data-feedback-label': 'El lugar' },
      el('h3', null, p.name ?? 'Ikisai'),
      p.address ? el('p', { id: 'infoAddress' }, icon('pin', 16), ' ', p.address) : null,
      el('div', { class: 'btnrow' },
        map ? el('a', { class: 'primary', href: map, target: '_blank', rel: 'noopener', id: 'infoMap', 'data-feedback-id': 'guests.info.mapa.abrir', 'data-feedback-label': 'Ver en el mapa' }, icon('pin', 16), t('info.map')) : null,
        p.site_plan_file_id ? el('button', { type: 'button', class: 'ghost', id: 'infoPlan', 'data-feedback-id': 'guests.info.plano.abrir', 'data-feedback-label': 'Ver el plano',
          onclick: () => void openPlan() }, icon(p.site_plan_mime === 'application/pdf' ? 'download' : 'image', 16), t(p.site_plan_mime === 'application/pdf' ? 'info.planPdf' : 'info.plan')) : null)));
  });
  return () => { alive = false; replace(main); };
}
