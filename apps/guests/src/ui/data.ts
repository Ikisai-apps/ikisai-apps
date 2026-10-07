/**
 * Mis datos (API.md §9.4): bloques plegables según el modo de la reserva, la marca de procedencia («Lo indicó tu
 * organizador»), el motivo de lo obligatorio y guardado automático campo a campo, sin botón «Guardar»: al salir del campo
 * o tras 800 ms sin teclear. Lo que no pasa la validación no se envía y se queda marcado con el motivo.
 */
import { el, icon, openSheet, replace } from '@ikisai/ui-kit';
import type { MyGuest } from '../app/api.ts';
import { commonText } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { countryOptions, fieldLabel, fieldsFor, GROUPS, isKnownCountry, missingText, type FieldSpec, type Group } from '../app/labels.ts';
import { backLink, centralText, fbIgnore, staleNote } from './common.ts';

const DEBOUNCE = 800;
const REQUIRED_HINT = new Set(['contact']);

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

export function mountData(main: HTMLElement, ctx: GuestContext, base: string): () => void {
  const guest = ctx.guest();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const controls = new Map<string, { node: HTMLElement; read(): unknown; write(value: unknown): void; spec: FieldSpec }>();
  const states = new Map<string, HTMLElement>();
  const badges = new Map<string, HTMLElement>();
  const hints = new Map<string, HTMLElement>();
  const errors = new Map<string, string | null>();
  const groups = new Map<Group, { details: HTMLDetailsElement; summary: HTMLElement; rows: HTMLElement[] }>();
  /** Valor del servidor al empezar a editar cada campo (base del conflicto, writer.ts). */
  const baseValues = new Map<string, unknown>();
  const specs = fieldsFor(guest.mode);
  const resetNote = el('p', { class: 'banner warn', id: 'signatureReset', role: 'status', hidden: true }, icon('warn', 18), ' ', t('data.signatureReset'));
  const stale = el('div');

  function save(key: string): void {
    const control = controls.get(key);
    if (!control) return;
    const { value, error } = normalize(key, control.read());
    errors.set(key, error);
    if (!error) {
      const current = ctx.guest().fields[key];
      if ((current ?? null) !== (value ?? null)) {
        ctx.writer.enqueue({ kind: 'fields', fields: { [key]: value }, base: { [key]: baseValues.has(key) ? baseValues.get(key) : current } });
        baseValues.delete(key);
      }
    }
    paintField(key);
  }

  function schedule(key: string, now = false): void {
    if (!baseValues.has(key)) baseValues.set(key, ctx.guest().fields[key] ?? null);
    clearTimeout(timers.get(key));
    if (now) { timers.delete(key); save(key); return; }
    timers.set(key, setTimeout(() => { timers.delete(key); save(key); }, DEBOUNCE));
  }

  function control(spec: FieldSpec): { node: HTMLElement; read(): unknown; write(value: unknown): void } {
    const id = `f-${spec.key}`;
    const common = { id, name: spec.key, 'data-feedback-ignore': '' };
    if (spec.type === 'toggle') {
      const input = el('input', { ...common, type: 'checkbox', onchange: () => { schedule(spec.key, true); paintMinor(); } }) as HTMLInputElement;
      return { node: el('label', { class: 'gswitch' }, input, el('span', null, fieldLabel(spec.key))), read: () => input.checked, write: (v) => { input.checked = v === true; } };
    }
    if (spec.type === 'select') {
      const select = el('select', { ...common, onchange: () => schedule(spec.key, true) },
        el('option', { value: '' }, t('data.choose')), ...(spec.options?.() ?? []).map(([v, label]) => el('option', { value: v }, label))) as HTMLSelectElement;
      return { node: select, read: () => select.value, write: (v) => { select.value = typeof v === 'string' ? v : ''; } };
    }
    if (spec.type === 'country') {
      const other = el('input', { ...common, id: `${id}-other`, type: 'text', maxlength: '3', placeholder: t('data.countryCode'), hidden: true, oninput: () => schedule(spec.key), onblur: () => schedule(spec.key, true) }) as HTMLInputElement;
      const select = el('select', { ...common, onchange: () => { other.hidden = select.value !== '__other'; if (select.value !== '__other') schedule(spec.key, true); else other.focus(); } },
        el('option', { value: '' }, t('data.choose')), ...countryOptions().map(([v, label]) => el('option', { value: v }, label)), el('option', { value: '__other' }, t('data.otherCountry'))) as HTMLSelectElement;
      return {
        node: el('div', { class: 'gcountry' }, select, other),
        read: () => (select.value === '__other' ? other.value : select.value),
        write: (v) => {
          const code = typeof v === 'string' ? v : '';
          if (!code || isKnownCountry(code)) { select.value = code; other.hidden = true; } else { select.value = '__other'; other.hidden = false; other.value = code; }
        },
      };
    }
    const input = el('input', {
      ...common, type: spec.type === 'date' ? 'date' : spec.type, autocomplete: spec.autocomplete ?? 'off',
      ...(spec.type === 'tel' ? { inputmode: 'tel' } : {}), ...(spec.type === 'date' ? { max: new Date().toISOString().slice(0, 10) } : {}),
      oninput: () => schedule(spec.key, spec.type === 'date'), onblur: () => { if (timers.has(spec.key)) schedule(spec.key, true); },
    }) as HTMLInputElement;
    return { node: input, read: () => input.value, write: (v) => { input.value = typeof v === 'string' ? v : ''; } };
  }

  function paintField(key: string): void {
    const g = ctx.guest();
    const state = ctx.writer.fieldState(key);
    const error = errors.get(key) ?? null;
    const node = states.get(key);
    if (node) {
      node.dataset.state = error ? 'invalid' : state ?? '';
      node.textContent = error ?? (state === 'saving' ? t('save.saving') : state === 'saved' ? t('save.saved') : state === 'pending' ? t('save.pending') : state === 'error' ? t('save.error') : '');
    }
    const badge = badges.get(key);
    if (badge) {
      const filled = g.fields[key] !== null && g.fields[key] !== undefined && g.fields[key] !== '' && g.fields[key] !== false;
      const by = g.sources[key];
      badge.textContent = filled && by === 'organizer' ? t('data.byOrganizer') : filled && by === 'staff' ? t('data.byStaff') : '';
    }
    const hint = hints.get(key);
    if (hint) {
      const wanted = g.mode === 'ses' && (g.missing.includes(key) || (REQUIRED_HINT.has('contact') && (key === 'phone' || key === 'email') && g.missing.includes('contact')));
      hint.textContent = wanted ? (key === 'phone' || key === 'email' ? t('data.contactHint') : t('data.required')) : '';
    }
  }

  function paintMinor(): void {
    const minor = controls.get('is_minor')?.read() === true;
    for (const [key, c] of controls) {
      const row = c.node.closest('.gfield') as HTMLElement | null;
      if (!row) continue;
      if (c.spec.minorOnly) row.hidden = !minor;
      if (c.spec.adultOnly) row.hidden = minor;
      void key;
    }
    paintGroups();
  }

  function paintGroups(): void {
    const g = ctx.guest();
    for (const [group, parts] of groups) {
      const keys = specs.filter((s) => s.group === group).map((s) => s.key);
      const missing = g.missing.filter((m) => keys.includes(m) || (m === 'contact' && group === 'contact'));
      parts.summary.textContent = missing.length ? t('data.groupMissing', { count: missing.length }) : t('data.groupDone');
      parts.summary.dataset.state = missing.length ? 'missing' : 'done';
      parts.details.hidden = parts.rows.every((r) => r.hidden);
    }
  }

  /** Repinta desde el servidor sin pisar lo que el huésped tiene a medias (foco, temporizador o cola). */
  function sync(): void {
    const g = ctx.guest();
    for (const [key, c] of controls) {
      const editing = timers.has(key) || c.node.contains(document.activeElement) || ['pending', 'saving'].includes(ctx.writer.fieldState(key) ?? '');
      if (!editing) c.write(g.fields[key] ?? (c.spec.type === 'toggle' ? false : null));
      paintField(key);
    }
    paintMinor();
    resetNote.hidden = !(ctx.signatureReset() && !g.signed && g.mode === 'ses');
    replace(stale, ctx.staleAt() ? staleNote(ctx.staleAt()!) : null);
  }

  function build(): void {
    const firstMissing = GROUPS.find((group) => specs.some((s) => s.group === group && guest.missing.includes(s.key)) || (group === 'contact' && guest.missing.includes('contact')));
    const blocks = GROUPS.filter((group) => specs.some((s) => s.group === group)).map((group) => {
      const summary = el('span', { class: 'gsummary-state' });
      const rows = specs.filter((s) => s.group === group).map((spec) => {
        const c = control(spec);
        controls.set(spec.key, { ...c, spec });
        const state = el('span', { class: 'gfield-state', id: `s-${spec.key}`, role: 'status' });
        const badge = el('span', { class: 'gsource', id: `src-${spec.key}` });
        const hint = el('span', { class: 'ghint', id: `h-${spec.key}` });
        states.set(spec.key, state); badges.set(spec.key, badge); hints.set(spec.key, hint);
        return el('div', { class: 'gfield', 'data-field': spec.key },
          spec.type === 'toggle' ? null : el('label', { for: `f-${spec.key}` }, fieldLabel(spec.key)),
          c.node,
          el('div', { class: 'gfield-meta' }, badge, hint, state));
      });
      const details = el('details', { class: 'card ggroup', 'data-group': group, open: group === (firstMissing ?? 'identity') ? '' : null,
        'data-feedback-id': 'guests.datos.bloque.abrir', 'data-feedback-label': 'Bloque de datos' },
        el('summary', null, el('span', null, t(`group.${group}`)), summary), ...rows) as HTMLDetailsElement;
      groups.set(group, { details, summary, rows });
      return details;
    });
    const why = commonText('guests.data_why');
    replace(main,
      backLink(base),
      stale,
      el('div', { class: 'pagehead' }, el('h2', null, t('data.title')), el('p', { class: 'muted' }, guest.mode === 'ses' ? t('data.introSes') : t('data.introOperative'))),
      guest.mode === 'ses' && why ? el('button', { type: 'button', class: 'linklike', id: 'whyData', 'data-feedback-id': 'guests.datos.motivo.abrir', 'data-feedback-label': '¿Por qué te lo pedimos?',
        onclick: () => openSheet({ title: why.title ?? t('data.why'), body: centralText(why.body, why.spanishOnly, { id: 'whyText' }) }) }, icon('info', 16), t('data.why')) : null,
      resetNote,
      fbIgnore(el('form', { id: 'dataForm', class: 'gform', autocomplete: 'on', onsubmit: (e: Event) => e.preventDefault(),
        'data-feedback-id': 'guests.datos.campo.guardar', 'data-feedback-label': 'Formulario de datos' }, ...blocks)),
      el('p', { class: 'muted small gautosave' }, icon('check', 14), ' ', t('data.autosave')),
    );
    sync();
  }

  build();
  const off = ctx.onChange((reason) => { if (reason === 'guest' || reason === 'state' || reason === 'conflict') sync(); });
  return () => {
    for (const key of [...timers.keys()]) { clearTimeout(timers.get(key)); timers.delete(key); save(key); }
    off();
  };
}

/** Lo que falta, para Inicio y la firma. */
export function missingSummary(guest: MyGuest): string {
  return missingText(guest.missing);
}
