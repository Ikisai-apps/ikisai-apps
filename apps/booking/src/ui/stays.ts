/**
 * Estancias (O2, API.md §26): quién duerme en casa fuera de los retiros. Outsiders (con su cama por defecto) y staff;
 * próximas estancias con sus choques (aviso, nunca bloqueo) y notas con hora. El personal crea, mueve o quita una
 * estancia y fija la cama por defecto; el outsider hace lo suyo desde Guests.
 */
import { confirmDialog, el, formatDate, replace, toast } from '@ikisai/ui-kit';
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
    replace(listHost, upcoming.length === 0 ? el('div', { class: 'empty', id: 'staysEmpty' }, el('strong', null, 'Nadie a la vista'), 'No hay estancias próximas.')
      : el('ul', { class: 'list' }, upcoming.map((s) => {
        const clashes = stayClashes(s, data);
        return el('li', { class: 'row', dataset: { stayId: s.id, kind: s.kind, pending: String(s._pending === true) }, 'data-feedback-id': 'booking.estancias.proximas.fila', 'data-feedback-label': 'Estancia' },
          el('div', { class: 'row-title' }, el('span', { class: 'name', 'data-feedback-ignore': '' }, stayTitle(s, persons.get(s.id), people)),
            el('span', { class: 'chip', dataset: { stay: s.kind } }, STAY_KIND_LABELS[s.kind] ?? s.kind),
            clashes.length ? el('span', { class: 'chip alert', 'data-clash': '' }, 'Choca') : null,
            s._pending ? el('span', { class: 'chip pending' }, 'Pendiente') : null),
          el('div', { class: 'row-meta' }, `${shortDay(s.from_date)} → ${shortDay(s.to_date)}`, s.bed_id ? ` · ${beds.get(s.bed_id) ?? 'Cama'}` : ' · Sin cama',
            s.source === 'guest' ? ' · la puso el outsider' : ''),
          clashes.length ? el('ul', { class: 'hint clashlist' }, clashes.map((c) => el('li', null, c.kind === 'retiro'
            ? ['Choca con ', el('a', { href: `#/reservas/${c.reservation_id}` }, c.title), ` (${shortDay(c.from)} → ${shortDay(c.to)})`]
            : `Choca con otra estancia en la misma cama (${shortDay(c.from)} → ${shortDay(c.to)})`))) : null,
          writable ? el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', 'aria-label': 'Cambiar la estancia', 'data-feedback-id': 'booking.estancias.proximas.editar', 'data-feedback-label': 'Cambiar', onclick: () => void openStay(s) }, 'Cambiar')) : null);
      })));

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
    listHost, defaultsHost, notesHost,
    el('p', { style: 'margin-top:14px' }, el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'booking.estancias.calendario', 'data-feedback-label': 'Ver en el calendario', onclick: () => navigate('#/calendario') }, 'Ver en el calendario')));

  void housePeople(client).then((p) => { people = p; void paint(); });
  void paint();
  const offs = [STAYS, STAY_PERSONS, STAY_NOTES, OUTSIDER_DEFAULTS, ASSIGNMENTS, RESERVATIONS].filter((t) => canRead(client, t)).map((t) => client.onTable(t, () => void paint()));
  return () => offs.forEach((off) => off());
};
