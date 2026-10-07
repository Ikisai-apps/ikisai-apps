/**
 * Alta y ficha de un asistente (API.md §9.4 y §9.5). Lo que escribió otra persona (el propio asistente o Ikisai) llega como
 * `true` y se muestra «Rellenado ✓», sin valor ni edición. Lo tecleado se guarda como borrador local hasta guardarlo.
 */
import { confirmDialog, el, icon, replace, toast } from '@ikisai/ui-kit';
import type { GuestList, PortalGuest, PortalLink, PortalRestriction, ReservationDetail } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { describeError, errorCode, online } from '../app/client.ts';
import {
  COUNTRIES, fieldsFor, RESTRICTION_HAS_SEVERITY, RESTRICTION_LABELS, RESTRICTION_NEEDS_SUBJECT, restrictionText, SEVERITY_LABELS, type FieldSpec,
} from '../app/labels.ts';
import { linkMessage, personReminder } from '../app/texts.ts';
import { commonText, textParagraphs } from '../app/common-texts.ts';
import { copyText, failure, fbIgnore, loading, staleNote } from './common.ts';
import { guestState, linksByGuest, linkText } from './guests.ts';
import { openShareSheet } from './share.ts';
import type { ViewContext, ViewMount } from './shell.ts';

interface Draft { guestId?: string; fields: Record<string, string>; restrictions?: PortalRestriction[] }

/** Enlaces emitidos en esta sesión: el recordatorio puede llevarlo mientras siga abierta la app. */
const issued = new Map<string, string>();

