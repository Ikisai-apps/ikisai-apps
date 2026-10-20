/**
 * Tus datos (API.md §9.4; MUELA-018, tanda 31): «siempre una cosa cada vez, pero si sales, la lista y la revisión».
 * - **Pregunta a pregunta** (`createStepForm` del kit) la primera vez: solo lo que falta (lo que puso el organizador o
 *   Ikisai se salta), en el orden del registro, con «Pregunta n de N» y su barra. Las opciones guardan al tocarlas; el
 *   texto, con «Aceptar» o Intro. Lo que no pasa la validación se queda en la pregunta con su motivo. Al acabar, sigue la
 *   comida y, en modo `ses`, «Comprueba tus respuestas» y la firma.
 * - **«Antes de venir»** si se sale a mitad o se vuelve más tarde: las tareas con su estado en palabras y un botón por cada
 *   dato que falta, que abre esa pregunta.
 * - **«Ver todos mis datos»** (PERDIDAS §1, en todos los modos): todos los datos con «Cambiar» y la marca «Lo indicó tu
 *   organizador» o «Lo indicó Ikisai»; «Cambiar» abre esa pregunta y vuelve.
 * Cada respuesta se guarda sola (cola de `writer.ts`, también sin red). Se conservan «¿Por qué te lo pedimos?» (Central),
 * el aviso de que cambiar un dato anula la firma, «Otro país» (por su nombre o su código de tres letras) y los campos de
 * menor o de adulto.
 */
import { createStepForm, el, icon, openSheet, replace, StepFormInvalid, type StepQuestion } from '@ikisai/ui-kit';
import { guestMissing } from '@ikisai/domain-booking';
import type { MyGuest } from '../app/api.ts';
import { commonText } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { formatDate, t } from '../app/i18n.ts';
import { countryName, countryOptions, fieldLabel, fieldsFor, isKnownCountry, missingText, type FieldSpec } from '../app/labels.ts';
import { centralText, fbIgnore, staleNote } from './common.ts';

/** Valor normalizado y error de validación (o null) de lo que ha escrito el huésped. */
export function normalize(key: string, raw: unknown): { value: unknown; error: string | null } {
  if (typeof raw === 'boolean') return { value: raw, error: null };
  let value = typeof raw === 'string' ? raw.trim() : raw;
  if (value === '') return { value: null, error: null };
  if (key === 'document_number' || key === 'document_support_number') value = String(value).replace(/\s+/g, '').toUpperCase();
  if (key === 'nationality' || key === 'residence_country') {
    value = String(value).toUpperCase();
    if (!/^[A-Z]{3}$/.test(value as string)) return { value, error: t('data.errCountry') };
  }
  if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) return { value, error: t('data.errEmail') };
  if (key === 'phone' && String(value).replace(/[^\d]/g, '').length < 6) return { value, error: t('data.errPhone') };
  if (key === 'birth_date') {
    const date = String(value);
    const today = new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || date > today || date < '1900-01-01') return { value, error: t('data.errDate') };
  }
  if (typeof value === 'string' && value.length > 200) return { value, error: t('data.errLong') };
  return { value, error: null };
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** País escrito por su nombre («España», «spain») o su código («ESP») → código de tres letras. */
function countryCode(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  if (/^[a-z]{3}$/i.test(raw)) return raw.toUpperCase();
  const hit = countryOptions().find(([, name]) => fold(name) === fold(raw));
  return hit?.[0] ?? null;
}

/** El valor de un dato, en palabras. */
export function shownValue(spec: FieldSpec, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (spec.type === 'toggle') return value === true ? t('questions.yes') : t('questions.no');
  if (spec.type === 'country') return countryName(String(value));
  if (spec.type === 'date') return formatDate(String(value));
  if (spec.type === 'select') return spec.options?.().find(([v]) => v === value)?.[1] ?? String(value);
  return String(value);
}

