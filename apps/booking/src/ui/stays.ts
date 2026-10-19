/**
 * Estancias (O2, API.md §26): quién duerme en casa fuera de los retiros. Outsiders (con su cama por defecto) y staff;
 * próximas estancias con sus choques (aviso, nunca bloqueo) y notas con hora. El personal crea, mueve o quita una
 * estancia y fija la cama por defecto; el outsider hace lo suyo desde Guests.
 */
import { confirmDialog, createCoverCarousel, el, formatDate, initialsOf, renderMedal, renderTimeline, replace, timelineWindow, toast } from '@ikisai/ui-kit';
import type { SyncedRow } from '@ikisai/sync-client';
import { stayClashes, type ClashAssignment, type ClashReservation } from '@ikisai/domain-booking';
import { ASSIGNMENTS, BEDS, EVENTS, OUTSIDER_DEFAULTS, RESERVATIONS, SPACES, STAYS, STAY_NOTES, STAY_PERSONS, canRead, canWrite, describeError, shortDay, today } from '../app/client.ts';
import { STAY_KIND_LABELS, housePeople, liveStays, personsByStay, stayTitle, type HousePerson, type StayRow } from '../app/stays.ts';
import { openRowSheet, type FieldSpec } from './form.ts';
import type { ViewMount } from './shell.ts';

type Bed = SyncedRow & { space_id: string; label: string; active: boolean };
type Space = SyncedRow & { name: string; active: boolean };
type DefaultRow = SyncedRow & { account_id: string; bed_id: string | null; space_id: string | null };
type NoteRow = SyncedRow & { account_id: string; at: string; note: string; author_kind: 'outsider' | 'staff' };

/** Opciones de cama «Habitación · Cama 1», solo vivas y activas. */
async function bedOptions(client: Parameters<ViewMount>[0]['client']): Promise<Array<readonly [string, string]>> {
  const spaces = new Map(((await client.list(SPACES)) as Space[]).filter((s) => s.deleted_at === null && s.active).map((s) => [s.id, s.name]));
  return ((await client.list(BEDS)) as Bed[])
    .filter((b) => b.deleted_at === null && b.active && spaces.has(b.space_id))
    .map((b) => [b.id, `${spaces.get(b.space_id)} · ${b.label}`] as const)
    .sort((a, b) => a[1].localeCompare(b[1], 'es'));
}

const checkStay = (m: Record<string, unknown>) => (typeof m.from_date === 'string' && typeof m.to_date === 'string' && m.to_date <= m.from_date ? 'La salida tiene que ser posterior a la llegada.' : null);