export const mountGuest = (reservationId: string, guestId: string): ViewMount => (ctx) => {
  const isNew = guestId === 'nuevo';
  const draftId = isNew ? `new:${reservationId}` : `guest:${guestId}`;
  let alive = true;
  const host = el('div', { id: isNew ? 'newGuest' : 'guestDetail' }, loading());
  replace(ctx.main,
    el('a', { class: 'backlink', href: `#/retiro/${reservationId}/asistentes`, id: 'backToGuests', 'data-feedback-id': 'organizers.asistente.cabecera.volver', 'data-feedback-label': 'Volver a asistentes' }, icon('chevronLeft', 16), 'Asistentes'),
    host);

  async function load(): Promise<void> {
    try {
      const [detail, guests] = await Promise.all([ctx.api.detail(reservationId), ctx.api.guests(reservationId)]);
      const links = isNew ? null : await ctx.api.links(reservationId).catch(() => null);
      const draft = await cache.draft<Draft>(ctx.userId, draftId);
      if (!alive) return;
      const stale = [detail, guests].find((x) => x.stale);
      if (isNew) return paintNew(detail.value, guests.value, draft, stale?.at ?? null);
      const guest = guests.value.items.find((g) => g.id === guestId);
      if (!guest) {
        replace(host, el('div', { class: 'empty' }, el('strong', null, 'Este asistente ya no está en la lista'), el('p', null, 'Puede que se haya dado de baja.')));
        return;
      }
      paintGuest(detail.value, guests.value, guest, linksByGuest(links?.value.items).get(guest.id), draft, stale?.at ?? null);
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }

  const saveDraft = (draft: Draft) => void cache.saveDraft(ctx.userId, draftId, draft);
  const dropDraft = () => cache.dropDraft(ctx.userId, draftId);

  /** Botones que necesitan red: se desactivan sin conexión y se reactivan al volver. */
  const needNet: HTMLButtonElement[] = [];
  const paintNet = () => { for (const b of needNet) b.disabled = !online() || b.dataset.busy === '1'; };
  window.addEventListener('online', paintNet);
  window.addEventListener('offline', paintNet);
  function netButton(attrs: Record<string, unknown>, label: string): HTMLButtonElement {
    const b = el('button', { type: 'button', ...attrs }, label) as HTMLButtonElement;
    needNet.push(b);
    return b;
  }
  async function busy<T>(button: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
    button.dataset.busy = '1'; paintNet();
    try { return await work(); } finally { button.dataset.busy = ''; paintNet(); }
  }

  interface Declaration { element: HTMLElement | null; needed(): boolean; checked(): boolean; show(focus?: boolean): void; hide(): void }
  function declarationBox(declared: boolean | undefined, onChecked?: () => void): Declaration {
    if (declared) return { element: null, needed: () => false, checked: () => false, show: () => undefined, hide: () => undefined };
    let needed = true;
    const input = el('input', { type: 'checkbox', id: 'declaration', onchange: () => { if (input.checked) onChecked?.(); } }) as HTMLInputElement;
    // Textos de Central (declaración y protección de datos); la versión aceptada viaja con la acción.
    const privacy = commonText('portal.privacy');
    const element = el('div', { class: 'card orgdeclaration', id: 'declarationBox', 'data-feedback-id': 'organizers.asistentes.declaracion.aceptar', 'data-feedback-label': 'Declaración' },
      el('label', { class: 'field check' }, input, el('span', { id: 'declarationText' }, commonText('organizers.declaration').body)),
      el('details', null, el('summary', null, 'Más información'),
        ...textParagraphs(privacy.body)));
    return {
      element,
      needed: () => needed,
      checked: () => input.checked,
      show: (focus = true) => { element.classList.add('attention'); if (focus) { element.scrollIntoView({ block: 'center' }); input.focus(); } },
      hide: () => { needed = false; element.remove(); },
    };
  }

  // --- Alta -----------------------------------------------------------------------------------------------------------
  function paintNew(detail: ReservationDetail, list: GuestList, draft: Draft | null, staleAt: string | null): void {
    document.title = `Añadir asistente · ${detail.title}`;
    if (!list.confirmed || list.mode === 'ninguno') {
      replace(host, el('div', { class: 'empty' }, el('strong', null, 'Aún no puedes añadir asistentes'), el('p', null, list.mode === 'ninguno' ? 'En este retiro no hace falta la lista de asistentes.' : 'Podrás añadir a tus asistentes cuando la reserva esté confirmada.')));
      return;
    }
    // El id del asistente nuevo se fija en el borrador: un reintento tras perder la respuesta no lo duplica (B3).
    const current: Draft = { guestId: draft?.guestId ?? crypto.randomUUID(), fields: { ...(draft?.fields ?? {}) } };
    saveDraft(current);
    const specs = fieldsFor(list.mode).filter((f) => ['first_name', 'last_name_1', 'phone', 'email'].includes(f.key));
    const inputs = specs.map((spec) => fieldInput(spec, current.fields[spec.key] ?? '', (value) => { current.fields[spec.key] = value; saveDraft(current); }));
    const declaration = declarationBox(list.declared);
    const error = el('p', { class: 'formerror', role: 'alert', id: 'newGuestError' });
    const save = netButton({ class: 'primary', id: 'saveNewGuest', 'data-feedback-id': 'organizers.asistentes.alta.guardar', 'data-feedback-label': 'Guardar asistente' }, 'Guardar');
    save.onclick = () => void busy(save, async () => {
      error.textContent = '';
      const fields = Object.fromEntries(Object.entries(current.fields).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      if (!fields.first_name) { error.textContent = 'Escribe al menos el nombre.'; return; }
      try {
        await ctx.usage.run('organizers.asistentes.alta.guardar', () => ctx.api.addGuest({ reservation_id: reservationId, guest_id: current.guestId!, fields, ...(declaration.checked() ? { declaration: true } : {}) }));
        await dropDraft();
        toast('Asistente añadido. Ahora puedes enviarle su enlace.');
        ctx.navigate(`#/retiro/${reservationId}/asistentes/${current.guestId}`, true);
      } catch (e) {
        if (errorCode(e) === 'DECLARATION_REQUIRED') declaration.show(true);
        error.textContent = describeError(e);
      }
    });
    replace(host,
      staleAt ? staleNote(staleAt) : null,
      el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Añadir asistente'), el('p', { class: 'muted' }, 'Con el nombre basta. El resto lo puedes completar después o dejar que lo haga cada asistente con su enlace.'))),
      fbIgnore(el('form', { class: 'card', id: 'newGuestForm', onsubmit: (e: Event) => { e.preventDefault(); save.click(); } }, ...inputs)),
      declaration.element, error, el('div', { class: 'btnrow' }, save));
    paintNet();
  }

  // --- Ficha ----------------------------------------------------------------------------------------------------------
  /**
   * Guardado automático (API.md §13.1): cada campo se envía al dejar de escribir (800 ms) o al salir de él, en un solo
   * envío a la vez que junta lo pendiente. Lo tecleado vive en el borrador local hasta que el servidor lo confirma.
   */
  function paintGuest(detail: ReservationDetail, list: GuestList, guest: PortalGuest, link: PortalLink | undefined, draft: Draft | null, staleAt: string | null): void {
    document.title = `${guest.display_name} · ${detail.title}`;
    detach?.();
    const specs = fieldsFor(list.mode);
    // Lo que escribió otra persona no se toca: si el borrador lo traía, se descarta (FIELD_OWNED_BY_GUEST).
    const pending: Draft = { fields: {}, restrictions: draft?.restrictions };
    for (const [key, value] of Object.entries(draft?.fields ?? {})) if (guest.fields[key] !== true) pending.fields[key] = value;
    const saved: Record<string, string> = {};
    for (const spec of specs) saved[spec.key] = typeof guest.fields[spec.key] === 'string' ? (guest.fields[spec.key] as string) : '';
    let revision = guest.revision;
    const ownRestrictions = guest.restrictions.filter((r) => r.source === 'organizer');
    const otherRestrictions = guest.restrictions.filter((r) => r.source !== 'organizer');
    let restrictions: PortalRestriction[] = pending.restrictions ?? ownRestrictions.map(({ restriction_type, subject, severity, kitchen_notes }) => ({ restriction_type, subject, severity, kitchen_notes }));
    let restrictionsDirty = pending.restrictions !== undefined;

    const stateHost = el('p', { class: 'orgsavestate', id: 'saveState', role: 'status', 'aria-live': 'polite' });
    function setState(kind: 'idle' | 'saving' | 'saved' | 'offline' | 'declaration' | 'error', message = ''): void {
      stateHost.dataset.state = kind;
      if (kind === 'idle') replace(stateHost);
      else if (kind === 'saving') replace(stateHost, 'Guardando…');
      else if (kind === 'saved') replace(stateHost, icon('check', 16), ' Guardado');
      else if (kind === 'offline') replace(stateHost, icon('offline', 16), ' Sin conexión · se guardará al recuperar la conexión');
      else if (kind === 'declaration') replace(stateHost, 'Marca la casilla de conformidad para guardar.');
      else replace(stateHost, `${message} `, el('button', { type: 'button', class: 'linkbtn', id: 'retrySave', onclick: () => void flush() }, 'Reintentar'));
    }

    const changedFields = (): Record<string, string | null> => {
      const out: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(pending.fields)) if (value.trim() !== (saved[key] ?? '').trim()) out[key] = value.trim() || null;
      return out;
    };
    const complete = (r: PortalRestriction) => !!r.restriction_type && (!RESTRICTION_NEEDS_SUBJECT.has(r.restriction_type) || !!(r.subject ?? '').trim());
    const cleanRestrictions = () => restrictions.filter(complete).map((r) => ({
      restriction_type: r.restriction_type, subject: (r.subject ?? '').trim() || null,
      severity: RESTRICTION_HAS_SEVERITY.has(r.restriction_type) ? r.severity : null, kitchen_notes: (r.kitchen_notes ?? '').trim() || null,
    }));
    const persist = () => {
      const hasFields = Object.keys(changedFields()).length > 0;
      if (!hasFields && !restrictionsDirty) void dropDraft();
      else saveDraft({ fields: pending.fields, ...(restrictionsDirty ? { restrictions } : {}) });
    };

    const declaration = declarationBox(list.declared, () => void flush());
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight: Promise<void> | null = null;
    let again = false;
    const schedule = (delay = 800) => { if (timer) clearTimeout(timer); timer = setTimeout(() => void flush(), delay); };

    function flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; }
      if (inflight) { again = true; return inflight; }
      inflight = (async () => {
        do { again = false; await saveOnce(true); } while (again && alive);
      })().finally(() => { inflight = null; });
      return inflight;
    }

    /** Relee el asistente: revisión nueva, estado y lo que ya es de otra persona. */
    async function refresh(): Promise<void> {
      const fresh = (await ctx.api.guests(reservationId)).value;
      const row = fresh.items.find((g) => g.id === guest.id);
      if (!row) return;
      revision = row.revision;
      Object.assign(guest, row);
      if (fresh.declared) declaration.hide();
      for (const key of Object.keys(pending.fields)) if (row.fields[key] === true) delete pending.fields[key];
      paintHeader();
    }

    async function saveOnce(retry: boolean): Promise<void> {
      const fields = changedFields();
      const items = restrictionsDirty ? cleanRestrictions() : null;
      if (!Object.keys(fields).length && !items) return;
      if (!online()) { setState('offline'); return; }
      if (declaration.needed() && !declaration.checked()) { setState('declaration'); declaration.show(false); return; }
      const decl = declaration.checked() ? { declaration: true } : {};
      setState('saving');
      try {
        if (Object.keys(fields).length) {
          await ctx.usage.run('organizers.asistente.ficha.guardar', () => ctx.api.updateGuest({ guest_id: guest.id, expectedRevision: revision, fields, ...decl }));
          for (const [key, value] of Object.entries(fields)) saved[key] = value ?? '';
        }
        if (items) {
          await ctx.usage.run('organizers.asistente.alimentacion.guardar', () => ctx.api.setRestrictions({ guest_id: guest.id, items, ...decl }));
          restrictionsDirty = false;
        }
        persist();
        await refresh().catch(() => undefined);
        setState(Object.keys(changedFields()).length || restrictionsDirty ? 'saving' : 'saved');
      } catch (e) {
        const code = errorCode(e);
        if (code === 'NETWORK' || code === 'BACKEND_UNAVAILABLE') { setState('offline'); return; }
        if (code === 'DECLARATION_REQUIRED') { setState('declaration'); declaration.show(true); return; }
        if (code === 'VERSION_CONFLICT' && retry) {
          // Otra persona (el huésped, Ikisai u otra pestaña) guardó antes: con la revisión nueva se reintenta una vez.
          await refresh().catch(() => undefined);
          return saveOnce(false);
        }
        if (code === 'FIELD_OWNED_BY_GUEST' || code === 'VERSION_CONFLICT') {
          toast(describeError(e, guest.display_name));
          await refresh().catch(() => undefined);
          persist();
          void load();
          return;
        }
        setState('error', describeError(e, guest.display_name));
      }
    }

    const groups = new Map<string, HTMLElement[]>();
    for (const spec of specs) {
      const value = guest.fields[spec.key];
      const row = value === true
        ? el('div', { class: 'field orgfilled', 'data-field': spec.key }, el('span', null, spec.label), el('p', null, icon('check', 16), ' Rellenado'))
        : fieldInput(spec, pending.fields[spec.key] ?? saved[spec.key] ?? '', (v) => { pending.fields[spec.key] = v; persist(); schedule(); });
      groups.set(spec.group, [...(groups.get(spec.group) ?? []), row]);
    }

    const restrictionsHost = el('div', { id: 'restrictions' });
    function paintRestrictions(): void {
      replace(restrictionsHost,
        otherRestrictions.length ? el('ul', { class: 'plainlist' }, ...otherRestrictions.map((r) => el('li', null, restrictionText(r), el('span', { class: 'muted small' }, r.source === 'guest' ? ` · indicado por ${guest.display_name}` : ' · indicado por Ikisai')))) : null,
        ...restrictions.map((r, index) => restrictionRow(r, (next) => {
          restrictions = next ? restrictions.map((x, i) => (i === index ? next : x)) : restrictions.filter((_, i) => i !== index);
          restrictionsDirty = true; persist();
          // Se guarda al quitar un requisito o cuando todos están completos (uno a medias no borra nada).
          if (!next) { paintRestrictions(); void flush(); } else if (restrictions.every(complete)) schedule();
        })),
        el('button', { type: 'button', class: 'ghost small', id: 'addRestriction', 'data-feedback-id': 'organizers.asistente.alimentacion.anadir', 'data-feedback-label': 'Añadir requisito', onclick: () => {
          restrictions = [...restrictions, { restriction_type: 'alergia', subject: '', severity: null, kitchen_notes: null }];
          paintRestrictions();
        } }, '+ Añadir alergia, intolerancia o dieta'),
        !guest.allergies_shared ? el('p', { class: 'muted small' }, `Si ${guest.display_name} indica sus propias alergias en su enlace, solo las verás si decide compartirlas contigo.`) : null);
    }
    paintRestrictions();

    const sendLink = netButton({ class: 'primary', id: 'sendLink', 'data-feedback-id': link ? 'organizers.asistente.ficha.reenviar_enlace' : 'organizers.asistente.ficha.enviar_enlace', 'data-feedback-label': link ? 'Reenviar enlace' : 'Enviar su enlace' }, link ? 'Reenviar enlace' : 'Enviar su enlace');
    sendLink.onclick = () => void busy(sendLink, async () => {
      if (link && !(await confirmDialog({ title: 'Reenviar enlace', text: `Se creará un enlace nuevo para ${guest.display_name} y el anterior dejará de funcionar.`, confirmLabel: 'Crear enlace nuevo' }))) return;
      try {
        await flush();
        const email = typeof guest.fields.email === 'string' ? guest.fields.email : null;
        const issue = () => ctx.api.issueGuestLink({ reservationId, guestId: guest.id, name: guest.display_name, email, replace: true });
        const out = link ? await ctx.usage.run('organizers.asistente.ficha.reenviar_enlace', issue) : await ctx.usage.run('organizers.asistente.ficha.enviar_enlace', issue);
        issued.set(guest.id, out.url);
        openShareSheet({ name: guest.display_name, text: linkMessage(guest.display_name, detail, out.url, list.mode), phone: typeof guest.fields.phone === 'string' ? guest.fields.phone : null });
        void load();
      } catch (e) {
        toast(describeError(e, guest.display_name));
      }
    });

    const remove = netButton({ class: 'ghost danger-text', id: 'removeGuest', 'data-feedback-id': 'organizers.asistente.ficha.baja', 'data-feedback-label': 'Dar de baja' }, 'Dar de baja');
    remove.onclick = () => void busy(remove, async () => {
      if (!(await confirmDialog({ title: `¿Dar de baja a ${guest.display_name}?`, text: 'Se quitará de este retiro y su enlace dejará de funcionar.', confirmLabel: 'Dar de baja', danger: true }))) return;
      try {
        if (timer) clearTimeout(timer);
        await ctx.usage.run('organizers.asistente.ficha.baja', () => ctx.api.removeGuest({ guest_id: guest.id, expectedRevision: revision }));
        await dropDraft();
        toast(`${guest.display_name} ya no está en la lista.`);
        ctx.navigate(`#/retiro/${reservationId}/asistentes`, true);
      } catch (e) {
        toast(describeError(e, guest.display_name));
        if (errorCode(e) === 'VERSION_CONFLICT') void load();
      }
    });

    const reminder = el('button', {
      type: 'button', class: 'ghost', id: 'personReminder', 'data-feedback-id': 'organizers.asistente.ficha.recordatorio', 'data-feedback-label': 'Copiar recordatorio',
      onclick: () => void ctx.usage.run('organizers.asistente.ficha.recordatorio', () => copyText(personReminder(guest.display_name, detail, guest.missing, list.mode === 'ses' && !guest.signed, issued.get(guest.id)), 'Recordatorio copiado.')),
    }, 'Copiar recordatorio');

    const header = el('div', { class: 'pagehead', 'data-feedback-id': 'organizers.asistente.cabecera', 'data-feedback-label': 'Cabecera del asistente' });
    function paintHeader(): void {
      const state = guestState(guest, list.mode);
      replace(header, el('div', null,
        el('h2', { id: 'guestName' }, guest.display_name),
        el('p', { class: 'chips' }, el('span', { class: `chip status ${state.tone}`, id: 'guestState' }, state.label), el('span', { class: 'muted small', id: 'guestStateDetail' }, ` ${state.detail}`)),
        el('p', { class: 'muted small', id: 'linkState' }, linkText(link))));
    }
    paintHeader();

    const form = el('form', { id: 'guestForm', onsubmit: (e: Event) => { e.preventDefault(); void flush(); } },
      ...[...groups].map(([group, rows], i) => {
        // Solo el primer bloque abierto; en los demás, el resumen dice si falta algo.
        const lacking = specs.some((s) => s.group === group && guest.missing.some((m) => m === s.key || (m === 'contact' && (s.key === 'phone' || s.key === 'email'))));
        return el('details', { class: 'card orggroup', open: i === 0 ? '' : null, 'data-group': group },
          el('summary', null, group, lacking ? el('span', { class: 'chip small warn' }, 'Falta algo') : el('span', { class: 'muted small' }, ' · completo')), ...rows);
      }),
      el('details', { class: 'card orggroup', open: '', 'data-group': 'Alimentación', 'data-feedback-id': 'organizers.asistente.alimentacion', 'data-feedback-label': 'Alimentación' },
        el('summary', null, 'Alimentación'), restrictionsHost));
    // Al salir de un campo con cambios se guarda ya, sin esperar.
    form.addEventListener('focusout', () => { if (timer) void flush(); });

    replace(host,
      staleAt ? staleNote(staleAt) : null,
      fbIgnore(header),
      el('div', { class: 'btnrow orgtools' }, sendLink, reminder),
      declaration.element,
      fbIgnore(form),
      list.mode === 'ses' ? el('p', { class: 'muted small', id: 'signatureNote' }, guest.signed ? `${guest.display_name} ya ha firmado el registro de viajeros.` : `La firma del registro de viajeros la hace ${guest.display_name} en su enlace o al llegar.`) : null,
      el('div', { class: 'orgsave' }, stateHost),
      el('div', { class: 'orgdanger' }, remove));
    paintNet();

    // Lo pendiente de la vez anterior (o de antes de perder la red) se envía solo.
    const resume = () => { if (Object.keys(changedFields()).length || restrictionsDirty) void flush(); };
    window.addEventListener('online', resume);
    detach = () => { window.removeEventListener('online', resume); if (timer) clearTimeout(timer); };
    leave = () => { window.removeEventListener('online', resume); if (timer) void flush(); };
    if (draft && (Object.keys(changedFields()).length || restrictionsDirty)) { setState('saving'); resume(); }
  }

  /** Al salir de la pantalla: enviar lo pendiente. `detach` solo suelta las escuchas al repintar la ficha. */
  let leave: (() => void) | null = null;
  let detach: (() => void) | null = null;
  void load();
  return () => {
    leave?.();
    alive = false;
    window.removeEventListener('online', paintNet);
    window.removeEventListener('offline', paintNet);
  };
};

