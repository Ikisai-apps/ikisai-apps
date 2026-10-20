/**
 * Preguntas del organizador (API.md §13.6, dueño Organizers), en la «Guía del retiro» (tanda 31, MUELA-037 con
 * «pregunta a pregunta» de 018): `createStepForm` del kit, solo con lo abierto y sin responder, «Pregunta n de N» y su
 * barra; una opción guarda al tocarla y pasa. Las no obligatorias se pueden dejar con «Ahora no» (pasan sin guardar y
 * quedan «Sin responder»). Al acabar, la lista de todas con su respuesta y «Cambiar» (las abiertas) o «Cerrada».
 * Cada respuesta se guarda sola (cola local de `writer.ts`, operación `answer`): sin red, se envía al volver. Aviso fijo:
 * el organizador verá las respuestas. En la vista previa del organizador no se escribe nada.
 */
import { createStepForm, el, icon, replace, type StepQuestion } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import type { Question } from '../app/portal.ts';
import { fbIgnore } from './common.ts';

const SKIP = '__ahora_no';

/** ¿Está contestada? (vacío, lista vacía o null no cuentan). */
export function answered(q: Question): boolean {
  const v = q.answer?.value;
  return !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
}

/** La respuesta en palabras, para la lista final. */
function answerText(q: Question): string {
  if (!answered(q)) return t('questions.notAnswered');
  const v = q.answer!.value;
  if (q.type === 'yes_no') return v === true ? t('questions.yes') : t('questions.no');
  const label = (x: unknown) => q.options.find((o) => o.value === x)?.label ?? String(x);
  return Array.isArray(v) ? v.map(label).join(', ') : label(v);
}

/** Pregunta del organizador → pregunta del kit. */
function toStep(q: Question): StepQuestion {
  const skip = q.required ? [] : [{ value: SKIP, label: t('questions.notNow') }];
  const base = { id: q.id, question: q.required ? `${q.label} · ${t('questions.required')}` : q.label, ...(q.help ? { hint: q.help } : {}) };
  const v = q.answer?.value;
  switch (q.type) {
    case 'yes_no': return { ...base, kind: 'choice', options: [{ value: 'true', label: t('questions.yes') }, { value: 'false', label: t('questions.no') }, ...skip] };
    case 'choice': return { ...base, kind: 'choice', options: [...q.options, ...skip] };
    case 'multi': return { ...base, kind: 'multi', options: q.options, value: Array.isArray(v) ? v.map(String) : [] };
    case 'number': return { ...base, kind: 'text', inputType: 'number', value: v === null || v === undefined ? '' : String(v) };
    case 'date': return { ...base, kind: 'text', inputType: 'date', value: typeof v === 'string' ? v : '' };
    default: return { ...base, kind: 'text', value: typeof v === 'string' ? v : '' };
  }
}

export interface QuestionsBlock { element: HTMLElement; destroy(): void }

/** El bloque de preguntas de la Guía: pieza del kit y, debajo, la lista con lo respondido. */
export function questionsBlock(ctx: GuestContext, items: Question[], onChange: () => void): QuestionsBlock {
  const readOnly = ctx.readOnly();
  const list = el('ul', { class: 'gq-list' });
  const host = el('div', { class: 'gq-form', id: 'questionsForm' });
  const byId = new Map(items.map((q) => [q.id, q]));

  function save(q: Question, value: unknown): void {
    q.answer = { ...(q.answer ?? {}), value };
    ctx.writer.enqueue({ kind: 'answer', questionId: q.id, value });
  }

  const form = readOnly ? null : createStepForm({
    label: t('questions.title'),
    // Solo lo abierto y sin responder; las cerradas solo salen en la lista.
    questions: items.filter((q) => q.open).map(toStep),
    answered: (s) => answered(byId.get(s.id)!),
    onAnswer: (s, value) => {
      const q = byId.get(s.id)!;
      if (value === SKIP) return;
      if (q.type === 'yes_no') save(q, value === 'true');
      else if (q.type === 'number') save(q, value === '' ? null : Number(value));
      else if (q.type === 'multi') save(q, value);
      else save(q, value === '' ? null : value);
      paintList();
      onChange();
    },
    onDone: () => paintList(),
    doneTitle: t('questions.allDone'),
    feedbackId: 'guests.preguntas.pregunta',
  });
  if (form) host.append(form.element);

  function paintList(): void {
    const open = items.filter((q) => q.open);
    const closed = items.filter((q) => !q.open);
    replace(list, ...[...open, ...closed].map((q) => el('li', { dataset: { question: q.id } },
      el('span', { class: 'gq-text' }, el('strong', null, q.label), el('span', { class: 'small' }, answerText(q))),
      q.open && !readOnly
        ? el('button', { type: 'button', class: 'ghost small', 'data-feedback-id': 'guests.preguntas.lista.cambiar', 'data-feedback-label': 'Cambiar una respuesta',
          onclick: () => { form?.goTo(q.id); host.scrollIntoView({ block: 'nearest' }); } }, t('questions.change'), el('span', { class: 'vh' }, ` ${q.label}`))
        : el('span', { class: 'small muted' }, q.open ? '' : t('questions.closedShort')))));
  }
  paintList();

  return {
    element: fbIgnore(el('div', { class: 'gquestions' },
      el('p', { class: 'banner', id: 'questionsNotice' }, icon('info', 18), ' ', t('questions.visible')),
      readOnly ? null : host,
      el('h4', { class: 'gq-head' }, t('questions.yourAnswers')),
      list)),
    // Lo escrito sin pulsar «Aceptar» se guarda al salir (como antes, que se guardaba solo).
    destroy() {
      const input = host.querySelector<HTMLInputElement>('.ask-input');
      const label = host.querySelector('.ask-question')?.textContent ?? '';
      const q = items.find((x) => x.open && (label === x.label || label === `${x.label} · ${t('questions.required')}`));
      const value = input?.value.trim();
      if (q && input && value && value !== String(q.answer?.value ?? '')) save(q, q.type === 'number' ? Number(value) : value);
    },
  };
}
