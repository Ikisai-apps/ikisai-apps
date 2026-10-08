/**
 * «Ayuda y sugerencias» (API.md §9.8; especificación de feedback §3.2 y §4): formulario por pasos del kit con tres ramas
 * (la aplicación, mi retiro, un espacio) y debajo «Lo que me has enviado». «Mi retiro» va al organizador (mientras
 * Organizers no tenga su bandeja, lo ve el personal de Booking); un espacio va a Ikisai y acaba en Tasks.
 * «Necesito ayuda» abre directamente la rama del espacio, con el teléfono encima para lo urgente.
 */
import type { SyncClient } from '@ikisai/sync-client';
import {
  collectFeedbackContext, createFeedbackClient, createFeedbackProgressiveForm, el, icon, openSheet, replace,
  type FeedbackIntent, type FeedbackReport, type FeedbackSubject, type ProgressiveAnswers, type ProgressiveStep,
} from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { contactPhone } from '../app/common-texts.ts';
import type { Grant } from '../app/api.ts';
import { t } from '../app/i18n.ts';

export interface HelpOptions {
  client: SyncClient;
  userId: string;
  /** Persona y retiro en pantalla (ámbito del reporte). */
  grant: Grant | null;
  /** `place`: «Necesito ayuda» (directo al espacio); `event`: «Cuéntanos qué tal» (después del retiro). */
  start?: 'place' | 'event';
}

function steps(): ProgressiveStep[] {
  return [
    { id: 'about', kind: 'choice', question: t('help.about'), options: [
      { value: 'application', label: t('help.app'), next: 'appKind' },
      { value: 'event', label: t('help.retreat'), next: 'eventCat' },
      { value: 'space', label: t('help.space'), next: 'place' },
    ] },
    { id: 'appKind', kind: 'choice', question: t('help.what'), options: [{ value: 'bug', label: t('help.bug') }, { value: 'improvement', label: t('help.idea') }], next: 'appWhere' },
    { id: 'appWhere', kind: 'signal', question: t('help.signal'), action: t('help.signalAction'), next: 'message' },
    { id: 'eventCat', kind: 'choice', question: t('help.eventCat'), options: ['schedule', 'organization', 'activities', 'communication', 'food', 'other'].map((v) => ({ value: v, label: t(`help.event.${v}`) })), next: 'message' },
    { id: 'place', kind: 'choice', question: t('help.where'), options: ['habitacion', 'comedor', 'sala', 'banos', 'exterior', 'piscina', 'otro'].map((v) => ({ value: v, label: t(`help.place.${v}`) })), next: 'spaceKind' },
    { id: 'spaceKind', kind: 'choice', question: t('help.spaceKind'), options: ['damage', 'cleaning', 'missing', 'utilities', 'safety', 'other'].map((v) => ({ value: v, label: t(`help.kind.${v}`) })), next: 'message' },
    { id: 'message', kind: 'text', question: t('help.message'), placeholder: t('help.placeholder'), images: true },
  ];
}

const PLACE_ES: Record<string, string> = { habitacion: 'Mi habitación', comedor: 'Comedor', sala: 'Sala', banos: 'Baños', exterior: 'Exterior', piscina: 'Piscina', otro: 'Otro sitio' };

/** Lo que el servidor necesita de cada rama (FEEDBACK.md §7: subject, intent, category, scope). */
export function reportShape(answers: ProgressiveAnswers, grant: Grant | null): { subject: FeedbackSubject; intent: FeedbackIntent; category?: string; scope?: Record<string, string>; place?: string } {
  const scope = grant ? { reservation_id: grant.reservation_id, guest_id: grant.guest_id } : undefined;
  if (answers.about === 'event') return { subject: 'event', intent: answers.eventCat === 'other' ? 'suggestion' : 'problem', category: answers.eventCat, scope };
  if (answers.about === 'space') return { subject: 'space', intent: 'problem', category: answers.spaceKind, scope, place: PLACE_ES[answers.place ?? ''] };
  return { subject: 'application', intent: answers.appKind === 'improvement' ? 'improvement' : 'bug' };
}