/** Un campo editable del formulario. `onInput` recibe el valor como texto. */
function fieldInput(spec: FieldSpec, value: string, onInput: (value: string) => void): HTMLElement {
  const id = `f-${spec.key}`;
  let control: HTMLElement;
  if (spec.type === 'select') {
    control = el('select', { id, onchange: (e: Event) => onInput((e.target as HTMLSelectElement).value) },
      el('option', { value: '' }, '—'), ...(spec.options ?? []).map(([v, label]) => el('option', { value: v, selected: v === value ? '' : null }, label)));
  } else if (spec.type === 'country') {
    const known = COUNTRIES.some(([code]) => code === value);
    const other = el('input', { type: 'text', id: `${id}-other`, maxlength: '3', placeholder: 'Código de tres letras (p. ej. JPN)', hidden: !value || known ? true : null, value: known ? '' : value,
      oninput: (e: Event) => onInput((e.target as HTMLInputElement).value.toUpperCase()) }) as HTMLInputElement;
    const select = el('select', { id, onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      other.hidden = v !== 'otro';
      if (v !== 'otro') onInput(v); else other.focus();
    } }, el('option', { value: '' }, '—'), ...COUNTRIES.map(([code, label]) => el('option', { value: code, selected: code === value ? '' : null }, label)), el('option', { value: 'otro', selected: value && !known ? '' : null }, 'Otro país'));
    control = el('div', { class: 'orgcountry' }, select, other);
  } else {
    control = el('input', { id, type: spec.type, value, autocomplete: 'off', oninput: (e: Event) => onInput((e.target as HTMLInputElement).value) });
  }
  return el('label', { class: 'field', 'data-field': spec.key, for: id }, el('span', null, spec.label), control, spec.hint ? el('span', { class: 'hint' }, spec.hint) : null);
}

