/**
 * Información práctica (API.md §9.7): textos de Central (`info.*`) en el idioma elegido y el contacto de Ikisai. Se
 * guardan en el dispositivo para leerlos sin cobertura. Los materiales del organizador llegan en la fase 4.
 */
import { el, icon, replace } from '@ikisai/ui-kit';
import { commonText, contactEmail, contactPhone, INFO_KEYS } from '../app/common-texts.ts';
import { t } from '../app/i18n.ts';
import { backLink, centralText } from './common.ts';

export function mountInfo(main: HTMLElement, base: string, during: boolean, map = false): () => void {
  const phone = contactPhone();
  // Módulo «Mapa» del organizador (API.md §13.4): enlace a la ubicación (texto de Central `info.map_link`).
  const mapLink = map ? commonText('info.map_link')?.body.trim() ?? null : null;
  const email = contactEmail();
  const sections = INFO_KEYS.map((key) => ({ key, text: commonText(key) })).filter((s) => s.text);
  const contact = el('section', { class: 'card gcard', id: 'infoContact', 'data-feedback-id': 'guests.info.contacto', 'data-feedback-label': 'Contacto de Ikisai' },
    el('h3', null, t('info.contact')),
    el('div', { class: 'btnrow' },
      phone ? el('a', { class: during ? 'primary' : 'ghost', href: `tel:${phone.replace(/\s+/g, '')}`, id: 'infoCall', 'data-feedback-id': 'guests.info.contacto.llamar', 'data-feedback-label': 'Llamar a Ikisai' }, icon('help', 16), t('home.call', { phone })) : null,
      email ? el('a', { class: 'ghost', href: `mailto:${email}`, id: 'infoMail', 'data-feedback-id': 'guests.info.contacto.escribir', 'data-feedback-label': 'Escribir a Ikisai' }, t('info.write', { email })) : null));
  replace(main,
    backLink(base),
    el('div', { class: 'pagehead' }, el('h2', null, t('info.title')), el('p', { class: 'muted' }, t('info.intro'))),
    mapLink && /^https:\/\//.test(mapLink) ? el('a', { class: 'primary', href: mapLink, target: '_blank', rel: 'noopener', id: 'infoMap', 'data-feedback-id': 'guests.info.mapa.abrir', 'data-feedback-label': 'Ver en el mapa' }, icon('pin', 16), t('info.map')) : null,
    during ? contact : null,
    sections.length
      ? el('div', { id: 'infoSections' }, ...sections.map(({ key, text }, index) => el('details', { class: 'card ggroup', 'data-key': key, open: index === 0 ? '' : null,
        'data-feedback-id': 'guests.info.seccion.abrir', 'data-feedback-label': 'Sección de información' },
        el('summary', null, el('span', null, text!.title ?? t(`info.${key.slice(5)}`))),
        centralText(text!.body, text!.spanishOnly))))
      : el('p', { class: 'card gcard muted', id: 'infoSoon' }, t('info.soon')),
    during ? null : contact);
  return () => replace(main);
}
