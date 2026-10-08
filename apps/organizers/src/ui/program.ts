/**
 * Programa del retiro (fase 4, B16 en Booking #328): el organizador lo prepara por días; lo ven sus asistentes en Guests
 * (si el módulo «Programa» está visible) y el personal de Ikisai en Booking. Cada cambio se guarda con su acción de portal.
 */
import { confirmDialog, el, icon, openSheet, replace, toast } from '@ikisai/ui-kit';
import { describeError, errorCode, online } from '../app/client.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { failure, loading, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

export interface ProgramItem {
  id: string; revision: number; day: string; starts_at: string | null; ends_at: string | null; title: string; place: string | null;
  space_id: string | null; place_text: string | null; public_note: string | null; internal_note?: string | null; kind: string; position: number;
}
export interface PortalProgram {
  revision: number; confirmed: boolean; start_date: string | null; end_date: string | null; items: ProgramItem[];
  spaces?: Array<{ id: string; name: string }>;
}

const KINDS: Array<[string, string]> = [['actividad', L('Actividad')], ['comida', L('Comida')], ['descanso', L('Descanso')], ['otro', L('Otro')]];

/** Días del retiro, `AAAA-MM-DD`, de la entrada a la salida. */
export function daysOf(start: string | null, end: string | null): string[] {
  if (!start) return [];
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end ?? start}T12:00:00Z`);
  while (d <= last && out.length < 60) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

const dayTitle = (day: string) => new Intl.DateTimeFormat(i18n.tag(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
const hours = (it: ProgramItem) => (it.starts_at ? (it.ends_at ? `${it.starts_at}–${it.ends_at}` : it.starts_at) : t('Durante el día'));

export function renderProgram(ctx: ViewContext, reservationId: string): HTMLElement {
  const host = el('div', { id: 'program' }, loading());
  let alive = true;
  let program: PortalProgram | null = null;

  async function load(): Promise<void> {
    try {
      const out = await ctx.api.readAny<PortalProgram>('booking.portal_program', { reservation_id: reservationId });
      if (!alive) return;
      program = out.value;
      paint(out.stale ? out.at : null);
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }

  function paint(staleAt: string | null): void {
    const p = program!;
    if (!p.confirmed) { replace(host, el('p', { class: 'muted', id: 'programPending' }, t('Podrás preparar el programa cuando la reserva esté confirmada.'))); return; }
    const days = daysOf(p.start_date, p.end_date);
    const byDay = (day: string) => p.items.filter((i) => i.day === day).sort((a, b) => a.position - b.position || String(a.starts_at ?? '').localeCompare(String(b.starts_at ?? '')));
    replace(host,
      staleAt ? staleNote(staleAt) : null,
      el('p', { class: 'muted small' }, t('Lo ven tus asistentes en su enlace (si el programa está visible) y el equipo de Ikisai. Las notas internas solo las ves tú y el equipo.')),
      ...days.map((day) => {
        const items = byDay(day);
        return el('section', { class: 'orgday', 'data-day': day },
          el('h4', null, dayTitle(day)),
          items.length ? el('div', { class: 'orgitems' }, ...items.map((it, i) => el('div', { class: 'orgitem', 'data-program': it.id },
            el('button', { type: 'button', class: 'orgitem-main', onclick: () => edit(it, day) },
              el('span', { class: 'orgtime' }, hours(it)),
              el('span', null, el('strong', null, it.title), it.place ? el('span', { class: 'muted small' }, ` · ${it.place}`) : null,
                it.public_note ? el('span', { class: 'muted small orgnote' }, it.public_note) : null)),
            el('span', { class: 'orgmove' },
              el('button', { type: 'button', class: 'ghost icon', 'aria-label': t('Subir'), disabled: i === 0 ? '' : null, onclick: () => void move(items, i, -1) }, icon('chevronUp', 16)),
              el('button', { type: 'button', class: 'ghost icon', 'aria-label': t('Bajar'), disabled: i === items.length - 1 ? '' : null, onclick: () => void move(items, i, 1) }, icon('chevronDown', 16))))))
            : el('p', { class: 'muted small' }, t('Nada todavía.')),
          el('button', { type: 'button', class: 'ghost', 'data-add-day': day, onclick: () => edit(null, day) }, icon('plus', 16), ' ', t('Añadir')));
      }));
  }

  async function move(items: ProgramItem[], i: number, delta: number): Promise<void> {
    const ids = items.map((x) => x.id);
    const [moved] = ids.splice(i, 1);
    ids.splice(i + delta, 0, moved!);
    // El orden es por día: se envían todas las del retiro con las de ese día recolocadas.
    const all = program!.items.slice().sort((a, b) => a.day.localeCompare(b.day) || a.position - b.position).map((x) => x.id);
    const others = all.filter((id) => !ids.includes(id));
    try {
      await ctx.usage.run('organizers.programa.ordenar', () => ctx.api.invokeAny('booking.portal_program_reorder', { reservation_id: reservationId, ids: [...others, ...ids] }));
      await load();
    } catch (e) { toast(describeError(e)); }
  }

  function edit(item: ProgramItem | null, day: string): void {
    const p = program!;
    const days = daysOf(p.start_date, p.end_date);
    const daySel = el('select', { id: 'pr-day' }, ...days.map((d) => el('option', { value: d, selected: d === (item?.day ?? day) ? '' : null }, dayTitle(d)))) as HTMLSelectElement;
    const starts = el('input', { type: 'time', id: 'pr-starts', value: item?.starts_at ?? '' }) as HTMLInputElement;
    const ends = el('input', { type: 'time', id: 'pr-ends', value: item?.ends_at ?? '' }) as HTMLInputElement;
    const title = el('input', { type: 'text', id: 'pr-title', maxlength: '120', required: '', value: item?.title ?? '' }) as HTMLInputElement;
    const kind = el('select', { id: 'pr-kind' }, ...KINDS.map(([v, l]) => el('option', { value: v, selected: v === (item?.kind ?? 'actividad') ? '' : null }, t(l)))) as HTMLSelectElement;
    const space = el('select', { id: 'pr-space' },
      el('option', { value: '' }, t('Otro lugar (escríbelo)')),
      ...(p.spaces ?? []).map((s) => el('option', { value: s.id, selected: s.id === item?.space_id ? '' : null }, s.name))) as HTMLSelectElement;
    const placeText = el('input', { type: 'text', id: 'pr-place', maxlength: '80', value: item?.place_text ?? '', placeholder: t('Por ejemplo: junto al río') }) as HTMLInputElement;
    const placeField = el('label', { class: 'field' }, el('span', null, t('Lugar')), placeText);
    const publicNote = el('textarea', { id: 'pr-public', rows: '2', maxlength: '500' }, item?.public_note ?? '') as HTMLTextAreaElement;
    const internal = el('textarea', { id: 'pr-internal', rows: '2', maxlength: '500' }, item?.internal_note ?? '') as HTMLTextAreaElement;
    const error = el('p', { class: 'error', role: 'alert', id: 'pr-error' });
    const syncPlace = () => { placeField.hidden = space.value !== ''; };
    space.addEventListener('change', syncPlace); syncPlace();
    const sheet = openSheet({
      title: item ? t('Actividad') : t('Nueva actividad'),
      panelAttrs: { id: 'programSheet' },
      body: el('form', { id: 'programForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        el('label', { class: 'field' }, el('span', null, t('Título')), title),
        el('label', { class: 'field' }, el('span', null, t('Día')), daySel),
        el('div', { class: 'orggrid' },
          el('label', { class: 'field' }, el('span', null, t('Empieza (opcional)')), starts),
          el('label', { class: 'field' }, el('span', null, t('Termina (opcional)')), ends)),
        el('label', { class: 'field' }, el('span', null, t('Tipo')), kind),
        el('label', { class: 'field' }, el('span', null, t('Espacio')), space),
        placeField,
        el('label', { class: 'field' }, el('span', null, t('Nota para tus asistentes (opcional)')), publicNote),
        el('label', { class: 'field' }, el('span', null, t('Nota interna para Ikisai (opcional)')), internal),
        error),
      foot: el('div', { class: 'choices' },
        item ? el('button', { type: 'button', class: 'ghost danger', id: 'pr-delete', onclick: () => void remove() }, t('Quitar')) : null,
        el('button', { type: 'submit', class: 'primary', form: 'programForm', id: 'pr-save' }, t('Guardar'))),
    });
    async function submit(): Promise<void> {
      if (!title.value.trim()) { error.textContent = t('Ponle un título.'); return; }
      if (ends.value && !starts.value) { error.textContent = t('Pon también la hora de inicio.'); return; }
      if (starts.value && ends.value && ends.value <= starts.value) { error.textContent = t('La hora de fin tiene que ser posterior a la de inicio.'); return; }
      if (!online()) { error.textContent = describeError({ code: 'OFFLINE' }); return; }
      const sameDay = p.items.filter((x) => x.day === daySel.value && x.id !== item?.id);
      const fields = {
        id: item?.id ?? crypto.randomUUID(), day: daySel.value, starts_at: starts.value, ends_at: ends.value, title: title.value.trim(),
        space_id: space.value, place_text: space.value ? '' : placeText.value.trim(), public_note: publicNote.value.trim(), internal_note: internal.value.trim(), kind: kind.value,
        ...(item && item.day === daySel.value ? {} : { position: sameDay.reduce((m, x) => Math.max(m, x.position), 0) + 1 }),
      };
      try {
        await ctx.usage.run('organizers.programa.guardar', () => ctx.api.invokeAny('booking.portal_program_save', { reservation_id: reservationId, item: fields, ...(item ? { expectedRevision: item.revision } : {}) }));
        await sheet.close(true);
        await load();
      } catch (e) {
        const code = errorCode(e);
        error.textContent = code === 'PROGRAM_DAY_OUT_OF_RANGE' ? t('Ese día queda fuera de las fechas del retiro.') : describeError(e);
        if (code === 'VERSION_CONFLICT') void load();
      }
    }
    async function remove(): Promise<void> {
      if (!item || !(await confirmDialog({ title: t('¿Quitar esta actividad?'), confirmLabel: t('Quitar'), danger: true }))) return;
      try {
        await ctx.usage.run('organizers.programa.quitar', () => ctx.api.invokeAny('booking.portal_program_remove', { reservation_id: reservationId, id: item.id, expectedRevision: item.revision }));
        await sheet.close(true);
        await load();
      } catch (e) { error.textContent = describeError(e); }
    }
  }

  void load();
  (host as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; };
  return host;
}