/** Fila de una restricción del organizador: tipo, a qué, gravedad (alergias e intolerancias) y nota para cocina. */
function restrictionRow(r: PortalRestriction, onChange: (next: PortalRestriction | null) => void): HTMLElement {
  let current = { ...r };
  const subject = el('input', { type: 'text', placeholder: 'A qué (p. ej. frutos secos)', value: current.subject ?? '', class: 'r-subject',
    oninput: (e: Event) => { current = { ...current, subject: (e.target as HTMLInputElement).value }; onChange(current); } }) as HTMLInputElement;
  const severity = el('select', { class: 'r-severity', onchange: (e: Event) => { current = { ...current, severity: (e.target as HTMLSelectElement).value || null }; onChange(current); } },
    el('option', { value: '' }, 'Gravedad'), ...Object.entries(SEVERITY_LABELS).map(([v, label]) => el('option', { value: v, selected: v === current.severity ? '' : null }, label))) as HTMLSelectElement;
  const notes = el('input', { type: 'text', placeholder: 'Nota para cocina (opcional)', value: current.kitchen_notes ?? '', class: 'r-notes',
    oninput: (e: Event) => { current = { ...current, kitchen_notes: (e.target as HTMLInputElement).value }; onChange(current); } });
  const sync = () => {
    subject.hidden = current.restriction_type !== 'otra' && !RESTRICTION_NEEDS_SUBJECT.has(current.restriction_type) && current.restriction_type !== 'preferencia';
    subject.placeholder = current.restriction_type === 'otra' || current.restriction_type === 'preferencia' ? 'Cuál (p. ej. sin cebolla)' : 'A qué (p. ej. frutos secos)';
    severity.hidden = !RESTRICTION_HAS_SEVERITY.has(current.restriction_type);
  };
  const type = el('select', { class: 'r-type', 'aria-label': 'Tipo', onchange: (e: Event) => { current = { ...current, restriction_type: (e.target as HTMLSelectElement).value }; sync(); onChange(current); } },
    ...Object.entries(RESTRICTION_LABELS).map(([v, label]) => el('option', { value: v, selected: v === current.restriction_type ? '' : null }, label)));
  sync();
  return el('div', { class: 'orgrestriction' }, type, subject, severity, notes,
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Quitar', onclick: () => onChange(null) }, icon('trash', 16)));
}
