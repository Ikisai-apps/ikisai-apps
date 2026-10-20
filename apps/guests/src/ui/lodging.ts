/**
 * Alojamiento (API.md §13.7; Booking §23.1), rediseño de la tanda 31 (MUELA-056 r3 y la familia de 065), sin plano de
 * zonas mientras no existan los datos de dibujo: las habitaciones en una lista con filtros (lo que no cumple, en gris,
 * pero se puede elegir igual), y abajo **solo la habitación que se ve**, con sus camas por color y con texto («Cama 1 ·
 * Libre»). Lo que puede hacer el huésped lo dicen los ajustes de Booking del retiro:
 * - siempre, «Tu cama» si ya está asignada (o «Te diremos tu habitación antes de llegar»);
 * - con `preferences`, con quién le gustaría compartir y si necesita planta baja o accesible (se guarda solo);
 * - con `choice = 'choose'`, elige cama al momento; con `choice = 'request'`, queda pendiente de que el organizador lo
 *   apruebe. La nota de suplemento del organizador y la marca de supletoria se ven antes de elegir.
 * Elegir necesita red (`bindOnline`) y es atómico en Booking: si otra persona coge la cama antes (`BED_TAKEN`), se dice y
 * se recarga. Nunca se ven nombres de otros huéspedes.
 * **La familia junta** (065): arriba, cada persona con su cama o «Falta por colocar»; al tocar a alguien, «Eligiendo
 * para Leo»; y «Dormir todos aquí» reparte las camas libres de la habitación (una llamada por persona, la RPC de hoy).
 */
import { bindOnline, confirmDialog, el, icon, renderMedal, replace, toast } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { describeError, errorCode, isNetworkError, online } from '../app/client.ts';
import { formatDate, localeTag, t } from '../app/i18n.ts';
import type { Lodging } from '../app/portal.ts';
import { failure, fbIgnore, loading, staleNote } from './common.ts';
import { todayMadrid } from './home.ts';

const DEBOUNCE = 800;

/** ¿Sigue abierta la elección? Booking lo dice en `open`; si no llega, por `choose_until` (día inclusive, hora de Madrid). */
export function choiceOpen(data: Pick<Lodging, 'choice' | 'choose_until' | 'open'>): boolean {
  if (!data.choice || data.choice === 'off') return false;
  if (typeof data.open === 'boolean') return data.open;
  return !data.choose_until || todayMadrid() <= data.choose_until;
}

type Room = Lodging['rooms'][number];
type Bed = Room['beds'][number];
type Filter = 'en_suite' | 'few';

interface Person { ctx: GuestContext; name: string; data: Lodging }

/** «2 de 4 camas libres · 1 supletoria libre». */
function freeText(room: Room): string {
  return [t('lodging.free', { free: room.beds_free, total: room.beds_total }),
    room.extra_total ? t('lodging.extraFree', { free: room.extra_free ?? 0, total: room.extra_total }) : null].filter(Boolean).join(' · ');
}

export interface LodgingOptions {
  /** El cliente, para desactivar sin red lo que necesita conexión. */
  client?: { status(): { network: string }; onStatus(listener: (status: { network: string }) => void): () => void } | null;
}

