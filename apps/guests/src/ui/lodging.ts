/**
 * Alojamiento (API.md §13.7; Booking §23.1). Lo que puede hacer el huésped lo dicen los ajustes de Booking del retiro:
 * - siempre, «Tu habitación» si ya está asignada;
 * - con `preferences`, con quién le gustaría compartir y si necesita planta baja o accesible (se guarda solo);
 * - con `choice = 'choose'`, elige cama entre las habitaciones con baño abiertas, al momento;
 * - con `choice = 'request'`, igual, pero queda pendiente de que el organizador lo apruebe.
 * Elegir necesita red y es atómico en Booking: si otra persona coge la cama antes (`BED_TAKEN`), se dice y se recarga.
 * Nunca se ven nombres de otros huéspedes. Del suplemento, la nota que escribe el organizador para cada tipo de
 * habitación (decisión del usuario: solo camas ya contratadas; elegir no factura nada nuevo).
 */
import { confirmDialog, el, icon, replace, toast } from '@ikisai/ui-kit';
import type { GuestContext } from '../app/context.ts';
import { describeError, errorCode, isNetworkError, online } from '../app/client.ts';
import { formatDate, t } from '../app/i18n.ts';
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

export function mountLodging(main: HTMLElement, ctx: GuestContext): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const notes = new Map((ctx.experience()?.modules.lodging?.options ?? []).map((o) => [o.key, o]));

  async function load(): Promise<void> {
    replace(main, loading());
    try {
      const loaded = await ctx.reads.lodging(ctx.grant.guest_id);
      if (alive) paint(loaded?.value ?? { mine: null, preference: null, rooms: [] }, loaded?.stale ? loaded.at : null);
    } catch (error) {
      if (alive) replace(main, failure(error, () => void load()));
    }
  }

  async function choose(data: Lodging, bedId: string, roomName: string, bedLabel: string): Promise<void> {
    if (!online()) { toast(t('lodging.needsNetwork')); return; }
    const ok = await confirmDialog({
      title: t('lodging.confirmTitle'),
      text: data.choice === 'request' ? t('lodging.confirmRequest', { room: roomName, bed: bedLabel }) : t('lodging.confirmChoose', { room: roomName, bed: bedLabel }),
      confirmLabel: t('lodging.choose'),
    });
    if (!ok) return;
    try {
      const out = await ctx.reads.chooseBed(ctx.grant.guest_id, bedId);
      toast(out.status === 'requested' ? t('lodging.requested') : t('lodging.chosen'));
    } catch (error) {
      const code = errorCode(error);
      toast(code === 'BED_TAKEN' ? t('lodging.taken') : code === 'CHOICE_CLOSED' ? t('lodging.closed') : code === 'PREVIEW_READ_ONLY' ? t('preview.readOnly')
        : isNetworkError(error) ? t('lodging.needsNetwork') : describeError(error));
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
        state.textContent = isNetworkError(error) ? t('lodging.prefOffline') : errorCode(error) === 'PREVIEW_READ_ONLY' ? t('preview.readOnly') : t('save.error');
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
    const choosing = data.choice === 'choose' || data.choice === 'request';
    const open = choiceOpen(data);
    const mine = data.mine
      ? el('section', { class: 'card gcard', id: 'lodgingMine' },
        el('h3', null, t('lodging.mine')),
        el('p', { class: 'glodging-room' }, icon('bed', 20), ' ', el('strong', null, data.mine.space_name), data.mine.zone ? ` · ${data.mine.zone}` : '', data.mine.bed_label ? ` · ${data.mine.bed_label}` : ''),
        data.mine.status === 'requested' ? el('p', { class: 'chip small', id: 'lodgingRequested' }, t('lodging.pending')) : null,
        choosing && open && data.mine.source === 'guest' && !ctx.readOnly()
          ? el('button', { type: 'button', class: 'ghost small', id: 'lodgingRelease', 'data-feedback-id': 'guests.alojamiento.eleccion.soltar', 'data-feedback-label': 'Soltar mi elección', onclick: () => void release() }, t('lodging.release'))
          : null)
      : el('section', { class: 'card gcard muted', id: 'lodgingNone' }, t(choosing && open ? 'lodging.noneChoose' : 'lodging.none'));

    let rooms: HTMLElement | null = null;
    if (choosing) {
      if (!open) {
        rooms = data.choose_until ? el('p', { class: 'banner', id: 'lodgingClosed' }, t('lodging.closedOn', { date: formatDate(data.choose_until) })) : null;
      } else {
        const groups = new Map<string, Lodging['rooms']>();
        for (const room of data.rooms) groups.set(room.option_key ?? '', [...(groups.get(room.option_key ?? '') ?? []), room]);
        rooms = el('div', { id: 'lodgingRooms' },
          el('h3', null, data.choice === 'request' ? t('lodging.requestTitle') : t('lodging.chooseTitle')),
          data.choose_until ? el('p', { class: 'muted small' }, t('lodging.until', { date: formatDate(data.choose_until) })) : null,
          ...[...groups].map(([key, list]) => {
            // La nota es del organizador: por tipo de habitación o, en la forma de Organizers, una sola (`guest_price_text`).
            const option = notes.get(key) ?? notes.get('');
            const supplement = list.some((r) => r.supplement);
            return el('section', { class: 'glodging-option', dataset: { option: key } },
              option || supplement ? el('div', { class: 'glodging-head' },
                option?.label ? el('strong', null, option.label) : null,
                el('span', { class: 'muted small' }, option?.guest_note ?? (supplement ? t('lodging.supplement') : ''))) : null,
              ...list.map((room) => el('article', { class: 'card gcard glodging-card', dataset: { space: room.space_id } },
                el('h4', null, room.name, room.zone ? el('span', { class: 'muted small' }, ` · ${room.zone}`) : null),
                el('p', { class: 'muted small' }, room.en_suite ? `${t('lodging.enSuite')} · ` : '', t('lodging.free', { free: room.beds_free, total: room.beds_total })),
                el('div', { class: 'glodging-beds' }, ...room.beds.map((bed) => el('button', {
                  type: 'button', class: bed.mine ? 'primary' : bed.free ? 'ghost' : 'ghost taken', disabled: bed.free && !bed.mine && !ctx.readOnly() ? null : '', dataset: { bed: bed.bed_id },
                  'data-feedback-id': 'guests.alojamiento.eleccion.elegir', 'data-feedback-label': 'Elegir cama',
                  onclick: () => void choose(data, bed.bed_id, room.name, bed.label),
                }, bed.label, ' · ', bed.mine ? t('lodging.bedMine') : bed.free ? t('lodging.bedFree') : t('lodging.bedTaken')))))));
          }),
          data.rooms.length ? null : el('p', { class: 'muted', id: 'lodgingNoRooms' }, t('lodging.noRooms')));
      }
    }

    replace(main,
      staleAt ? staleNote(staleAt) : null,
      el('div', { class: 'pagehead' }, el('h2', null, t('lodging.title'))),
      mine,
      data.preferences ? preferenceBox(data) : null,
      rooms);
  }

  void load();
  return () => { alive = false; if (timer) clearTimeout(timer); };
}