export const mountStays: ViewMount = ({ main, client, navigate }) => {
  const writable = canWrite(client);
  const coverHost = el('div', { 'data-feedback-id': 'booking.estancias.portada', 'data-feedback-label': 'Portada de estancias' });
  const yearHost = el('div', { id: 'staysYear', 'data-feedback-id': 'booking.estancias.ano', 'data-feedback-label': 'Tu año' });
  const listHost = el('div', { id: 'staysList', 'data-feedback-id': 'booking.estancias.proximas', 'data-feedback-label': 'Próximas estancias' });
  const defaultsHost = el('div', { id: 'outsiderDefaults', 'data-feedback-id': 'booking.estancias.camas', 'data-feedback-label': 'Camas por defecto' });
  const notesHost = el('div', { id: 'stayNotes', 'data-feedback-id': 'booking.estancias.notas', 'data-feedback-label': 'Notas' });
  let people: HousePerson[] = [];

  const nameOf = (account: string) => people.find((p) => p.account_id === account)?.name ?? 'Cuenta sin nombre';
  const accountOptions = (level?: string) => people.filter((p) => !level || p.level === level || (level === 'staff' && p.level === 'direccion')).map((p) => [p.account_id, p.name] as const);

  async function openStay(row: StayRow | null): Promise<void> {
    if (people.length === 0 && !row) { toast('Hace falta conexión para elegir a la persona.'); return; }
    const beds = await bedOptions(client);
    const specs: FieldSpec[] = [
      ...(row ? [] : [
        { key: 'kind', label: 'Tipo', type: 'select', options: [['outsider', 'Outsider'], ['staff', 'Staff']] } as FieldSpec,
        { key: 'account_id', label: 'Persona', type: 'select', options: accountOptions() } as FieldSpec,
      ]),
      { key: 'from_date', label: 'Llegada', type: 'date' },
      { key: 'to_date', label: 'Salida', type: 'date' },
      { key: 'bed_id', label: 'Cama', type: 'select', optional: true, options: beds, hint: 'Sin cama, un outsider usa su cama por defecto.' },
    ];
    openRowSheet({
      client, title: row ? 'Estancia' : 'Nueva estancia', table: STAYS, row, specs, check: checkStay,
      defaults: row ? {} : { kind: 'outsider', from_date: today() },
      savedMessage: 'Estancia guardada.', feedbackId: row ? 'booking.estancias.estancia' : 'booking.estancias.nueva', feedbackLabel: row ? 'Estancia' : 'Nueva estancia',
      // La habitación sale de la cama también en el dispositivo (sin red el choque se ve ya; el servidor lo comprueba igual).
      buildOperations: async (v) => {
        const bedId = (v.bed_id as string | null) ?? null;
        const spaceId = bedId ? ((await client.get(BEDS, bedId)) as Bed | null)?.space_id ?? null : null;
        const place = bedId ? { bed_id: bedId, space_id: spaceId } : { bed_id: null };
        if (!row) return [{ op: 'insert', table: STAYS, id: crypto.randomUUID(), fields: { kind: v.kind, account_id: v.account_id, from_date: v.from_date, to_date: v.to_date, ...place } }];
        const fields: Record<string, unknown> = { from_date: v.from_date, to_date: v.to_date, ...(bedId !== row.bed_id ? place : {}) };
        return [{ op: 'update', table: STAYS, id: row.id, expectedRevision: row.revision, fields }];
      },
      remove: row ? {
        label: 'Quitar estancia',
        confirmDialog: { title: 'Quitar estancia', text: 'Se quita la estancia y quién venía en ella. El outsider lo verá en Guests.', confirmLabel: 'Quitar' },
        operations: () => [{ op: 'delete', table: STAYS, id: row.id, expectedRevision: row.revision }],
      } : undefined,
    });
  }

  async function setDefault(person: HousePerson, current: DefaultRow | undefined): Promise<void> {
    openRowSheet({
      client, title: `Cama por defecto · ${person.name}`, table: OUTSIDER_DEFAULTS, row: current ?? null,
      specs: [{ key: 'bed_id', label: 'Cama', type: 'select', optional: true, options: await bedOptions(client) }],
      insertFields: current ? undefined : { account_id: person.account_id },
      savedMessage: 'Cama por defecto guardada.', feedbackId: 'booking.estancias.camas.cambiar', feedbackLabel: 'Cama por defecto',
    });
  }

  async function addNote(): Promise<void> {
    const outsiders = accountOptions('outsider');
    if (outsiders.length === 0) { toast(navigator.onLine ? 'No hay outsiders.' : 'Hace falta conexión para elegir a la persona.'); return; }
    openRowSheet({
      client, title: 'Nueva nota', table: STAY_NOTES, row: null,
      specs: [
        { key: 'account_id', label: 'Para', type: 'select', options: outsiders },
        { key: 'at', label: 'Día', type: 'date' },
        { key: 'time', label: 'Hora', type: 'time', local: true },
        { key: 'note', label: 'Nota', type: 'textarea', max: 500, personal: true },
      ],
      defaults: { at: today(), time: '12:00' },
      // día y hora de casa (Madrid), guardados como instante
      buildOperations: (v) => [{ op: 'insert', table: STAY_NOTES, id: crypto.randomUUID(),
        fields: { account_id: v.account_id, at: new Date(`${v.at}T${String(v.time ?? '12:00').slice(0, 5)}:00`).toISOString(), note: v.note } }],
      savedMessage: 'Nota guardada.', feedbackId: 'booking.estancias.notas.nueva', feedbackLabel: 'Nueva nota',
    });
  }

  async function removeNote(row: NoteRow): Promise<void> {
    if (!await confirmDialog({ title: 'Quitar nota', text: 'La nota deja de verse también en Guests.', confirmLabel: 'Quitar', danger: true })) return;
    try { await client.commit([{ op: 'delete', table: STAY_NOTES, id: row.id, expectedRevision: row.revision }]); }
    catch (error) { toast(describeError(error)); }
  }

  async function paint(): Promise<void> {
    const now = today();
    const stays = await liveStays(client);
    const persons = await personsByStay(client);
    const data = {
      assignments: (await client.list(ASSIGNMENTS)) as unknown as ClashAssignment[],
      events: (await client.list(EVENTS)) as unknown as Array<{ id: string; reservation_id: string; deleted_at: string | null }>,
      reservations: (await client.list(RESERVATIONS)) as unknown as ClashReservation[],
      stays,
    };
    const beds = new Map((await bedOptions(client)).map(([id, label]) => [id, label]));
    const upcoming = stays.filter((s) => s.to_date > now).sort((a, b) => a.from_date.localeCompare(b.from_date) || a.id.localeCompare(b.id));
    const clashesOf = new Map(upcoming.map((s) => [s.id, stayClashes(s, data)]));
    const row = (s: StayRow) => {
      const clashes = clashesOf.get(s.id) ?? [];
      return el('li', { class: 'row', dataset: { stayId: s.id, kind: s.kind, pending: String(s._pending === true) }, 'data-feedback-id': 'booking.estancias.proximas.fila', 'data-feedback-label': 'Estancia' },
        el('div', { class: 'row-title' }, renderMedal({ initials: initialsOf(stayTitle(s, persons.get(s.id), people)), color: s.kind === 'staff' ? '#3a6ea5' : '#7a5a9e', size: 40 }),
          el('span', { class: 'name', 'data-feedback-ignore': '' }, stayTitle(s, persons.get(s.id), people)),
          el('span', { class: 'chip', dataset: { stay: s.kind } }, STAY_KIND_LABELS[s.kind] ?? s.kind),
          clashes.length ? el('span', { class: 'chip alert', 'data-clash': '' }, 'Choca') : null,
          s._pending ? el('span', { class: 'chip pending' }, 'Pendiente') : null),
        el('div', { class: 'row-meta' }, `${shortDay(s.from_date)} → ${shortDay(s.to_date)}`, s.bed_id ? ` · ${beds.get(s.bed_id) ?? 'Cama'}` : ' · Sin cama',
          s.source === 'guest' ? ' · la puso el outsider' : ''),
        clashes.length ? el('ul', { class: 'hint clashlist' }, clashes.map((c) => el('li', null, c.kind === 'retiro'
          ? ['Choca con ', el('a', { href: `#/reservas/${c.reservation_id}` }, c.title), ` (${shortDay(c.from)} → ${shortDay(c.to)})`]
          : `Choca con otra estancia en la misma cama (${shortDay(c.from)} → ${shortDay(c.to)})`))) : null,
        writable ? el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', 'aria-label': 'Cambiar la estancia', 'data-feedback-id': 'booking.estancias.proximas.editar', 'data-feedback-label': 'Cambiar', onclick: () => void openStay(s) }, 'Cambiar')) : null);
    };
    // Tres grupos con su cifra (MUELA-067 §6): en casa ahora, llegan esta semana (7 días) y más adelante; lo que choca, primero.
    const week = new Date(Date.parse(`${now}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const clashFirst = (list: StayRow[]) => [...list].sort((a, b) => Number((clashesOf.get(b.id) ?? []).length > 0) - Number((clashesOf.get(a.id) ?? []).length > 0));
    const groups: Array<[string, string, StayRow[]]> = [
      ['casa', 'En casa ahora', clashFirst(upcoming.filter((s) => s.from_date <= now))],
      ['semana', 'Llegan esta semana', clashFirst(upcoming.filter((s) => s.from_date > now && s.from_date <= week))],
      ['luego', 'Más adelante', clashFirst(upcoming.filter((s) => s.from_date > week))],
    ];
    // Portada: la estancia en curso o la próxima, con flechas, teclado y deslizar.
    const coverStays = [...groups[0]![2], ...groups[1]![2], ...groups[2]![2]].slice(0, 5);
    const carousel = coverStays.length ? createCoverCarousel({
      label: 'Estancias en curso y próximas', feedbackId: 'booking.estancias.portada',
      slides: coverStays.map((s) => {
        const clash = (clashesOf.get(s.id) ?? []).find((c) => c.kind === 'retiro');
        return { id: s.id, title: stayTitle(s, persons.get(s.id), people), color: s.kind === 'staff' ? '#3a6ea5' : '#7a5a9e',
          state: `${STAY_KIND_LABELS[s.kind] ?? s.kind}${s.from_date <= now ? ' · en casa' : ''}`,
          meta: [`${shortDay(s.from_date)} → ${shortDay(s.to_date)}`, s.bed_id ? beds.get(s.bed_id) ?? 'Cama' : 'Sin cama', clash ? `Choca con ${clash.title}` : null].filter(Boolean).join(' · ') };
      }),
    }) : null;
    if (carousel) carousel.element.id = 'stayCover';
    replace(coverHost, carousel?.element ?? null);
    replace(listHost, upcoming.length === 0 ? el('div', { class: 'empty', id: 'staysEmpty' }, el('strong', null, 'Nadie a la vista'), 'No hay estancias próximas.')
      : groups.filter(([, , list]) => list.length > 0).map(([key, title, list]) => el('section', { class: 'bk-phase', id: `stays-${key}` },
          el('h3', { class: 'sectionlabel' }, title, el('span', { class: 'count' }, String(list.length))),
          el('ul', { class: 'list' }, list.map(row)))));

    // «Tu año»: 12 meses, una pista por persona (outsiders primero) y los retiros de fondo; los choques, rayados con «!».
    const laneOf = new Map<string, { id: string; label: string; kind: string; items: StayRow[] }>();
    for (const st of stays) {
      const id = st.account_id ?? `stay:${st.id}`;
      const lane = laneOf.get(id) ?? { id, label: stayTitle(st, persons.get(st.id), people), kind: st.kind, items: [] };
      lane.items.push(st);
      laneOf.set(id, lane);
    }
    const lanes = [...laneOf.values()].sort((a, b) => Number(a.kind === 'staff') - Number(b.kind === 'staff') || a.label.localeCompare(b.label, 'es'));
    const reservationsLive = (data.reservations as unknown as Array<{ id: string; title: string; status: string; start_date: string | null; end_date: string | null; deleted_at: string | null }>)
      .filter((r) => !r.deleted_at && r.start_date && r.end_date && ['pre_reservada', 'confirmada', 'en_ejecucion', 'cerrada'].includes(r.status));
    const win = timelineWindow(now, 12);
    const nightsByMonth: Record<string, number> = {};
    for (const st of stays) for (let t = Date.parse(`${st.from_date}T00:00:00Z`); t < Date.parse(`${st.to_date}T00:00:00Z`); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d >= win.start && d < win.end) nightsByMonth[d.slice(0, 7)] = (nightsByMonth[d.slice(0, 7)] ?? 0) + 1;
    }
    replace(yearHost, el('div', { class: 'sectionlabel' }, 'Tu año'), renderTimeline({
      label: 'Estancias de los próximos 12 meses', from: now, today: now, months: 12,
      lanes: lanes.map((l) => ({ id: l.id, label: l.label, kind: l.kind, medal: { initials: initialsOf(l.label), color: l.kind === 'staff' ? '#3a6ea5' : '#7a5a9e' },
        items: l.items.map((st) => ({ id: st.id, from: st.from_date, to: st.to_date, label: `${l.label}: ${shortDay(st.from_date)} → ${shortDay(st.to_date)}`, past: st.to_date <= now,
          clash: stayClashes(st, data).length > 0, onClick: writable ? () => void openStay(st) : undefined })) })),
      bands: reservationsLive.map((r) => ({ id: r.id, from: r.start_date!, to: r.end_date!, label: r.title, onClick: () => navigate(`#/reservas/${r.id}`) })), bandsLabel: 'Retiros',
      summary: Object.fromEntries(Object.entries(nightsByMonth).map(([m, n]) => [m, `${n} ${n === 1 ? 'noche ocupada' : 'noches ocupadas'}`])),
      emptyText: 'Sin estancias en los próximos 12 meses.',
    }));

    const defaults = canRead(client, OUTSIDER_DEFAULTS) ? ((await client.list(OUTSIDER_DEFAULTS)) as DefaultRow[]).filter((d) => d.deleted_at === null) : [];
    const outsiders = people.filter((p) => p.level === 'outsider');
    replace(defaultsHost, el('div', { class: 'sectionlabel' }, 'Camas por defecto'),
      outsiders.length === 0 ? el('p', { class: 'hint' }, navigator.onLine ? 'No hay outsiders.' : 'La lista de outsiders se verá con conexión.')
        : el('ul', { class: 'list' }, outsiders.map((p) => {
          const d = defaults.find((x) => x.account_id === p.account_id);
          return el('li', { class: 'row', 'data-feedback-id': 'booking.estancias.camas.fila', 'data-feedback-label': 'Outsider' },
            el('div', { class: 'row-title' }, el('span', { class: 'name', 'data-feedback-ignore': '' }, p.name)),
            el('div', { class: 'row-meta' }, d?.bed_id ? beds.get(d.bed_id) ?? 'Cama' : 'Sin cama por defecto'),
            writable ? el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', 'aria-label': `Cama por defecto de ${p.name}`, 'data-feedback-id': 'booking.estancias.camas.cambiar', 'data-feedback-label': 'Cambiar cama por defecto', onclick: () => void setDefault(p, d) }, 'Cambiar')) : null);
        })));

    const notes = canRead(client, STAY_NOTES) ? ((await client.list(STAY_NOTES)) as NoteRow[]).filter((n) => n.deleted_at === null && n.at.slice(0, 10) >= now).sort((a, b) => a.at.localeCompare(b.at)) : [];
    replace(notesHost, el('div', { class: 'sectionlabel' }, 'Notas'),
      notes.length === 0 ? el('p', { class: 'hint' }, 'No hay notas próximas.')
        : el('ul', { class: 'list' }, notes.map((n) => el('li', { class: 'row', 'data-feedback-id': 'booking.estancias.notas.fila', 'data-feedback-label': 'Nota' },
          el('div', { class: 'row-title' }, el('span', { class: 'name', 'data-feedback-ignore': '' }, nameOf(n.account_id)), el('span', { class: 'chip' }, n.author_kind === 'outsider' ? 'La escribió el outsider' : 'Del personal')),
          el('div', { class: 'row-meta' }, formatDate(n.at)),
          el('div', { class: 'row-meta stay-note', 'data-feedback-ignore': '' }, n.note),
          writable && n.author_kind === 'staff' ? el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', 'aria-label': 'Quitar la nota', 'data-feedback-id': 'booking.estancias.notas.quitar', 'data-feedback-label': 'Quitar nota', onclick: () => void removeNote(n) }, 'Quitar')) : null))),
      writable ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'addStayNote', 'data-feedback-id': 'booking.estancias.notas.anadir', 'data-feedback-label': 'Añadir nota', onclick: () => void addNote() }, 'Añadir nota')) : null);
  }

  replace(main,
    el('div', { class: 'pagehead' },
      el('div', null, el('h2', null, 'Estancias'), el('p', null, 'Quién duerme en casa fuera de los retiros: outsiders y staff.')),
      writable ? el('button', { class: 'primary', type: 'button', id: 'newStay', 'data-feedback-id': 'booking.estancias.nueva', 'data-feedback-label': 'Nueva estancia', onclick: () => void openStay(null) }, 'Nueva estancia') : null),
    el('p', { class: 'hint' }, 'Una estancia que coincide con un retiro en la misma cama se avisa, pero se guarda.'),
    coverHost, listHost, yearHost, defaultsHost, notesHost,
    el('p', { style: 'margin-top:14px' }, el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'booking.estancias.calendario', 'data-feedback-label': 'Ver en el calendario', onclick: () => navigate('#/calendario') }, 'Ver en el calendario')));

  void housePeople(client).then((p) => { people = p; void paint(); });
  void paint();
  const offs = [STAYS, STAY_PERSONS, STAY_NOTES, OUTSIDER_DEFAULTS, ASSIGNMENTS, RESERVATIONS].filter((t) => canRead(client, t)).map((t) => client.onTable(t, () => void paint()));
  return () => offs.forEach((off) => off());
};
