import { el, icon, type Child } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { t } from '../app/i18n.ts';
import { timeLabel } from '../app/labels.ts';

/** Zona con datos personales: el gesto de feedback no se dispara aquí y su contenido nunca viaja en un reporte. */
export function fbIgnore<T extends Element>(node: T): T {
  node.setAttribute('data-feedback-ignore', '');
  return node;
}

/** Aviso de datos guardados en el dispositivo cuando no hay red. */
export function staleNote(at: string): HTMLElement {
  return el('p', { class: 'banner warn', role: 'status', id: 'staleNote' }, icon('offline', 18), ' ', t('common.stale', { time: timeLabel(at) }));
}

export function loading(): HTMLElement {
  return el('p', { class: 'muted', role: 'status' }, t('common.loading'));
}

export function failure(error: unknown, retry?: () => void): HTMLElement {
  return el('div', { class: 'empty plain', role: 'alert', id: 'loadError' },
    el('strong', null, t('common.loadFailed')),
    el('p', null, describeError(error)),
    retry ? el('button', { type: 'button', class: 'ghost', onclick: retry }, t('common.retry')) : null);
}

export function backLink(hash: string): HTMLElement {
  return el('a', { class: 'backlink', href: hash, id: 'back' }, icon('chevronLeft', 16), t('common.back'));
}

export function card(attrs: Record<string, string>, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card gcard', ...attrs }, ...children);
}

/** Una línea de Central con sus negritas (`**texto**`), sin HTML. */
function inline(line: string): Array<string | HTMLElement> {
  return line.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => (part.startsWith('**') && part.endsWith('**') ? el('strong', null, part.slice(2, -2)) : part));
}

/** Texto de Central (un párrafo por línea, negritas con `**`) con su nota si solo existe en español. */
export function centralText(body: string, spanishOnly: boolean, attrs: Record<string, string> = {}): HTMLElement {
  return el('div', { class: 'gtext', ...attrs },
    spanishOnly ? el('p', { class: 'muted small gspanish' }, t('common.spanishOnly')) : null,
    ...body.split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p) => el('p', null, ...inline(p))));
}
