/**
 * «Ayuda y sugerencias» (API.md §9.8; MUELA-054 con su adenda y el consolidado 071, tanda 31): una hoja con, de arriba
 * abajo, «¿Urgente?» con el teléfono (siempre), y tres bloques en el orden de VG: **Tu retiro** (tarjetas grandes con
 * icono: Horarios, Organización, Actividades, Comunicación, Comida, Otra cosa; para tu organizador), **Un sitio** (para el
 * equipo de Ikisai: el sitio, con «Mi habitación» ya elegida si hay retiro, y qué pasa en seis tarjetas, las urgentes con
 * «Si hay peligro, llama ya») y **La app** («Algo no funciona» o «Tengo una sugerencia», con «Señalar en la pantalla», que
 * aparta la hoja). Al elegir, el texto, las fotos (hasta 3) y «Enviar» van en ese bloque, con a quién llega.
 * Debajo, **«Lo que me has enviado»**, con su estado escrito (071: Recibido, En marcha, «✓ Resuelto», «✕ No lo vamos a
 * hacer», nunca en verde) y la respuesta escrita cuando la haya.
 * Mientras no haya plano de zonas ni `space_id` en el aviso, el sitio se elige en tarjetas y viaja como texto delante del
 * mensaje («[Mi habitación] …»), como hasta ahora. Sin retiro, no sale «Tu retiro» ni se envía ámbito.
 * El aviso lleva `id` y `requestId` estables por envío: un doble toque o un reintento no crean otro. Sin red, se queda en
 * el dispositivo y se envía solo («Pendiente de enviar»).
 */
import type { SyncClient } from '@ikisai/sync-client';
import {
  captureFeedbackTarget, collectFeedbackContext, compressImage, createFeedbackClient, el, fieldAttrs, icon, openSheet, replace, toast,
  type FeedbackImage, type FeedbackIntent, type FeedbackReport, type FeedbackSubject, type IconName,
} from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { contactPhone } from '../app/common-texts.ts';
import type { Grant } from '../app/api.ts';
import { formatDate, t } from '../app/i18n.ts';
import type { PortalPlans, PortalReads } from '../app/portal.ts';
import { loadPlans, portalMap } from './plan.ts';

export interface HelpOptions {
  client: SyncClient;
  userId: string;
  /** Persona y retiro en pantalla (ámbito del reporte). */
  grant: Grant | null;
  /** `place`: «Necesito ayuda» (título de la hoja); `event`: «Cuéntanos qué tal» (después del retiro). */
  start?: 'place' | 'event';
  /** Para «Tócalo en el plano» (mapa de zonas, MUELA-054 y 024); sin ellas, solo las baldosas. */
  reads?: PortalReads | null;
}

/** Respuestas del formulario (forma de siempre, para `reportShape`). */
export interface HelpAnswers { about?: 'application' | 'event' | 'space'; appKind?: 'bug' | 'improvement'; eventCat?: string; place?: string; spaceKind?: string;
  /** Elegido en el plano (`place = 'mapa'`): el espacio de Recursos y su nombre público. */
  spaceId?: string; spaceName?: string }

const EVENT: Array<[string, IconName]> = [['schedule', 'history'], ['organization', 'people'], ['activities', 'sun'], ['communication', 'info'], ['food', 'chef'], ['other', 'more']];
const PLACES: Array<[string, IconName]> = [['habitacion', 'bed'], ['comedor', 'chef'], ['sala', 'home'], ['banos', 'info'], ['exterior', 'sun'], ['piscina', 'pin'], ['otro', 'pin']];
const KINDS: Array<[string, IconName, boolean]> = [['damage', 'settings', false], ['cleaning', 'sync', false], ['missing', 'plus', false], ['utilities', 'warn', true], ['safety', 'lock', true], ['other', 'more', false]];
const PLACE_ES: Record<string, string> = { habitacion: 'Mi habitación', comedor: 'Comedor', sala: 'Sala', banos: 'Baños', exterior: 'Exterior', piscina: 'Piscina', otro: 'Otro sitio' };
const MAX_IMAGES = 3;