/** «Cambiar» desde la revisión de la firma: abre esa pregunta en Tus datos y vuelve a donde estaba. */
let requested: { key: string; back: string } | null = null;
export function requestChange(key: string, back: string): void { requested = { key, back }; }

type View = 'list' | 'ask' | 'all' | 'change';

/** ¿Ha empezado? Firmó, revisó la comida o puso él algún dato. */
function started(g: MyGuest): boolean {
  return g.signed || Boolean(g.diet_reviewed_at) || Object.entries(g.sources).some(([k, by]) => by === 'guest' && g.fields[k] !== null && g.fields[k] !== '' && g.fields[k] !== undefined);
}

export interface DataOptions {
  /** Lo siguiente al acabar: la comida, la firma o el Resumen. */
  navigate(hash: string): void;
}

export function mountData(main: HTMLElement, ctx: GuestContext, base: string, options?: DataOptions): () => void {
  const go = (hash: string) => (options ? options.navigate(hash) : void (location.hash = hash));
  /** Lo contestado en esta visita (el servidor lo confirma después). */
  const local = new Map<string, unknown>();
  const fields = () => ({ ...ctx.guest().fields, ...Object.fromEntries(local) });
  const minor = () => fields().is_minor === true;
  const specs = () => fieldsFor(ctx.guest().mode).filter((s) => !(s.minorOnly && !minor()) && !(s.adultOnly && minor()));
  /** Lo que se ha dejado en blanco en esta visita: no se vuelve a preguntar seguido (sí sale en la lista). */
  const skipped = new Set<string>();
  /** Valor del servidor al enseñar cada pregunta (base del conflicto, `writer.ts`). */
  const bases = new Map<string, unknown>();
  /** Todo lo que falta, con lo contestado aquí. `contact` sale como teléfono y correo. */
  const allMissing = (): string[] => {
    const g = ctx.guest();
    const missing = guestMissing(fields() as Parameters<typeof guestMissing>[0], g.mode);
    return specs().map((s) => s.key).filter((k) => missing.includes(k) || ((k === 'phone' || k === 'email') && missing.includes('contact')));
  };
  /** Lo que se pregunta ahora: sin lo dejado en blanco; del contacto, el teléfono (o el correo si el teléfono quedó en blanco). */
  const missingKeys = (): string[] => {
    const contact = skipped.has('phone') ? 'email' : 'phone';
    return allMissing().filter((k) => !skipped.has(k) && !((k === 'phone' || k === 'email') && k !== contact && !(fields().phone || fields().email) ));
  };
  let view: View = requested ? 'change' : started(ctx.guest()) || !missingKeys().length ? 'list' : 'ask';
  let changeKey: string | null = requested?.key ?? null;
  let backTo: string | null = requested?.back ?? null;
  requested = null;

  function question(spec: FieldSpec): StepQuestion {
    const g = ctx.guest();
    const value = fields()[spec.key];
    if (!bases.has(spec.key)) bases.set(spec.key, ctx.guest().fields[spec.key] ?? null);
    const hint = g.mode === 'ses' && (spec.key === 'phone' || spec.key === 'email') ? t('data.contactHint') : g.mode === 'ses' && missingKeys().includes(spec.key) ? t('data.required')
      : spec.type === 'country' ? t('data.countryHint') : undefined;
    const by = g.sources[spec.key];
    const source = value !== null && value !== undefined && value !== '' && by === 'organizer' ? t('data.byOrganizer') : by === 'staff' && value ? t('data.byStaff') : '';
    const base = { id: spec.key, question: fieldLabel(spec.key), ...(hint || source ? { hint: [source, hint].filter(Boolean).join(' · ') } : {}) };
    if (spec.type === 'select') return { ...base, kind: 'choice', options: (spec.options?.() ?? []).map(([v, label]) => ({ value: v, label })), value: typeof value === 'string' ? value : null };
    if (spec.type === 'toggle') return { ...base, kind: 'choice', options: [{ value: 'true', label: t('questions.yes') }, { value: 'false', label: t('questions.no') }], value: value === true ? 'true' : value === false ? 'false' : null };
    if (spec.type === 'country') return { ...base, kind: 'text', value: typeof value === 'string' && isKnownCountry(value) ? countryName(value) : typeof value === 'string' ? value : '' };
    return { ...base, kind: 'text', inputType: spec.type === 'date' ? 'date' : spec.type === 'email' ? 'email' : spec.type === 'tel' ? 'tel' : 'text', value: typeof value === 'string' ? value : '' };
  }

  /** Guarda una respuesta (o lanza `StepFormInvalid` con el motivo). */
  function save(key: string, raw: string | string[]): void {
    const spec = specs().find((s) => s.key === key) ?? fieldsFor(ctx.guest().mode).find((s) => s.key === key)!;
    let input: unknown = Array.isArray(raw) ? raw.join(',') : raw;
    if (spec.type === 'toggle') input = raw === 'true';
    if (spec.type === 'country' && typeof input === 'string' && input.trim()) {
      const code = countryCode(input);
      if (!code) throw new StepFormInvalid(t('data.errCountryName'));
      input = code;
    }
    const { value, error } = normalize(key, input);
    if (error) throw new StepFormInvalid(error);
    const current = ctx.guest().fields[key] ?? null;
    const base = bases.has(key) ? bases.get(key) : current;
    bases.delete(key);
    local.set(key, value);
    if (value === null || value === undefined) skipped.add(key); else skipped.delete(key);
    if ((current ?? null) !== (value ?? null)) ctx.writer.enqueue({ kind: 'fields', fields: { [key]: value }, base: { [key]: base } });
  }

  const back = (onclick: () => void) => el('button', { type: 'button', class: 'backlink', id: 'back', 'data-feedback-id': 'guests.datos.volver', 'data-feedback-label': 'Volver', onclick }, icon('chevronLeft', 16), t('common.back'));
  const banners = () => {
    const g = ctx.guest();
    return [
      ctx.staleAt() ? staleNote(ctx.staleAt()!) : null,
      ctx.signatureReset() && !g.signed && g.mode === 'ses' ? el('p', { class: 'banner warn', id: 'signatureReset', role: 'status' }, icon('warn', 18), ' ', t('data.signatureReset'), ' ',
        el('a', { href: `${base}/firma`, 'data-feedback-id': 'guests.datos.firma.abrir', 'data-feedback-label': 'Volver a firmar' }, t('sign.title'))) : null,
    ];
  };

  /** Después de la última pregunta: la comida, la firma o la lista. */
  function next(): void {
    const g = ctx.guest();
    if (missingKeys().length) { paint('ask'); return; }
    if (!g.diet_reviewed_at) { go(`${base}/alimentacion`); return; }
    if (g.mode === 'ses' && !g.signed) { go(`${base}/firma`); return; }
    paint('list');
  }

  function askView(keys: string[], done: () => void, title: string): HTMLElement {
    // En el orden pedido: desde la lista, el dato tocado va primero.
    const all = keys.map((k) => specs().find((s) => s.key === k)).filter((s): s is FieldSpec => Boolean(s));
    const form = createStepForm({
      label: title, questions: all.map(question), answered: () => false,
      onAnswer: (q, value) => save(q.id, value), onDone: done, feedbackId: 'guests.datos.pregunta',
    });
    return fbIgnore(form.element);
  }

  function paint(next?: View): void {
    if (next) view = next;
    const g = ctx.guest();
    const missing = view === 'ask' ? missingKeys() : allMissing();
    if (view === 'ask') {
      if (!missing.length) { view = 'list'; paint(); return; }
      replace(main, back(() => paint('list')), ...banners(),
        el('div', { class: 'pagehead' }, el('h2', null, t('home.data'))),
        el('p', { class: 'gleft', id: 'fillLeft' }, icon('info', 16), ' ', t('fill.leftList', { list: missingText(guestMissing(fields() as Parameters<typeof guestMissing>[0], g.mode)) })),
        askView(missing, () => nextStep(), t('home.data')));
      return;
    }
    if (view === 'change' && changeKey) {
      const spec = fieldsFor(g.mode).find((s) => s.key === changeKey);
      const done = () => { const to = backTo; backTo = null; changeKey = null; if (to) go(to); else paint('all'); };
      if (!spec) { done(); return; }
      replace(main, back(done), ...banners(),
        el('div', { class: 'pagehead' }, el('h2', null, t('fill.changeTitle'))),
        fbIgnore(createStepForm({ label: fieldLabel(spec.key), questions: [question(spec)], answered: () => false, onAnswer: (q, value) => save(q.id, value), onDone: done,
          doneTitle: t('save.saved'), feedbackId: 'guests.datos.pregunta' }).element));
      return;
    }
    if (view === 'all') {
      replace(main, back(() => paint('list')), ...banners(),
        el('div', { class: 'pagehead' }, el('h2', null, t('fill.allData')), el('p', { class: 'muted' }, t('fill.allDataIntro'))),
        reviewList(ctx, (key) => { changeKey = key; backTo = null; paint('change'); }, specs(), fields()),
        el('p', { class: 'muted small gautosave' }, icon('check', 14), ' ', t('data.autosave')));
      return;
    }
    // «Antes de venir»: las tareas, un botón por dato que falta y «Ver todos mis datos».
    const why = commonText('guests.data_why');
    const tasks = fillTasks(g, missing.length);
    const done = tasks.filter((x) => x.state === 'done').length;
    replace(main,
      el('a', { class: 'backlink', href: base, id: 'back' }, icon('chevronLeft', 16), t('common.back')),
      ...banners(),
      el('div', { class: 'pagehead' }, el('h2', null, t('fill.listTitle')), el('p', { class: 'muted' }, g.mode === 'ses' ? t('data.introSes') : t('data.introOperative'))),
      g.mode === 'ses' && why ? el('button', { type: 'button', class: 'linklike', id: 'whyData', 'data-feedback-id': 'guests.datos.motivo.abrir', 'data-feedback-label': '¿Por qué te lo pedimos?',
        onclick: () => openSheet({ title: why.title ?? t('data.why'), body: centralText(why.body, why.spanishOnly, { id: 'whyText' }) }) }, icon('info', 16), t('data.why')) : null,
      el('p', { class: 'gcount' }, el('strong', null, t('fill.sections', { done, total: tasks.length }))),
      el('ol', { class: 'gfilltasks', id: 'taskList' }, ...tasks.map((task, i) => el('li', null,
        el('button', { type: 'button', class: `gfilltask${task.state === 'done' ? ' done' : ''}`, id: `fill-${task.id}`, disabled: task.state === 'locked' ? '' : null,
          'data-feedback-id': 'guests.datos.tarea.abrir', 'data-feedback-label': 'Abrir una tarea',
          onclick: () => (task.id === 'data' ? paint(missing.length ? 'ask' : 'all') : go(`${base}/${task.id === 'diet' ? 'alimentacion' : 'firma'}`)) },
        el('span', { class: 'gfilltask-num', 'aria-hidden': 'true' }, task.state === 'done' ? '✓' : String(i + 1)),
        el('span', { class: 'gfilltask-text' }, el('strong', null, task.title), task.state !== 'done' && task.sub ? el('span', { class: 'small' }, task.sub) : null),
        el('span', { class: `gtag ${task.state}` }, t(`fill.st.${task.state}`))),
        task.id === 'data' && missing.length ? el('div', { class: 'gfieldlinks', id: 'missingLinks' }, ...missing.map((key) => el('button', {
          type: 'button', class: 'gfieldlink', dataset: { key }, 'data-feedback-id': 'guests.datos.dato.abrir', 'data-feedback-label': 'Completar un dato',
          onclick: () => { view = 'ask'; replace(main, back(() => paint('list')), ...banners(), el('div', { class: 'pagehead' }, el('h2', null, t('home.data'))),
            askView([key, ...missing.filter((k) => k !== key)], () => nextStep(), t('home.data'))); },
        }, fieldLabel(key), icon('chevronRight', 14)))) : null))),
      g.mode !== 'ninguno' ? el('button', { type: 'button', class: 'ghost wide', id: 'allData', 'data-feedback-id': 'guests.datos.todos.abrir', 'data-feedback-label': 'Ver todos mis datos', onclick: () => paint('all') }, icon('user', 16), t('fill.allData')) : null,
      el('p', { class: 'muted small gautosave' }, icon('check', 14), ' ', t('data.autosave')));
  }

  /** Al acabar las preguntas: lo que falte aún (al elegir DNI salen el segundo apellido y el soporte) o lo siguiente. */
  function nextStep(): void {
    if (missingKeys().length) { paint('ask'); return; }
    next();
  }

  paint();
  const off = ctx.onChange((reason) => {
    // Lo del servidor solo repinta la lista y la revisión: nunca una pregunta a medias.
    if ((reason === 'guest' || reason === 'conflict') && (view === 'list' || view === 'all')) paint();
  });
  return off;
}