const DISPLAY: Record<string, string> = { open: 'help.status.open', in_progress: 'help.status.progress', pending_verify: 'help.status.done', verified: 'help.status.done', dismissed: 'help.status.closed' };

export function openHelp(options: HelpOptions): void {
  const { client, userId, grant } = options;
  const api = client.api.bind(client);
  const reports = createFeedbackClient({ api, app: 'guests', userId: () => userId });
  const mine = el('div', { id: 'helpMine', 'data-feedback-id': 'guests.ayuda.enviados', 'data-feedback-label': 'Lo que me has enviado' });
  const phone = contactPhone();
  const known: ProgressiveAnswers | undefined = options.start === 'place' ? { about: 'space' } : options.start === 'event' ? { about: 'event' } : undefined;

  const form = createFeedbackProgressiveForm({
    config: { start: 'about', steps: steps() },
    ...(known ? { known } : {}),
    fallbackNode: () => ({ id: 'guests.ayuda', path: ['Ayuda y sugerencias'] }),
    onSubmit: async (result) => {
      const shape = reportShape(result.answers, grant);
      const node = result.node ?? { id: 'guests.inicio', path: ['Inicio'] };
      // `id` y `requestId` estables por formulario (kit 0.25.2): un doble toque o un reintento no crean otro reporte.
      const id = result.id;
      await reports.enqueue({
        id, requestId: result.requestId, userId, app: 'guests', nodeId: node.id, nodePath: node.path,
        message: shape.place ? `[${shape.place}] ${result.message}` : result.message,
        intent: shape.intent, subject: shape.subject, images: result.images, updatedAt: new Date().toISOString(),
        context: await collectFeedbackContext({ app: 'guests', node: { id: node.id, path: node.path, element: null }, role: 'editor' }),
        ...(shape.scope ? { scope: shape.scope } : {}), ...(shape.category ? { category: shape.category } : {}),
        attempts: 0,
      });
      await reports.flush().catch(() => undefined);
      // El aviso y el cierre de la hoja los hace el formulario del kit.
      const pending = (await reports.pending()).some((item) => item.id === id);
      return pending ? 'pending' : 'sent';
    },
  });
  form.element.setAttribute('data-feedback-id', 'guests.ayuda.formulario');
  form.element.setAttribute('data-feedback-label', 'Formulario de ayuda');

  async function paintMine(): Promise<void> {
    try {
      const out = await client.api<{ items: FeedbackReport[] }>('/feedback?mine=true&status=all&limit=20');
      if (!out.items.length) { replace(mine); return; }
      replace(mine, el('h3', null, t('help.mine')), el('ul', { class: 'plainlist gmine' },
        ...out.items.map((r) => el('li', null, el('span', { class: 'chip small' }, t(DISPLAY[r.display || r.status] ?? 'help.status.open')), ' ', el('span', { 'data-feedback-ignore': '' }, r.message.slice(0, 120))))));
    } catch (error) {
      replace(mine, el('p', { class: 'muted small' }, describeError(error)));
    }
  }

  openSheet({
    title: options.start === 'place' ? t('home.needHelp') : t('home.help'),
    body: el('div', { id: 'helpSheet' },
      options.start === 'place' && phone ? el('p', { class: 'banner', id: 'helpUrgent' }, icon('warn', 18), ' ', t('help.urgent'), ' ',
        el('a', { href: `tel:${phone.replace(/\s+/g, '')}`, 'data-feedback-id': 'guests.ayuda.urgente.llamar', 'data-feedback-label': 'Llamar a Ikisai' }, phone)) : null,
      el('p', { class: 'muted small' }, t('help.retreatNote')),
      form.element, mine),
    onClose: () => reports.destroy(),
  });
  void paintMine();
}