/** Lo que el servidor necesita de cada rama (FEEDBACK.md §7: subject, intent, category, scope). */
export function reportShape(answers: HelpAnswers, grant: Grant | null): { subject: FeedbackSubject; intent: FeedbackIntent; category?: string; scope?: Record<string, string>; place?: string } {
  const scope = grant ? { reservation_id: grant.reservation_id, guest_id: grant.guest_id } : undefined;
  if (answers.about === 'event') return { subject: 'event', intent: answers.eventCat === 'other' ? 'suggestion' : 'problem', category: answers.eventCat, scope };
  if (answers.about === 'space') {
    // Elegido en el plano: el aviso lleva el espacio de Recursos (`scope.space_id`) y su nombre, en texto, como siempre.
    const fromMap = answers.place === 'mapa' && answers.spaceId;
    return { subject: 'space', intent: 'problem', category: answers.spaceKind, scope: fromMap && scope ? { ...scope, space_id: answers.spaceId! } : scope,
      place: fromMap ? answers.spaceName : PLACE_ES[answers.place ?? ''] };
  }
  return { subject: 'application', intent: answers.appKind === 'improvement' ? 'improvement' : 'bug' };
}

/** Estado en palabras (071, acordado con Tasks): `dismissed` nunca en verde ni «Resuelto». */
const STATUS: Record<string, string> = { open: 'help.status.open', in_progress: 'help.status.progress', pending_verify: 'help.status.done', verified: 'help.status.done', dismissed: 'help.status.dismissed' };

