/**
 * Alojamiento (API.md §13.7, dueño Booking), según lo que permita el organizador:
 * - `view`: tu habitación, si ya está asignada;
 * - `prefer`: además, con quién te gustaría compartir y si necesitas planta baja o accesible (se guarda solo);
 * - `choose`: eliges cama entre las habitaciones abiertas a elección, al momento;
 * - `request`: como `choose`, pero queda pendiente de que el organizador lo apruebe.
 * Elegir necesita red y es atómico en Booking: si otra persona coge la cama antes (`BED_TAKEN`), se dice y se recarga.
 * Nunca se ven nombres de otros huéspedes; del suplemento, solo la nota del organizador (nunca el coste de Ikisai).
 */
import { confirmDialog, el, icon, replace, toast } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { describeError, errorCode, isNetworkError, online } from '../app/client.ts';
import { formatDate, t } from '../app/i18n.ts';
import type { Lodging } from '../app/portal.ts';
import { failure, fbIgnore, loading, staleNote } from './common.ts';
import { todayMadrid } from './home.ts';

const DEBOUNCE = 800;

/** ¿Sigue abierta la elección? (`choose_until` es un instante o un día; sin fecha, abierta). */
export function choiceOpen(until: string | null | undefined, now = new Date()): boolean {
  if (!until) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(until)) return todayMadrid() <= until; // el día entero, en hora de Madrid
  return now <= new Date(until);
}

