/**
 * Alimentación (API.md §9.5; MUELA-018, tanda 31): «¿Hay algo de comida que debamos saber?» como una pregunta: «No, nada»
 * de un toque, las dietas como botones y «Una alergia o intolerancia» (o una preferencia, u otra cosa) con ¿A qué?, la
 * gravedad y una nota para cocina. Debajo, lo que has indicado (también lo que escribió tu organizador, con su marca) con
 * «Quitar»; el consentimiento para compartir las alergias con el organizador, aparte; y el aviso de Central, sin promesas
 * clínicas. Cada cambio envía la lista entera (`portal_set_restrictions` sustituye todas, también las del organizador).
 */
import { el, fieldAttrs, icon, replace } from '@ikisai/ui-kit';
import type { Restriction } from '../app/api.ts';
import { commonText } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { HAS_SEVERITY, NEEDS_SUBJECT, SEVERITIES, restrictionLabel, severityLabel } from '../app/labels.ts';
import { centralText, fbIgnore, staleNote } from './common.ts';

const DIETS = ['vegetariano', 'vegano', 'sin_gluten', 'sin_lactosa'] as const;
const OTHERS = ['alergia', 'intolerancia', 'preferencia', 'otra'] as const;

export function mountDiet(main: HTMLElement, ctx: GuestContext, base: string): () => void {
  let items: Restriction[] = ctx.guest().restrictions.map((r) => ({ ...r }));
  /** Dietas marcadas en la pregunta (se guardan con «Aceptar»). */
  let picked = new Set<string>(items.filter((r) => (DIETS as readonly string[]).includes(r.restriction_type)).map((r) => r.restriction_type));
  let adding = false;
  let added = false;
  const stateLine = el('p', { class: 'gfield-state', id: 'dietState', role: 'status' });

  function commit(next: Restriction[]): void {
    items = next;
    ctx.writer.enqueue({ kind: 'restrictions', items });
    paint();
  }

  const choice = (key: string, label: string, pressed: boolean, onclick: () => void, attrs: Record<string, string> = {}) => el('button', {
    type: 'button', class: 'ask-choice', 'aria-pressed': String(pressed), onclick, ...attrs,
  }, el('span', { class: 'ask-key', 'aria-hidden': 'true' }, key), label);

  /** La pregunta de la comida. */
  function question(): HTMLElement {
    const g = ctx.guest();
    const keys = 'ABCDEF';
    return el('section', { class: 'gask', 'data-feedback-id': 'guests.alimentacion.pregunta', 'data-feedback-label': 'Pregunta de la comida' },
      el('h3', { class: 'gask-q', id: 'dietQ' }, t('fill.dietQ')),
      el('div', { class: 'ask-choices', role: 'group', 'aria-labelledby': 'dietQ' },
        !items.length && !g.diet_reviewed_at ? choice(keys[0]!, t('fill.dietNone'), false, () => { added = true; commit([]); }, { id: 'dietNone' }) : null,
        ...DIETS.map((d, i) => choice(keys[i + 1]!, restrictionLabel(d), picked.has(d), () => { if (picked.has(d)) picked.delete(d); else picked.add(d); paint(); }, { dataset: { diet: d } } as unknown as Record<string, string>)),
        choice(keys[5]!, t('fill.dietAllergy'), adding, () => { adding = true; paint(); (main.querySelector('#r-subject') as HTMLElement | null)?.focus(); }, { id: 'dietAdd' })),
      el('div', { class: 'gask-btns' },
        el('button', { type: 'button', class: 'primary', id: 'dietOk', 'data-feedback-id': 'guests.alimentacion.lista.guardar_dietas', 'data-feedback-label': 'Aceptar las dietas',
          onclick: () => { added = true; commit([...items.filter((r) => !(DIETS as readonly string[]).includes(r.restriction_type)), ...[...picked].map((d) => ({ restriction_type: d, subject: null, severity: null, kitchen_notes: null }))]); } },
        icon('check', 16), t('fill.ok'))));
  }

  /** «Una alergia o intolerancia» (o una preferencia u otra cosa): a qué, la gravedad y la nota. */
  function addForm(): HTMLElement {
    let type: string = 'alergia';
    let severity: string | null = null;
    const subject = el('input', { id: 'r-subject', type: 'text', maxlength: '120', 'data-feedback-ignore': '', ...fieldAttrs({ id: 'guests.alimentacion.restriccion.que', type: 'text', required: true, sensitivity: 'sensitive' }) }) as HTMLInputElement;
    const notes = el('input', { id: 'r-notes', type: 'text', maxlength: '200', placeholder: t('diet.notes'), 'data-feedback-ignore': '', ...fieldAttrs({ id: 'guests.alimentacion.restriccion.notas', type: 'text', required: false, sensitivity: 'sensitive' }) }) as HTMLInputElement;
    const error = el('p', { class: 'ghint', id: 'r-error', role: 'alert' });
    const types = el('div', { class: 'ask-choices', role: 'group', 'aria-labelledby': 'typeQ' });
    const sev = el('div', { class: 'ask-choices', role: 'group', 'aria-labelledby': 'sevQ' });
    const sevRow = el('div', null, el('p', { class: 'gask-sub', id: 'sevQ' }, t('fill.allergyHow')), sev);
    const paintChoices = () => {
      replace(types, ...OTHERS.map((v, i) => choice('ABCD'[i]!, restrictionLabel(v), type === v, () => { type = v; paintChoices(); }, { dataset: { type: v } } as unknown as Record<string, string>)));
      replace(sev, ...SEVERITIES.map((v, i) => choice('ABC'[i]!, severityLabel(v), severity === v, () => { severity = severity === v ? null : v; paintChoices(); })));
      sevRow.hidden = !HAS_SEVERITY.has(type);
    };
    paintChoices();
    return el('section', { class: 'gask', id: 'dietForm', 'data-feedback-id': 'guests.alimentacion.alergia', 'data-feedback-label': 'Una alergia o intolerancia' },
      el('p', { class: 'gask-sub', id: 'typeQ' }, t('diet.type')), types,
      el('div', { class: 'gfield' }, el('label', { class: 'gask-q', for: 'r-subject' }, t('fill.allergyWhat')), subject),
      sevRow,
      el('div', { class: 'gfield' }, el('label', { for: 'r-notes' }, t('diet.notes')), notes),
      error,
      el('div', { class: 'gask-btns' },
        el('button', { type: 'button', class: 'ghost', 'data-feedback-id': 'guests.alimentacion.alergia.atras', 'data-feedback-label': 'Atrás', onclick: () => { adding = false; paint(); } }, t('fill.prev')),
        el('button', { type: 'button', class: 'primary', id: 'dietAddSave', 'data-feedback-id': 'guests.alimentacion.lista.guardar', 'data-feedback-label': 'Añadir a la lista',
          onclick: () => {
            if ((NEEDS_SUBJECT.has(type) || type === 'preferencia') && !subject.value.trim()) { error.textContent = t('diet.subjectRequired'); subject.focus(); return; }
            adding = false;
            added = true;
            commit([...items, { restriction_type: type, subject: subject.value.trim() || null, severity: HAS_SEVERITY.has(type) ? severity : null, kitchen_notes: notes.value.trim() || null }]);
          } }, icon('check', 16), t('fill.ok'))));
  }

  /** Compartir las alergias con el organizador: aparte, solo si hay alguna. */
  function consent(): HTMLElement | null {
    if (!items.some((r) => HAS_SEVERITY.has(r.restriction_type))) return null;
    const shared = ctx.guest().allergies_visible_to_organizer;
    const set = (value: boolean) => ctx.writer.enqueue({ kind: 'consent', args: { allergies_visible_to_organizer: value } });
    return el('section', { class: 'gask', id: 'consentBox', 'data-feedback-id': 'guests.alimentacion.consentimiento.cambiar', 'data-feedback-label': 'Compartir alergias con el organizador' },
      el('h3', { class: 'gask-q', id: 'shareQ' }, t('fill.shareQ')),
      el('p', { class: 'small' }, t('diet.shareHelp')),
      el('div', { class: 'ask-choices', role: 'group', 'aria-labelledby': 'shareQ' },
        choice('A', t('fill.shareYes'), shared === true, () => { set(true); }, { id: 'shareAllergies' }),
        choice('B', t('fill.shareNo'), shared === false, () => { set(false); }, { id: 'shareNo' })));
  }

  function paint(): void {
    const g = ctx.guest();
    const pending = ['saving', 'offline'].includes(ctx.writer.state()) && ctx.writer.pending() > 0;
    stateLine.textContent = ctx.writer.state() === 'offline' ? t('save.pending') : pending ? t('save.saving') : g.diet_reviewed_at ? t('diet.reviewed') : '';
    const list = el('ul', { class: 'grestrictions', id: 'dietList' }, ...(items.length ? items.map((r, index) => fbIgnore(el('li', { class: 'grestriction' },
      el('span', null,
        el('strong', null, restrictionLabel(r.restriction_type)),
        r.subject ? ` · ${r.subject}` : '',
        r.severity ? ` · ${severityLabel(r.severity)}` : '',
        r.kitchen_notes ? el('span', { class: 'muted small gnote' }, r.kitchen_notes) : null,
        r.source === 'organizer' ? el('span', { class: 'gsource' }, t('data.byOrganizer')) : r.source === 'staff' ? el('span', { class: 'gsource' }, t('data.byStaff')) : null),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': t('diet.remove'), 'data-feedback-id': 'guests.alimentacion.lista.quitar', 'data-feedback-label': 'Quitar',
        onclick: () => { const removed = items[index]!; picked.delete(removed.restriction_type); commit(items.filter((_, i) => i !== index)); } }, icon('trash', 18)))))
      : [el('li', { class: 'muted', id: 'dietEmpty' }, g.diet_reviewed_at ? t('diet.noneSaved') : t('diet.empty'))]));
    const nextHash = g.mode === 'ses' && !g.signed ? `${base}/firma` : base;
    const notice = commonText('guests.allergies_notice');
    replace(main,
      el('a', { class: 'backlink', href: g.mode === 'ninguno' ? base : `${base}/datos`, id: 'back' }, icon('chevronLeft', 16), t('common.back')),
      ctx.staleAt() ? staleNote(ctx.staleAt()!) : null,
      el('div', { class: 'pagehead' }, el('h2', null, t('diet.title')), el('p', { class: 'muted' }, t('diet.intro'))),
      adding ? addForm() : question(),
      el('section', { class: 'card gcard', 'data-feedback-id': 'guests.alimentacion.lista', 'data-feedback-label': 'Lo que has indicado' },
        el('h3', null, t('fill.dietSaid')), list, stateLine),
      consent(),
      notice ? centralText(notice.body, notice.spanishOnly, { id: 'allergiesNotice', class: 'gtext muted small' }) : null,
      added && g.diet_reviewed_at ? el('a', { class: 'primary wide', href: nextHash, id: 'nextTask', 'data-feedback-id': 'guests.alimentacion.siguiente', 'data-feedback-label': 'Lo siguiente' },
        nextHash === base ? t('fill.backRetreat') : t('fill.next', { what: t('home.sign') }), icon('chevronRight', 16)) : null);
  }

  paint();
  const off = ctx.onChange((reason) => {
    if (reason === 'guest' && !ctx.writer.busy()) items = ctx.guest().restrictions.map((r) => ({ ...r }));
    if (!adding) paint();
    else stateLine.textContent = ctx.writer.state() === 'offline' ? t('save.pending') : '';
  });
  return off;
}
