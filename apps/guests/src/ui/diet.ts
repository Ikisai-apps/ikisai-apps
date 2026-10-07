/**
 * Alimentación (API.md §9.5): lista de lo que ha indicado el huésped (también lo que escribió su organizador, con su
 * marca), «No tengo alergias ni dieta especial», el interruptor para compartir sus alergias con el organizador y el
 * aviso de Central sin promesas clínicas. Cada cambio completo envía la lista entera (`portal_set_restrictions`
 * sustituye todas, también las del organizador).
 */
import { el, icon, openSheet, replace } from '@ikisai/ui-kit';
import type { Restriction } from '../app/api.ts';
import { commonText } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { HAS_SEVERITY, NEEDS_SUBJECT, RESTRICTION_TYPES, SEVERITIES, restrictionLabel, severityLabel } from '../app/labels.ts';
import { backLink, centralText, fbIgnore, staleNote } from './common.ts';

export function mountDiet(main: HTMLElement, ctx: GuestContext, base: string): () => void {
  let items: Restriction[] = ctx.guest().restrictions.map((r) => ({ ...r }));
  const list = el('ul', { class: 'grestrictions', id: 'dietList' });
  const consentBox = el('div', { id: 'consentBox' });
  const stateLine = el('p', { class: 'gfield-state', id: 'dietState', role: 'status' });
  const stale = el('div');

  const hasAllergy = () => items.some((r) => HAS_SEVERITY.has(r.restriction_type));

  function commit(next: Restriction[]): void {
    items = next;
    ctx.writer.enqueue({ kind: 'restrictions', items });
    paint();
  }

  function paint(): void {
    const g = ctx.guest();
    replace(stale, ctx.staleAt() ? staleNote(ctx.staleAt()!) : null);
    replace(list, ...(items.length ? items.map((r, index) => fbIgnore(el('li', { class: 'grestriction' },
      el('span', null,
        el('strong', null, restrictionLabel(r.restriction_type)),
        r.subject ? ` · ${r.subject}` : '',
        r.severity ? ` · ${severityLabel(r.severity)}` : '',
        r.kitchen_notes ? el('span', { class: 'muted small gnote' }, r.kitchen_notes) : null,
        r.source === 'organizer' ? el('span', { class: 'gsource' }, t('data.byOrganizer')) : r.source === 'staff' ? el('span', { class: 'gsource' }, t('data.byStaff')) : null),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': t('diet.remove'), 'data-feedback-id': 'guests.alimentacion.lista.quitar', 'data-feedback-label': 'Quitar',
        onclick: () => commit(items.filter((_, i) => i !== index)) }, icon('trash', 18)))))
      : [el('li', { class: 'muted', id: 'dietEmpty' }, g.diet_reviewed_at ? t('diet.noneSaved') : t('diet.empty'))]));
    const pending = ['saving', 'offline'].includes(ctx.writer.state()) && ctx.writer.pending() > 0;
    stateLine.textContent = ctx.writer.state() === 'offline' ? t('save.pending') : pending ? t('save.saving') : g.diet_reviewed_at ? t('diet.reviewed') : '';
    noneButton.hidden = items.length > 0 || Boolean(g.diet_reviewed_at);
    paintConsent();
  }

  function paintConsent(): void {
    if (!hasAllergy()) { replace(consentBox); return; }
    const checked = ctx.guest().allergies_visible_to_organizer;
    const input = el('input', { type: 'checkbox', id: 'shareAllergies', checked: checked ? '' : null,
      'data-feedback-id': 'guests.alimentacion.consentimiento.cambiar', 'data-feedback-label': 'Compartir alergias con el organizador',
      onchange: () => ctx.writer.enqueue({ kind: 'consent', args: { allergies_visible_to_organizer: input.checked } }) }) as HTMLInputElement;
    replace(consentBox, el('section', { class: 'card gcard' },
      el('label', { class: 'gswitch' }, input, el('span', null, t('diet.share'))),
      el('p', { class: 'muted small' }, t('diet.shareHelp'))));
  }

  function openAdd(): void {
    const type = el('select', { id: 'r-type' }, ...RESTRICTION_TYPES.map((v) => el('option', { value: v }, restrictionLabel(v)))) as HTMLSelectElement;
    const subject = el('input', { id: 'r-subject', type: 'text', maxlength: '120', 'data-feedback-ignore': '' }) as HTMLInputElement;
    const severity = el('select', { id: 'r-severity' }, el('option', { value: '' }, t('data.choose')), ...SEVERITIES.map((v) => el('option', { value: v }, severityLabel(v)))) as HTMLSelectElement;
    const notes = el('textarea', { id: 'r-notes', maxlength: '200', rows: '2', 'data-feedback-ignore': '' }) as HTMLTextAreaElement;
    const error = el('p', { class: 'ghint', id: 'r-error', role: 'alert' });
    const subjectRow = el('div', { class: 'gfield' }, el('label', { for: 'r-subject' }, t('diet.subject')), subject);
    const severityRow = el('div', { class: 'gfield' }, el('label', { for: 'r-severity' }, t('diet.severity')), severity);
    const sync = () => { subjectRow.hidden = !NEEDS_SUBJECT.has(type.value) && type.value !== 'preferencia'; severityRow.hidden = !HAS_SEVERITY.has(type.value); };
    type.addEventListener('change', sync);
    sync();
    const sheet = openSheet({
      title: t('diet.addTitle'),
      body: el('form', { class: 'gform', id: 'dietForm', onsubmit: (event: Event) => {
        event.preventDefault();
        if (NEEDS_SUBJECT.has(type.value) && !subject.value.trim()) { error.textContent = t('diet.subjectRequired'); subject.focus(); return; }
        commit([...items, {
          restriction_type: type.value, subject: subject.value.trim() || null,
          severity: HAS_SEVERITY.has(type.value) ? severity.value || null : null, kitchen_notes: notes.value.trim() || null,
        }]);
        sheet.close();
      } },
      el('div', { class: 'gfield' }, el('label', { for: 'r-type' }, t('diet.type')), type),
      subjectRow, severityRow,
      el('div', { class: 'gfield' }, el('label', { for: 'r-notes' }, t('diet.notes')), notes),
      error,
      el('button', { type: 'submit', class: 'primary wide', id: 'dietAddSave', 'data-feedback-id': 'guests.alimentacion.lista.guardar', 'data-feedback-label': 'Añadir a la lista' }, t('diet.addSave'))),
    });
  }

  const noneButton = el('button', { type: 'button', class: 'ghost wide', id: 'dietNone', 'data-feedback-id': 'guests.alimentacion.lista.ninguna', 'data-feedback-label': 'No tengo alergias ni dieta especial',
    onclick: () => commit([]) }, icon('check', 16), t('diet.none'));
  const notice = commonText('guests.allergies_notice');

  replace(main,
    backLink(base),
    stale,
    el('div', { class: 'pagehead' }, el('h2', null, t('diet.title')), el('p', { class: 'muted' }, t('diet.intro'))),
    el('section', { class: 'card gcard', 'data-feedback-id': 'guests.alimentacion.lista', 'data-feedback-label': 'Lo que has indicado' },
      list,
      el('div', { class: 'btnrow' },
        el('button', { type: 'button', class: 'primary', id: 'dietAdd', 'data-feedback-id': 'guests.alimentacion.lista.anadir', 'data-feedback-label': 'Añadir', onclick: openAdd }, icon('plus', 16), t('diet.add')),
        noneButton),
      stateLine),
    consentBox,
    notice ? centralText(notice.body, notice.spanishOnly, { id: 'allergiesNotice', class: 'gtext muted small' }) : null,
  );
  paint();

  const off = ctx.onChange((reason) => {
    if (reason === 'guest' && !ctx.writer.busy()) items = ctx.guest().restrictions.map((r) => ({ ...r }));
    paint();
  });
  return off;
}
