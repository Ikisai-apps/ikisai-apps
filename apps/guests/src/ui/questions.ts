/**
 * Preguntas del organizador (API.md §13.6, dueño Organizers): cada respuesta se guarda sola (cola local de `writer.ts`,
 * operación `answer`), sin botón «Guardar». Fuera de la ventana de respuesta se ven y no se cambian. Aviso fijo: el
 * organizador verá las respuestas.
 */
import { el, icon, replace } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import type { Question } from '../app/portal.ts';
import { failure, fbIgnore, loading, staleNote } from './common.ts';

const DEBOUNCE = 800;

/** ¿Está contestada? (vacío, lista vacía o null no cuentan). */
export function answered(q: Question): boolean {
  const v = q.answer?.value;
  return !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
}

export function mountQuestions(main: HTMLElement, ctx: GuestContext): () => void {
  let alive = true;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  replace(main, loading());

  function save(q: Question, value: unknown): void {
    q.answer = { ...(q.answer ?? {}), value };
    ctx.writer.enqueue({ kind: 'answer', questionId: q.id, value });
  }
  function later(q: Question, read: () => unknown): void {
    clearTimeout(timers.get(q.id));
    timers.set(q.id, setTimeout(() => { timers.delete(q.id); save(q, read()); }, DEBOUNCE));
  }

  function control(q: Question): HTMLElement {
    const id = `q-${q.id}`;
    const disabled = !q.open || ctx.readOnly() ? '' : null;
    const value = q.answer?.value;
    const choiceList = (multi: boolean, options: Array<{ value: string; label: string }>) => el('div', { class: 'gchoices', role: multi ? 'group' : 'radiogroup', id },
      ...options.map((o) => {
        const input = el('input', { type: multi ? 'checkbox' : 'radio', name: id, value: o.value, disabled,
          checked: (multi ? Array.isArray(value) && value.includes(o.value) : value === o.value) ? '' : null,
          onchange: () => {
            if (!multi) { save(q, o.value === 'true' ? true : o.value === 'false' ? false : o.value); return; }
            save(q, [...main.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(id)}"]:checked`)].map((x) => x.value));
          } }) as HTMLInputElement;
        return el('label', { class: 'gswitch' }, input, el('span', null, o.label));
      }));
    switch (q.type) {
      case 'choice': return choiceList(false, q.options);
      case 'multi': return choiceList(true, q.options);
      case 'yes_no': return choiceList(false, [{ value: 'true', label: t('questions.yes') }, { value: 'false', label: t('questions.no') }]);
      case 'number':
      case 'date': {
        const input = el('input', { id, type: q.type, disabled, value: value === null || value === undefined ? '' : String(value),
          onchange: () => save(q, input.value === '' ? null : q.type === 'number' ? Number(input.value) : input.value) }) as HTMLInputElement;
        return input;
      }
      default: {
        const area = el('textarea', { id, rows: '3', maxlength: '2000', disabled, oninput: () => later(q, () => area.value.trim() || null),
          onblur: () => { if (timers.has(q.id)) { clearTimeout(timers.get(q.id)); timers.delete(q.id); save(q, area.value.trim() || null); } } }, typeof value === 'string' ? value : '') as HTMLTextAreaElement;
        return area;
      }
    }
  }

  void ctx.reads.questions(ctx.grant.reservation_id, ctx.grant.guest_id).then((loaded) => {
    if (!alive) return;
    const items = loaded?.value.items ?? [];
    replace(main,
      loaded?.stale ? staleNote(loaded.at) : null,
      el('div', { class: 'pagehead' }, el('h2', null, t('questions.title')), el('p', { class: 'muted' }, t('questions.intro'))),
      el('p', { class: 'banner', id: 'questionsNotice' }, icon('info', 18), ' ', t('questions.visible')),
      items.length
        ? fbIgnore(el('form', { class: 'gform', id: 'questionsForm', onsubmit: (e: Event) => e.preventDefault() },
          ...items.map((q) => el('section', { class: 'card gcard gquestion', dataset: { question: q.id } },
            el('label', { for: `q-${q.id}`, class: 'gquestion-label' }, q.label, q.required ? el('span', { class: 'ghint' }, ` · ${t('questions.required')}`) : null),
            q.help ? el('p', { class: 'muted small' }, q.help) : null,
            control(q),
            !q.open ? el('p', { class: 'muted small' }, t('questions.closed')) : null))))
        : el('p', { class: 'card gcard muted', id: 'questionsEmpty' }, t('questions.empty')),
      items.length ? el('p', { class: 'muted small gautosave' }, icon('check', 14), ' ', t('data.autosave')) : null);
  }).catch((error) => { if (alive) replace(main, failure(error)); });

  return () => {
    alive = false;
    for (const [id, timer] of timers) { clearTimeout(timer); const area = main.querySelector<HTMLTextAreaElement>(`#q-${CSS.escape(id)}`); if (area) ctx.writer.enqueue({ kind: 'answer', questionId: id, value: area.value.trim() || null }); }
  };
}