export function openHelp(options: HelpOptions): void {
  const { client, userId, grant } = options;
  const api = client.api.bind(client);
  const reports = createFeedbackClient({ api, app: 'guests', userId: () => userId });
  const phone = contactPhone();
  const tel = phone ? `tel:${phone.replace(/\s+/g, '')}` : null;
  const answers: HelpAnswers = { place: grant ? 'habitacion' : undefined };
  let images: FeedbackImage[] = [];
  let attempt: { id: string; requestId: string; key: string } | null = null;
  let submitting = false;
  let signalled: { id: string; path: string[] } | null = null;
  let uid = 0;
  const mine = el('section', { class: 'ghelp-mine', id: 'helpMine', 'data-feedback-id': 'guests.ayuda.enviados', 'data-feedback-label': 'Lo que me has enviado' });

  const eventBlock = el('section', { class: 'ghelp-block', id: 'blockEvent' });
  const spaceBlock = el('section', { class: 'ghelp-block', id: 'blockSpace' });
  // «Tócalo en el plano»: el mapa de zonas, si hay; se crea una vez y se conserva al repintar (abierto o cerrado).
  const HELP_KINDS = new Set(['habitacion', 'sala', 'bano', 'comedor', 'exterior', 'zona_paso', 'otro']);
  let planData: PortalPlans | null = null;
  let planBox: HTMLDetailsElement | null = null;
  let helpMap: ReturnType<typeof portalMap> | null = null;
  if (options.reads) void loadPlans(options.reads).then((loaded) => {
    if (!loaded?.value.plans.length || !loaded.value.spaces.some((s) => HELP_KINDS.has(s.kind))) return;
    planData = loaded.value;
    paint();
  });
  function planPicker(): HTMLDetailsElement {
    if (planBox) { helpMap?.select(answers.place === 'mapa' ? answers.spaceId ?? null : null); return planBox; }
    const inner = el('div', { class: 'ghelp-planbox' });
    planBox = el('details', { class: 'gplan ghelp-plan', id: 'helpPlan', 'data-feedback-id': 'guests.ayuda.sitio.plano', 'data-feedback-label': 'Tócalo en el plano' },
      el('summary', null, icon('pin', 16), el('span', { class: 'gplan-label' }, t('help.onPlan')), el('span', { class: 'gplan-hint' }, t('plan.see'))), inner) as HTMLDetailsElement;
    planBox.addEventListener('toggle', () => {
      if (!planBox!.open || helpMap) return;
      helpMap = portalMap(planData!, {
        mode: 'map', label: t('help.planLabel'), feedbackId: 'guests.ayuda.sitio.mapa',
        filter: (s) => HELP_KINDS.has(s.kind),
        selected: answers.place === 'mapa' ? answers.spaceId ?? null : null,
        onPick: (s) => {
          Object.assign(answers, { place: 'mapa', spaceId: s.id, spaceName: s.publicName ?? s.name, spaceKind: undefined });
          if (answers.about === 'space') answers.about = undefined;
          paint('kind');
        },
      });
      replace(inner, helpMap.element);
    });
    return planBox;
  }
  const appBlock = el('section', { class: 'ghelp-block', id: 'blockApp' });
  const message = el('textarea', { id: 'helpText', rows: '3', maxlength: '4000', 'aria-label': t('help.message'), placeholder: t('help.placeholder'), 'data-feedback-ignore': '', ...fieldAttrs({ id: 'guests.ayuda.mensaje', type: 'text', required: true, sensitivity: 'personal' }) }) as HTMLTextAreaElement;
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: '', hidden: true, onchange: () => void addImages(), ...fieldAttrs({ id: 'guests.ayuda.fotos', type: 'file', required: false, sensitivity: 'personal' }) }) as HTMLInputElement;
  const photos = el('div', { class: 'ghelp-photos' });

  async function addImages(): Promise<void> {
    for (const file of Array.from(fileInput.files ?? []).slice(0, MAX_IMAGES - images.length)) {
      try { const c = await compressImage(file, { thumbSide: 0 }); images = [...images, { id: `gimg-${Date.now()}-${uid++}`, blob: c.full, mime: c.mime, filename: c.filename }]; } catch { /* ilegible: se ignora */ }
    }
    fileInput.value = '';
    paintPhotos();
  }
  function paintPhotos(): void {
    replace(photos, ...images.map((img) => el('span', { class: 'chip small' }, img.filename ?? t('help.photo'),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': t('help.removePhoto'), onclick: () => { images = images.filter((x) => x.id !== img.id); paintPhotos(); } }, icon('close', 14)))));
  }

  /** Redactar, dentro del bloque elegido: a quién llega, el texto, las fotos y «Enviar». */
  function compose(): HTMLElement {
    const toOrganizer = answers.about === 'event';
    const status = el('p', { class: 'small ghelp-status', role: 'status', 'aria-live': 'polite' });
    const send = el('button', { type: 'button', class: 'primary', id: 'helpSend', 'data-feedback-id': 'guests.ayuda.formulario.enviar', 'data-feedback-label': 'Enviar' }, t('help.send')) as HTMLButtonElement;
    send.addEventListener('click', () => void submit(send, status));
    return el('div', { class: 'ghelp-compose' },
      el('p', { class: 'ghelp-who', id: 'helpWho' }, icon(toOrganizer ? 'people' : 'guest', 18), ' ', t('help.to'), ' ', el('strong', null, toOrganizer ? t('help.toOrganizer') : t('help.toIkisai'))),
      message, photos, fileInput, status,
      el('div', { class: 'ghelp-btns' },
        el('button', { type: 'button', class: 'ghost', id: 'helpPhoto', 'data-feedback-id': 'guests.ayuda.formulario.foto', 'data-feedback-label': 'Añadir una foto', onclick: () => { if (images.length < MAX_IMAGES) fileInput.click(); } }, icon('camera', 18), t('help.photo')),
        send));
  }

  async function submit(send: HTMLButtonElement, status: HTMLElement): Promise<void> {
    if (submitting) return;
    const text = message.value.trim();
    if (!text) { status.textContent = t('help.writeFirst'); message.focus(); return; }
    submitting = true;
    send.disabled = true;
    status.textContent = t('help.sending');
    try {
      const shape = reportShape(answers, grant);
      const node = signalled ?? { id: 'guests.ayuda', path: ['Ayuda y sugerencias'] };
      // `id` y `requestId` estables por contenido: un doble toque o un reintento no crean otro aviso.
      const key = JSON.stringify([answers, text, images.map((i) => i.id)]);
      if (attempt && attempt.key !== key) attempt = null;
      attempt ??= { id: crypto.randomUUID(), requestId: crypto.randomUUID(), key };
      await reports.enqueue({
        id: attempt.id, requestId: attempt.requestId, userId, app: 'guests', nodeId: node.id, nodePath: node.path,
        message: shape.place ? `[${shape.place}] ${text}` : text,
        intent: shape.intent, subject: shape.subject, images, updatedAt: new Date().toISOString(),
        context: await collectFeedbackContext({ app: 'guests', node: { id: node.id, path: node.path, element: null }, role: 'editor' }),
        ...(shape.scope ? { scope: shape.scope } : {}), ...(shape.category ? { category: shape.category } : {}),
        attempts: 0,
      });
      await reports.flush().catch(() => undefined);
      const pending = (await reports.pending()).some((item) => item.id === attempt!.id);
      toast(pending ? t('help.sentPending') : t('help.sent'));
      // La hoja vuelve al estado de partida y el aviso sale arriba de «Lo que me has enviado».
      message.value = '';
      images = [];
      attempt = null;
      signalled = null;
      Object.assign(answers, { about: undefined, appKind: undefined, eventCat: undefined, spaceKind: undefined, spaceId: undefined, spaceName: undefined, place: grant ? 'habitacion' : undefined });
      paint();
      void paintMine(pending ? text : null);
    } catch (error) {
      status.textContent = describeError(error);
      send.disabled = false;
    } finally {
      submitting = false;
    }
  }

  const card = (pressed: boolean, cls: 'ghelp-card' | 'ghelp-tile', ic: IconName, label: string, onclick: () => void, extra: Record<string, string> = {}, urgent = false) => el('button', {
    type: 'button', class: `${cls}${urgent ? ' urgent' : ''}${pressed ? ' on' : ''}`, 'aria-pressed': String(pressed), onclick, ...extra,
  }, el('span', { class: `${cls}-ico`, 'aria-hidden': 'true' }, icon(ic, cls === 'ghelp-card' ? 26 : 22)), el('span', { class: `${cls}-l` }, label));

  function paint(focus?: 'text' | 'kind'): void {
    // Tu retiro.
    replace(eventBlock, ...(grant ? [
      el('h3', null, icon('calendar', 20), ' ', t('help.retreat')),
      el('div', { class: 'ghelp-cards', role: 'group', 'aria-label': t('help.eventCat'), 'data-feedback-id': 'guests.ayuda.retiro.elegir', 'data-feedback-label': 'Sobre qué parte del retiro' },
        ...EVENT.map(([v, ic]) => card(answers.about === 'event' && answers.eventCat === v, 'ghelp-card', ic, t(`help.event.${v}`), () => { Object.assign(answers, { about: 'event', eventCat: v }); paint('text'); }, { 'data-value': v }))),
      answers.about === 'event' ? compose() : null,
    ] : []));
    // Un sitio: el sitio (tu habitación de entrada) y qué pasa.
    const kind = KINDS.find(([v]) => v === answers.spaceKind);
    replace(spaceBlock,
      el('h3', null, icon('pin', 20), ' ', t('help.space')),
      el('div', { class: 'ghelp-tiles', role: 'group', 'aria-label': t('help.where'), 'data-feedback-id': 'guests.ayuda.sitio.elegir', 'data-feedback-label': 'Elegir el sitio' },
        ...PLACES.filter(([v]) => grant || v !== 'habitacion').map(([v, ic]) => card(answers.place === v, 'ghelp-tile', ic, t(`help.place.${v}`), () => { Object.assign(answers, { place: v, spaceId: undefined, spaceName: undefined }); if (answers.about === 'space') answers.about = undefined; answers.spaceKind = undefined; paint('kind'); }, { 'data-value': v }))),
      planData ? planPicker() : null,
      answers.place === 'mapa' && answers.spaceName ? el('p', { class: 'ghelp-picked', id: 'helpPicked', role: 'status' }, icon('pin', 16), ' ', t('help.picked', { name: answers.spaceName })) : null,
      answers.place ? el('div', { class: 'ghelp-tiles ghelp-kinds', role: 'group', 'aria-label': t('help.spaceKind'), 'data-feedback-id': 'guests.ayuda.sitio.que_pasa', 'data-feedback-label': 'Qué pasa' },
        ...KINDS.map(([v, ic, urgent]) => {
          const b = card(answers.about === 'space' && answers.spaceKind === v, 'ghelp-tile', ic, t(`help.kindShort.${v}`), () => { Object.assign(answers, { about: 'space', spaceKind: v }); paint('text'); }, { 'data-value': v }, urgent);
          if (urgent) b.append(el('span', { class: 'ghelp-flag', 'aria-label': t('help.urgentFlag') }, icon('warn', 14)));
          return b;
        })) : null,
      answers.about === 'space' && kind?.[2] && tel ? el('p', { class: 'ghelp-urgentnote', id: 'helpUrgentKind' }, icon('warn', 18), ' ', t('help.dangerCall'), ' ',
        el('a', { class: 'primary small', href: tel, 'data-feedback-id': 'guests.ayuda.urgente.llamar_ya', 'data-feedback-label': 'Llamar ya' }, t('help.call'))) : null,
      answers.about === 'space' ? compose() : null);
    // La app: qué pasa y señalar en la pantalla.
    replace(appBlock,
      el('h3', null, icon('grid', 20), ' ', t('help.app')),
      el('div', { class: 'ghelp-cards', role: 'group', 'aria-label': t('help.what'), 'data-feedback-id': 'guests.ayuda.app.elegir', 'data-feedback-label': 'Qué pasa con la app' },
        card(answers.about === 'application' && answers.appKind === 'bug', 'ghelp-card', 'warn', t('help.bug'), () => { Object.assign(answers, { about: 'application', appKind: 'bug' }); paint('text'); }, { 'data-value': 'bug' }),
        card(answers.about === 'application' && answers.appKind === 'improvement', 'ghelp-card', 'star', t('help.idea'), () => { Object.assign(answers, { about: 'application', appKind: 'improvement' }); paint('text'); }, { 'data-value': 'improvement' })),
      answers.about === 'application' ? el('div', { class: 'ghelp-signal' },
        el('button', { type: 'button', class: 'ghost', 'data-feedback-id': 'guests.ayuda.app.senalar', 'data-feedback-label': 'Señalar en la pantalla', onclick: () => void signal() }, icon('eye', 18), t('help.signalAction')),
        signalled ? el('span', { class: 'small' }, icon('check', 14), ' ', signalled.path.join(' › ')) : null) : null,
      answers.about === 'application' ? compose() : null);
    if (focus === 'text') message.focus();
    if (focus === 'kind') (spaceBlock.querySelector('.ghelp-kinds button') as HTMLElement | null)?.focus();
  }

  /** «Señalar en la pantalla»: la hoja se aparta mientras se toca la parte de la app de la que se habla. */
  async function signal(): Promise<void> {
    sheet.element.classList.add('ghelp-away');
    try {
      const node = await captureFeedbackTarget({ text: t('help.signal'), delay: 0, fallbackNode: () => ({ id: 'guests.ayuda', path: ['Ayuda y sugerencias'] }) });
      if (node && typeof node === 'object' && 'id' in node) signalled = { id: node.id, path: node.path };
    } finally {
      sheet.element.classList.remove('ghelp-away');
      paint('text');
    }
  }

  async function paintMine(pendingText: string | null = null): Promise<void> {
    try {
      const out = await client.api<{ items: Array<FeedbackReport & { category?: string | null; reply?: { text: string; from?: string | null; at?: string | null } | null }> }>('/feedback?mine=true&status=all&limit=20');
      const items = out.items;
      const head = (r: (typeof items)[number]) => {
        const place = /^\[([^\]]+)\] /.exec(r.message)?.[1];
        if (r.subject === 'space') return [place, r.category ? t(`help.kind.${r.category}`) : null].filter(Boolean).join(' · ');
        if (r.subject === 'event') return [t('help.retreat'), r.category ? t(`help.event.${r.category}`) : null].filter(Boolean).join(' · ');
        return t('help.appTitle');
      };
      if (!items.length && !pendingText) { replace(mine); return; }
      replace(mine, el('h3', null, t('help.mine')), el('ul', { class: 'ghelp-sent' },
        pendingText ? el('li', { class: 'ghelp-sent-row' }, el('p', { class: 'ghelp-sent-head' }, el('span', { class: 'ghelp-st st-pending' }, t('help.status.pending'))),
          el('p', { class: 'ghelp-sent-msg', 'data-feedback-ignore': '' }, pendingText)) : null,
        ...items.map((r) => {
          const status = r.display || r.status;
          return el('li', { class: 'ghelp-sent-row' },
            el('p', { class: 'ghelp-sent-head' }, el('strong', null, head(r)), ' ', el('span', { class: `ghelp-st st-${status}` }, t(STATUS[status] ?? 'help.status.open'))),
            el('p', { class: 'ghelp-sent-msg', 'data-feedback-ignore': '' }, r.message.replace(/^\[[^\]]+\] /, '').slice(0, 240)),
            r.createdAt ? el('p', { class: 'small' }, formatDate(r.createdAt, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : null,
            r.reply?.text ? el('div', { class: 'ghelp-reply' }, el('p', { class: 'small' }, [r.reply.from, r.reply.at ? formatDate(r.reply.at, { day: 'numeric', month: 'short' }) : null].filter(Boolean).join(' · ')),
              el('p', { 'data-feedback-ignore': '' }, r.reply.text)) : null);
        })));
    } catch (error) {
      replace(mine, el('p', { class: 'small' }, describeError(error)));
    }
  }

  const sheet = openSheet({
    title: options.start === 'place' ? t('home.needHelp') : t('home.help'),
    body: el('div', { id: 'helpSheet', class: 'ghelp' },
      el('div', { class: 'ghelp-urgent', id: 'helpUrgent' },
        el('span', null, icon('warn', 18), ' ', t('help.urgentQ')),
        tel ? el('a', { class: 'primary', href: tel, id: 'helpCall', 'aria-label': t('help.callLabel', { phone }), 'data-feedback-id': 'guests.ayuda.urgente.llamar', 'data-feedback-label': 'Llamar a Ikisai' }, phone) : null),
      eventBlock, spaceBlock, appBlock, mine),
    onClose: () => reports.destroy(),
  });
  paint();
  void paintMine();
}
