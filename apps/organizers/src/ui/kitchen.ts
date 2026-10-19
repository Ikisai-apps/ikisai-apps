/** Pestaña Cocina de la ficha del retiro (API.md §9.7): lo de todo el grupo y lo que va con nombre. */
import { el } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import type { KitchenSummary } from '../app/api.ts';
import { restrictionText } from '../app/labels.ts';
import { section } from './common.ts';

export function renderKitchen(k: KitchenSummary): HTMLElement {
  return el('div', { id: 'kitchen', 'data-feedback-id': 'organizers.cocina.resumen', 'data-feedback-label': 'Cocina' },
    section(t('Para todo el grupo'), { id: 'kitchenTotals' },
      k.totals.length
        ? el('ul', { class: 'plainlist' }, ...k.totals.map((t) => el('li', null, el('strong', null, String(t.servings)), ' · ', restrictionText(t))))
        : el('p', { class: 'muted' }, t('Sin requisitos especiales por ahora.'))),
    section(t('Con nombre'), { id: 'kitchenNamed' },
      k.named.length
        ? el('ul', { class: 'plainlist', 'data-feedback-ignore': '' }, ...k.named.map((n) => el('li', null, el('strong', null, n.guest), ' · ', restrictionText(n))))
        : el('p', { class: 'muted' }, t('Aquí verás lo que tú indiques de cada asistente y lo que ellos decidan compartir contigo.'))),
    el('p', { class: 'muted small' }, t('Si alguien tiene una alergia, añádela en su ficha o pídele que la indique en su enlace personal.')));
}