/** Alojamiento de una persona o, con varias fichas, de la familia junta. */
export function mountLodging(main: HTMLElement, ctxs: GuestContext | GuestContext[], options: LodgingOptions = {}): () => void {
  const list = Array.isArray(ctxs) ? ctxs : [ctxs];
  const family = list.length > 1;
  const ctx = list[0]!;
  const notes = new Map((ctx.experience()?.modules.lodging?.options ?? []).map((o) => [o.key, o]));
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let people: Person[] = [];
  let staleAt: string | null = null;
  /** Persona para la que se elige (familia): por defecto, nadie; con una persona, ella. */
  let active: Person | null = null;
  let roomId: string | null = null;
  let changing = false;
  const filters = new Set<Filter>();
  const unbinds: Array<() => void> = [];
  const needsNet = (button: HTMLElement) => { unbinds.push(bindOnline(button, { ...(options.client ? { client: options.client } : {}), reason: t('lodging.needsNetwork') })); return button; };

  async function load(): Promise<void> {
    if (!people.length) replace(main, loading());
    try {
      const loaded = await Promise.all(list.map(async (c) => ({ c, l: await c.reads.lodging(c.grant.guest_id) })));
      if (!alive) return;
      people = loaded.map(({ c, l }) => ({ ctx: c, name: String(c.guest().fields.first_name ?? '').trim() || t('picker.unknown'), data: l?.value ?? { mine: null, preference: null, rooms: [] } }));
      staleAt = loaded.find(({ l }) => l?.stale)?.l?.at ?? null;
      if (!family) active = people[0]!;
      else if (active) active = people.find((p) => p.ctx === active!.ctx) ?? null;
      paint();
    } catch (error) {
      if (alive) replace(main, failure(error, () => void load()));
    }
  }

  const data = () => people[0]!.data;
  const choosing = () => data().choice === 'choose' || data().choice === 'request';
  /** La cama de una persona: la que su lectura marca como suya. */
  const bedOf = (p: Person): { room: Room; bed: Bed } | null => {
    for (const room of p.data.rooms) for (const bed of room.beds) if (bed.mine) return { room, bed };
    return null;
  };
  const ownerOf = (bedId: string) => people.find((p) => p.data.rooms.some((r) => r.beds.some((b) => b.bed_id === bedId && b.mine))) ?? null;
  const fits = (room: Room) => [...filters].every((f) => (f === 'en_suite' ? room.en_suite : room.beds_total <= 4));
  /** Plazas libres de la habitación para la familia: las libres más las que ya son de la familia. */
  const familyRoomSpace = (room: Room) => room.beds.filter((b) => b.free || ownerOf(b.bed_id)).length;

  async function choose(person: Person, room: Room, bed: Bed, confirm = true): Promise<boolean> {
    if (!online()) { toast(t('lodging.needsNetwork')); return false; }
    if (person.ctx.readOnly()) { toast(t('preview.readOnly')); return false; }
    if (confirm) {
      const bedText = [bed.label, bed.kind === 'supletoria' ? t('lodging.extraBed') : null].filter(Boolean).join(' · ');
      const ok = await confirmDialog({
        title: family ? t('lodging.confirmFor', { name: person.name }) : t('lodging.confirmTitle'),
        text: [data().choice === 'request' ? t('lodging.confirmRequest', { room: room.name, bed: bedText }) : t('lodging.confirmChoose', { room: room.name, bed: bedText }),
          room.supplement ? t('lodging.supplement') : null, !fits(room) ? t('lodging.noFit') : null].filter(Boolean).join(' '),
        confirmLabel: t('lodging.choose'),
      });
      if (!ok) return false;
    }
    try {
      const out = await person.ctx.reads.chooseBed(person.ctx.grant.guest_id, bed.bed_id);
      toast(out.status === 'requested' ? t('lodging.requested') : family ? t('lodging.chosenFor', { name: person.name }) : t('lodging.chosen'));
      return true;
    } catch (error) {
      const code = errorCode(error);
      toast(code === 'BED_TAKEN' ? t('lodging.taken') : code === 'CHOICE_CLOSED' ? t('lodging.closed') : code === 'PREVIEW_READ_ONLY' ? t('preview.readOnly')
        : isNetworkError(error) ? t('lodging.needsNetwork') : describeError(error));
      return false;
    }
  }

  async function pickBed(room: Room, bed: Bed): Promise<void> {
    const owner = ownerOf(bed.bed_id);
    if (owner && owner === active) return;
    if (owner) { toast(t('lodging.familyThere', { name: owner.name })); return; }
    if (!bed.free) { toast(t('lodging.full')); return; }
    if (!active) { toast(t('lodging.pickPerson')); return; }
    const done = await choose(active, room, bed);
    if (done && family) active = null;
    await load();
  }

  /** «Dormir todos aquí»: una cama libre para cada persona que aún no duerme en esta habitación. */
  async function allHere(room: Room): Promise<void> {
    if (!online()) { toast(t('lodging.needsNetwork')); return; }
    const ok = await confirmDialog({ title: t('lodging.allHereTitle', { room: room.name }), text: t('lodging.allHereText'), confirmLabel: t('lodging.allHereOk') });
    if (!ok) return;
    const free = room.beds.filter((b) => b.free && !ownerOf(b.bed_id));
    const missing: string[] = [];
    for (const p of people.filter((x) => bedOf(x)?.room.space_id !== room.space_id)) {
      const bed = free.shift();
      if (!bed || !(await choose(p, room, bed, false))) missing.push(p.name);
    }
    toast(missing.length ? t('lodging.allHereMissing', { names: missing.join(', ') }) : t('lodging.allHereDone'));
    await load();
  }

  async function release(person: Person): Promise<void> {
    if (!online()) { toast(t('lodging.needsNetwork')); return; }
    const ok = await confirmDialog({ title: t('lodging.releaseTitle'), text: t('lodging.releaseText'), confirmLabel: t('lodging.release') });
    if (!ok) return;
    try { await person.ctx.reads.releaseBed(person.ctx.grant.guest_id); } catch (error) { toast(describeError(error)); }
    await load();
  }

  function preferenceBox(person: Person): HTMLElement {
    const p = person.data;
    const state = el('p', { class: 'gfield-state', id: 'prefState', role: 'status' });
    const text = el('textarea', { id: 'prefText', rows: '2', maxlength: '200', disabled: person.ctx.readOnly() ? '' : null }, p.preference?.text ?? '') as HTMLTextAreaElement;
    const ground = el('input', { type: 'checkbox', id: 'prefGround', disabled: person.ctx.readOnly() ? '' : null, checked: p.preference?.ground_floor ? '' : null }) as HTMLInputElement;
    const send = async () => {
      state.textContent = t('save.saving');
      try {
        await person.ctx.reads.roomPreference(person.ctx.grant.guest_id, text.value.trim() || null, ground.checked);
        state.textContent = t('save.saved');
      } catch (error) {
        state.textContent = isNetworkError(error) ? t('lodging.prefOffline') : errorCode(error) === 'PREVIEW_READ_ONLY' ? t('preview.readOnly') : t('save.error');
      }
    };
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void send(); }, DEBOUNCE); };
    text.addEventListener('input', later);
    ground.addEventListener('change', () => void send());
    return fbIgnore(el('section', { class: 'card gcard', id: 'lodgingPreference', 'data-feedback-id': 'guests.alojamiento.preferencia.guardar', 'data-feedback-label': 'Preferencia de alojamiento' },
      el('h3', null, family ? t('lodging.preferTitleOf', { name: person.name }) : t('lodging.preferTitle')),
      el('div', { class: 'gfield' }, el('label', { for: 'prefText' }, t('lodging.preferWho')), text),
      el('label', { class: 'gswitch' }, ground, el('span', null, t('lodging.preferGround'))),
      el('p', { class: 'muted small' }, t('lodging.preferNote')),
      state));
  }

  /** Arriba, la cama de quien se ve (o la habitación que se propone, sin reservar nada). */
  function head(person: Person, open: boolean, shown: Room | null): HTMLElement {
    const mine = person.data.mine;
    const closed = choosing() && !open;
    const kicker = mine ? (mine.status === 'requested' ? t('lodging.pending') : closed || !choosing() ? t('lodging.assigned') : t('lodging.yourBed'))
      : choosing() && open && shown ? t('lodging.suggested') : '';
    const title = mine ? mine.space_name : choosing() && open ? (shown?.name ?? t('lodging.noneChoose')) : t('lodging.none');
    const sub = mine ? [mine.bed_label, mine.zone].filter(Boolean).join(' · ')
      : choosing() && open && data().choose_until ? t('lodging.until', { date: formatDate(data().choose_until!) }) : '';
    const releaseButton = mine && choosing() && open && mine.source === 'guest' && !person.ctx.readOnly()
      ? needsNet(el('button', { type: 'button', class: 'ghost small', id: 'lodgingRelease', 'data-feedback-id': 'guests.alojamiento.eleccion.soltar', 'data-feedback-label': 'Soltar mi elección', onclick: () => void release(person) }, t('lodging.release')))
      : null;
    return fbIgnore(el('header', { class: 'gstay', id: mine ? 'lodgingMine' : 'lodgingNone', tabindex: '-1' },
      renderMedal({ name: mine?.space_name ?? shown?.name ?? '·', size: 72 }),
      el('div', { class: 'gstay-text' },
        kicker ? el('p', { class: 'glabel' }, kicker) : null,
        el('h2', { class: 'gstay-title' }, title),
        sub ? el('p', { class: 'small gstay-sub' }, sub) : null,
        mine?.status === 'requested' ? el('p', { class: 'chip small', id: 'lodgingRequested' }, t('lodging.pending')) : null,
        closed && data().choose_until ? el('p', { class: 'small gstay-sub', id: 'lodgingClosed' }, icon('lock', 14), ' ', t('lodging.closedOn', { date: formatDate(data().choose_until!) }), ' ', t('lodging.closedHelp')) : null,
        releaseButton)));
  }

  /** La familia arriba: cada persona con su cama o «Falta por colocar»; tocar = elegir para ella. */
  function familyBlock(): HTMLElement {
    const missing = people.filter((p) => !p.data.mine);
    const rooms = new Set(people.map((p) => p.data.mine?.space_name).filter(Boolean));
    return fbIgnore(el('section', { class: 'gfam', id: 'lodgingFamily', 'aria-label': t('lodging.familyLabel') },
      el('ul', { class: 'gfam-people' }, ...people.map((p) => {
        const b = bedOf(p);
        return el('li', null, el('button', {
          type: 'button', class: `gfam-person${active === p ? ' on' : ''}${p.data.mine ? '' : ' miss'}`, 'aria-pressed': String(active === p), dataset: { guest: p.ctx.grant.guest_id },
          'data-feedback-id': 'guests.alojamiento.persona.elegir', 'data-feedback-label': 'Elegir para quién',
          onclick: () => { active = active === p ? null : p; if (active && b) roomId = b.room.space_id; paint(); },
        }, renderMedal({ name: p.name, size: 40 }), el('span', null, el('strong', null, p.name),
          el('span', { class: 'small' }, p.data.mine ? [p.data.mine.space_name, p.data.mine.bed_label].filter(Boolean).join(' · ') + (p.data.mine.status === 'requested' ? ` · ${t('lodging.pending')}` : '') : t('lodging.notPlaced')))));
      })),
      missing.length ? el('p', { class: 'small gfam-miss', role: 'status' }, icon('warn', 14), ' ', t('lodging.missing', { names: new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(missing.map((p) => p.name)) }))
        : el('p', { class: 'small gfam-ok', role: 'status' }, icon('check', 14), ' ', rooms.size === 1 ? t('lodging.allTogether') : t('lodging.allPlaced')),
      choosing() && choiceOpen(data()) ? (active
        ? el('div', { class: 'gfam-moving', id: 'familyMoving', role: 'status' }, renderMedal({ name: active.name, size: 40 }),
          el('p', null, el('strong', null, t('lodging.choosingFor', { name: active.name })), el('span', { class: 'small' }, t('lodging.choosingHint'))),
          el('button', { type: 'button', class: 'ghost', 'data-feedback-id': 'guests.alojamiento.persona.listo', 'data-feedback-label': 'Listo', onclick: () => { active = null; paint(); } }, t('lodging.done')))
        : el('p', { class: 'small gfam-hint' }, t('lodging.familyHint', { count: people.length }))) : null));
  }

  /** La habitación que se ve: lo esencial y sus camas por color, con texto. */
  function roomBlock(room: Room, open: boolean): HTMLElement {
    const option = notes.get(room.option_key ?? '') ?? notes.get('');
    const canPick = open && choosing();
    const here = people.filter((p) => bedOf(p)?.room.space_id === room.space_id);
    const showAllHere = family && canPick && !active && here.length < people.length && familyRoomSpace(room) >= people.length;
    const beds = room.beds.map((bed) => {
      const owner = ownerOf(bed.bed_id);
      const st = owner ? (owner === active || !family ? 'mine' : 'ours') : bed.free ? 'free' : 'full';
      const stateText = st === 'mine' ? t('lodging.bedMine') : st === 'ours' ? t('lodging.bedOf', { name: owner!.name }) : st === 'free' ? t('lodging.bedFree') : t('lodging.bedTaken');
      return el('button', {
        type: 'button', class: `gbed st-${st}`, dataset: { bed: bed.bed_id }, 'aria-disabled': canPick && st === 'free' && !ctx.readOnly() ? null : 'true',
        'data-feedback-id': 'guests.alojamiento.eleccion.elegir', 'data-feedback-label': 'Elegir cama',
        onclick: () => { if (canPick) void pickBed(room, bed); },
      }, el('span', { class: 'gbed-in', 'aria-hidden': 'true' }), el('span', { class: 'gbed-text' }, el('strong', null, bed.label),
        bed.kind === 'supletoria' ? el('span', { class: 'chip small gextra' }, t('lodging.extraBed')) : null, el('span', { class: 'small' }, stateText)));
    });
    const hereButton = showAllHere ? needsNet(el('button', { type: 'button', class: 'primary wide', id: 'familyHere', 'data-feedback-id': 'guests.alojamiento.familia.juntos', 'data-feedback-label': 'Dormir todos aquí', onclick: () => void allHere(room) }, t('lodging.allHere'))) : null;
    return el('section', { class: 'groom', id: 'lodgingRoom', tabindex: '-1', 'aria-label': room.name, dataset: { space: room.space_id } },
      el('header', { class: 'groom-head' }, el('h3', null, room.name, room.zone ? el('span', { class: 'small' }, ` · ${room.zone}`) : null),
        el('p', { class: 'small' }, [room.en_suite ? t('lodging.enSuite') : t('lodging.shared'), freeText(room)].join(' · ')),
        option?.guest_note || room.supplement ? el('p', { class: 'small groom-note' }, option?.label ? el('strong', null, `${option.label}: `) : null, option?.guest_note ?? t('lodging.supplement')) : null),
      canPick && !fits(room) ? el('p', { class: 'small groom-nofit' }, icon('warn', 14), ' ', t('lodging.noFit')) : null,
      hereButton,
      canPick ? el('p', { class: 'groom-hint' }, family && !active ? t('lodging.hintFamily') : t('lodging.hint')) : null,
      el('div', { class: 'gbeds', role: 'group', 'aria-label': t('lodging.bedsOf', { room: room.name }) }, ...beds),
      el('ul', { class: 'glegend', 'aria-label': t('lodging.legend') },
        el('li', null, el('span', { class: 'gsw st-free' }), t('lodging.bedFree')),
        el('li', null, el('span', { class: 'gsw st-full' }), t('lodging.bedTaken')),
        el('li', null, el('span', { class: 'gsw st-mine' }), family ? t('lodging.legendOurs') : t('lodging.bedMine'))));
  }

  function paint(): void {
    for (const off of unbinds.splice(0)) off();
    const d = data();
    const open = choiceOpen(d);
    const person = active ?? people[0]!;
    const myBed = bedOf(person);
    const rooms = d.rooms;
    if (!roomId || !rooms.some((r) => r.space_id === roomId)) {
      // La de quien se ve, la primera con cama de la familia o la que cumple con más sitio (la propuesta, sin reservar).
      roomId = myBed?.room.space_id ?? people.map(bedOf).find(Boolean)?.room.space_id
        ?? [...rooms].filter((r) => r.beds_free > 0).sort((a, b) => (fits(b) ? 1 : 0) - (fits(a) ? 1 : 0) || b.beds_free - a.beds_free)[0]?.space_id ?? rooms[0]?.space_id ?? null;
    }
    const shown = rooms.find((r) => r.space_id === roomId) ?? null;
    const offline = options.client ? options.client.status().network === 'offline' : !online();

    let choice: HTMLElement | null = null;
    if (choosing() && open) {
      const groups = new Map<string, Room[]>();
      for (const room of rooms) groups.set(room.option_key ?? '', [...(groups.get(room.option_key ?? '') ?? []), room]);
      const listId = 'lodgingList';
      const change = el('button', { type: 'button', class: 'gchange-room', 'aria-expanded': String(changing || !shown), 'aria-controls': listId,
        'data-feedback-id': 'guests.alojamiento.habitacion.cambiar', 'data-feedback-label': 'Cambiar habitación',
        onclick: () => { changing = !changing; paint(); (main.querySelector('.gchange-room') as HTMLElement | null)?.focus(); } },
      t('lodging.changeRoom'), icon(changing ? 'chevronUp' : 'chevronDown', 16));
      choice = el('section', { class: 'grooms', id: 'lodgingRooms' },
        el('h3', null, d.choice === 'request' ? t('lodging.requestTitle') : t('lodging.chooseTitle')),
        el('div', { class: 'gfilters', role: 'group', 'aria-label': t('lodging.preferTitle') },
          ...([['en_suite', t('lodging.enSuite')], ['few', t('lodging.few')]] as Array<[Filter, string]>).map(([f, label]) => el('button', {
            type: 'button', 'aria-pressed': String(filters.has(f)), 'data-feedback-id': 'guests.alojamiento.filtro.cambiar', 'data-feedback-label': 'Filtrar habitaciones',
            onclick: () => {
              if (filters.has(f)) filters.delete(f); else filters.add(f);
              // Si la que se ve deja de cumplir y aún no hay cama, se pasa a la primera que cumple.
              if (shown && !fits(shown) && !bedOf(person)) roomId = rooms.find((r) => fits(r) && r.beds_free > 0)?.space_id ?? roomId;
              paint();
            },
          }, label))),
        shown ? change : null,
        changing || !shown ? el('div', { id: listId, class: 'groom-list' }, ...[...groups].map(([key, group]) => {
          const option = notes.get(key) ?? notes.get('');
          const supplement = group.some((r) => r.supplement);
          return el('section', { class: 'glodging-option', dataset: { option: key } },
            option || supplement ? el('div', { class: 'glodging-head' },
              option?.label ? el('strong', null, option.label) : null,
              el('span', { class: 'small' }, option?.guest_note ?? (supplement ? t('lodging.supplement') : ''))) : null,
            el('ul', null, ...group.map((room) => el('li', null, el('button', {
              type: 'button', class: `groom-row${room.space_id === roomId ? ' on' : ''}${fits(room) ? '' : ' nofit'}`, 'aria-pressed': String(room.space_id === roomId), dataset: { space: room.space_id },
              'data-feedback-id': 'guests.alojamiento.habitacion.ver', 'data-feedback-label': 'Ver una habitación',
              onclick: () => {
                roomId = room.space_id; changing = false; paint();
                const target = main.querySelector<HTMLElement>('#lodgingRoom');
                target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
                target?.focus({ preventScroll: true });
              },
            }, renderMedal({ name: room.name, size: 44 }),
            el('span', { class: 'groom-text' }, el('strong', null, room.name, room.zone ? el('span', { class: 'small' }, ` · ${room.zone}`) : null),
              el('span', { class: 'small' }, [room.en_suite ? t('lodging.enSuite') : t('lodging.shared'), freeText(room), room.supplement ? t('lodging.withSupplement') : null].filter(Boolean).join(' · ')),
              fits(room) ? null : el('span', { class: 'small groom-nofit' }, icon('warn', 14), ' ', t('lodging.noFit'))),
            icon(room.space_id === roomId ? 'check' : 'chevronRight', 16))))));
        })) : null,
        rooms.length ? null : el('p', { class: 'muted', id: 'lodgingNoRooms' }, t('lodging.noRooms')),
        shown ? roomBlock(shown, open) : null);
    }

    replace(main,
      staleAt ? staleNote(staleAt) : null,
      offline && choosing() && open ? el('p', { class: 'small goffline', role: 'status' }, icon('offline', 14), ' ', t('lodging.needsNetwork')) : null,
      el('div', { class: 'pagehead' }, el('h2', null, t('lodging.title'))),
      family ? familyBlock() : null,
      head(person, open, shown),
      person.data.preferences ? preferenceBox(person) : null,
      choice,
      !choice && shown && myBed ? roomBlock(shown, open) : null);
  }

  void load();
  return () => { alive = false; if (timer) clearTimeout(timer); for (const off of unbinds.splice(0)) off(); };
}