export function mountLodging(main: HTMLElement, ctx: GuestContext): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const config = ctx.experience()?.modules.lodging;
  const capability = config?.capability ?? 'view';
  const options = new Map((config?.options ?? []).map((o) => [o.key, o]));
  const open = choiceOpen(config?.choose_until);

  async function load(): Promise<void> {
    replace(main, loading());
    try {
      const loaded = await ctx.reads.lodging(ctx.grant.reservation_id, ctx.grant.guest_id);
      if (alive) paint(loaded?.value ?? { mine: null, preference: null, rooms: [] }, loaded?.stale ? loaded.at : null);
    } catch (error) {
      if (alive) replace(main, failure(error, () => void load()));
    }
  }

  async function choose(bedId: string, roomName: string, bedLabel: string): Promise<void> {
    if (!online()) { toast(t('lodging.needsNetwork')); return; }
    const ok = await confirmDialog({
      title: t('lodging.confirmTitle'),
      text: capability === 'request' ? t('lodging.confirmRequest', { room: roomName, bed: bedLabel }) : t('lodging.confirmChoose', { room: roomName, bed: bedLabel }),
      confirmLabel: t('lodging.choose'),
    });
    if (!ok) return;
    try {
      const out = await ctx.reads.chooseBed(ctx.grant.guest_id, bedId);
      toast(out.status === 'requested' ? t('lodging.requested') : t('lodging.chosen'));
    } catch (error) {
      const code = errorCode(error);
      toast(code === 'BED_TAKEN' ? t('lodging.taken') : code === 'CHOICE_CLOSED' ? t('lodging.closed') : isNetworkError(error) ? t('lodging.needsNetwork') : describeError(error));
    }
    await load();
  }

  async function release(): Promise<void> {
    if (!online()) { toast(t('lodging.needsNetwork')); return; }
    try { await ctx.reads.releaseBed(ctx.grant.guest_id); } catch (error) { toast(describeError(error)); }
    await load();
  }

  function preferenceBox(data: Lodging): HTMLElement {
    const state = el('p', { class: 'gfield-state', id: 'prefState', role: 'status' });
    const text = el('textarea', { id: 'prefText', rows: '2', maxlength: '200', disabled: ctx.readOnly() ? '' : null }, data.preference?.text ?? '') as HTMLTextAreaElement;
    const ground = el('input', { type: 'checkbox', id: 'prefGround', disabled: ctx.readOnly() ? '' : null, checked: data.preference?.ground_floor ? '' : null }) as HTMLInputElement;
    const send = async () => {
      state.textContent = t('save.saving');
      try {
        await ctx.reads.roomPreference(ctx.grant.guest_id, text.value.trim() || null, ground.checked);
        state.textContent = t('save.saved');
      } catch (error) {
        state.textContent = isNetworkError(error) ? t('lodging.prefOffline') : t('save.error');
      }
    };
    const later = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void send(); }, DEBOUNCE); };
    text.addEventListener('input', later);
    ground.addEventListener('change', () => void send());
    return fbIgnore(el('section', { class: 'card gcard', id: 'lodgingPreference', 'data-feedback-id': 'guests.alojamiento.preferencia.guardar', 'data-feedback-label': 'Preferencia de alojamiento' },
      el('h3', null, t('lodging.preferTitle')),
      el('div', { class: 'gfield' }, el('label', { for: 'prefText' }, t('lodging.preferWho')), text),
      el('label', { class: 'gswitch' }, ground, el('span', null, t('lodging.preferGround'))),
      el('p', { class: 'muted small' }, t('lodging.preferNote')),
      state));
  }

  function paint(data: Lodging, staleAt: string | null): void {
    const mine = data.mine
      ? el('section', { class: 'card gcard', id: 'lodgingMine' },
        el('h3', null, t('lodging.mine')),
        el('p', { class: 'glodging-room' }, icon('bed', 20), ' ', el('strong', null, data.mine.space_name), data.mine.zone ? ` · ${data.mine.zone}` : '', data.mine.bed_label ? ` · ${data.mine.bed_label}` : ''),
        data.mine.status === 'requested' ? el('p', { class: 'chip small', id: 'lodgingRequested' }, t('lodging.pending')) : null,
        (capability === 'choose' || capability === 'request') && open && !ctx.readOnly()
          ? el('button', { type: 'button', class: 'ghost small', id: 'lodgingRelease', 'data-feedback-id': 'guests.alojamiento.eleccion.soltar', 'data-feedback-label': 'Soltar mi elección', onclick: () => void release() }, t('lodging.release'))
          : null)
      : el('section', { class: 'card gcard muted', id: 'lodgingNone' }, t(capability === 'choose' || capability === 'request' ? 'lodging.noneChoose' : 'lodging.none'));

    let rooms: HTMLElement | null = null;
    if (capability === 'choose' || capability === 'request') {
      if (!open) {
        rooms = el('p', { class: 'banner', id: 'lodgingClosed' }, t('lodging.closedOn', { date: formatDate(config!.choose_until!) }));
      } else {
        const groups = new Map<string, Lodging['rooms']>();
        for (const room of data.rooms) groups.set(room.option_key ?? '', [...(groups.get(room.option_key ?? '') ?? []), room]);
        rooms = el('div', { id: 'lodgingRooms' },
          el('h3', null, capability === 'request' ? t('lodging.requestTitle') : t('lodging.chooseTitle')),
          config?.choose_until ? el('p', { class: 'muted small' }, t('lodging.until', { date: formatDate(config.choose_until) })) : null,
          ...[...groups].map(([key, list]) => {
            const option = options.get(key);
            return el('section', { class: 'glodging-option', dataset: { option: key } },
              option ? el('div', { class: 'glodging-head' }, el('strong', null, option.label), option.guest_note ? el('span', { class: 'muted small' }, option.guest_note) : null) : null,
              ...list.map((room) => el('article', { class: 'card gcard glodging-card', dataset: { space: room.space_id } },
                el('h4', null, room.name, room.zone ? el('span', { class: 'muted small' }, ` · ${room.zone}`) : null),
                el('p', { class: 'muted small' }, room.en_suite ? `${t('lodging.enSuite')} · ` : '', t('lodging.free', { free: room.beds_free, total: room.beds_total })),
                el('div', { class: 'glodging-beds' }, ...room.beds.map((bed) => el('button', {
                  type: 'button', class: bed.free ? 'ghost' : 'ghost taken', disabled: bed.free && !ctx.readOnly() ? null : '', dataset: { bed: bed.bed_id },
                  'data-feedback-id': 'guests.alojamiento.eleccion.elegir', 'data-feedback-label': 'Elegir cama',
                  onclick: () => void choose(bed.bed_id, room.name, bed.label),
                }, bed.label, ' · ', bed.free ? t('lodging.bedFree') : t('lodging.bedTaken')))))));
          }),
          data.rooms.length ? null : el('p', { class: 'muted', id: 'lodgingNoRooms' }, t('lodging.noRooms')));
      }
    }

    replace(main,
      staleAt ? staleNote(staleAt) : null,
      el('div', { class: 'pagehead' }, el('h2', null, t('lodging.title'))),
      mine,
      capability === 'prefer' ? preferenceBox(data) : null,
      rooms);
  }

  void load();
  return () => { alive = false; if (timer) clearTimeout(timer); };
}