interface FillTask { id: 'data' | 'diet' | 'sign'; title: string; sub: string | null; state: 'done' | 'doing' | 'todo' | 'locked' }

/** Las tareas de «Antes de venir» con su estado en palabras. */
function fillTasks(g: MyGuest, missing: number): FillTask[] {
  const tasks: FillTask[] = [];
  if (g.mode !== 'ninguno') {
    const mine = Object.entries(g.sources).some(([k, by]) => by === 'guest' && g.fields[k]);
    tasks.push({ id: 'data', title: t('home.data'), sub: missing ? t('fill.leftList', { list: missingText(g.missing) }) : null, state: !missing ? 'done' : mine ? 'doing' : 'todo' });
  }
  tasks.push({ id: 'diet', title: t('home.diet'), sub: t('home.dietTodo'), state: g.diet_reviewed_at ? 'done' : 'todo' });
  if (g.mode === 'ses') tasks.push({ id: 'sign', title: t('home.sign'), sub: missing ? t('home.signAfterData') : t('home.signTodo'), state: g.signed ? 'done' : missing ? 'locked' : 'todo' });
  return tasks;
}

/** Todos los datos con «Cambiar» y quién los puso (también en «Comprueba tus respuestas» de la firma). */
export function reviewList(ctx: GuestContext, onChange: (key: string) => void, specs?: FieldSpec[], values?: Record<string, unknown>): HTMLElement {
  const g = ctx.guest();
  const fields = values ?? g.fields;
  const minor = fields.is_minor === true;
  const list = (specs ?? fieldsFor(g.mode).filter((s) => !(s.minorOnly && !minor) && !(s.adultOnly && minor)));
  if (!list.length) return el('p', { class: 'card gcard muted', id: 'dataReview' }, t('fill.nothingAsked'));
  return fbIgnore(el('dl', { class: 'gcheck', id: 'dataReview' }, ...list.flatMap((spec) => {
    const value = fields[spec.key];
    const by = g.sources[spec.key];
    const source = value !== null && value !== undefined && value !== '' && by !== 'guest' ? (by === 'organizer' ? t('data.byOrganizer') : by === 'staff' ? t('data.byStaff') : null) : null;
    return [
      el('dt', null, fieldLabel(spec.key)),
      el('dd', { dataset: { field: spec.key } }, shownValue(spec, value), source ? el('span', { class: 'gsource' }, ` · ${source}`) : null),
      el('dd', { class: 'gcheck-change' }, ctx.readOnly() ? null : el('button', { type: 'button', class: 'linklike', dataset: { key: spec.key }, 'data-feedback-id': 'guests.datos.dato.cambiar', 'data-feedback-label': 'Cambiar un dato',
        onclick: () => onChange(spec.key) }, t('fill.change'), el('span', { class: 'vh' }, ` ${fieldLabel(spec.key)}`))),
    ];
  })));
}
