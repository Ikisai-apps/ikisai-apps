/**
 * «Ayuda y sugerencias» (API.md §9.9; especificación de feedback §3.2 y §4): formulario por pasos del kit con tres ramas
 * (la aplicación, mi retiro, un espacio) y debajo «Lo que me has enviado». Los reportes van a Ikisai por `POST feedback`.
 */
import type { SyncClient } from '@ikisai/sync-client';
import {
  collectFeedbackContext, createFeedbackClient, createFeedbackProgressiveForm, el, openSheet, replace, toast,
  type FeedbackIntent, type FeedbackReport, type FeedbackSubject, type ProgressiveAnswers, type ProgressiveStep,
} from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import type { PortalApi } from '../app/api.ts';

export interface HelpOptions {
  client: SyncClient;
  userId: string;
  api: PortalApi;
  /** Retiro en pantalla: «Mi retiro» no pregunta cuál y los espacios llevan su reserva. */
  reservationId: string | null;
}

const STEPS: ProgressiveStep[] = [
  { id: 'about', kind: 'choice', question: '¿Sobre qué quieres comentarnos algo?', options: [
    { value: 'application', label: 'La aplicación', next: 'appKind' },
    { value: 'event', label: 'Mi retiro', next: 'retreat' },
    { value: 'space', label: 'Un espacio de Ikisai', next: 'place' },
  ] },
  { id: 'appKind', kind: 'choice', question: '¿Qué pasa?', options: [{ value: 'bug', label: 'Algo no funciona' }, { value: 'improvement', label: 'Tengo una sugerencia' }], next: 'appWhere' },
  { id: 'appWhere', kind: 'signal', question: 'Mantén pulsado sobre el lugar de la aplicación al que te refieres.', action: 'Señalar en la pantalla', next: 'message' },
  { id: 'retreat', kind: 'choice', question: '¿De qué retiro?', options: [], next: 'eventCat' },
  { id: 'eventCat', kind: 'choice', question: '¿Sobre qué parte del retiro?', options: [
    { value: 'setup', label: 'Montaje y mobiliario' }, { value: 'accommodation', label: 'Alojamiento' }, { value: 'cleaning', label: 'Limpieza' },
    { value: 'food', label: 'Cocina' }, { value: 'technical', label: 'Técnico' }, { value: 'operation', label: 'Horarios y operación' }, { value: 'other', label: 'Otra petición' },
  ], next: 'message' },
  { id: 'place', kind: 'choice', question: '¿Dónde?', options: [
    { value: 'habitacion', label: 'Habitación' }, { value: 'comedor', label: 'Comedor' }, { value: 'sala', label: 'Sala' }, { value: 'banos', label: 'Baños' },
    { value: 'exterior', label: 'Exterior' }, { value: 'piscina', label: 'Piscina' }, { value: 'otro', label: 'Otro sitio' },
  ], next: 'spaceKind' },
  { id: 'spaceKind', kind: 'choice', question: '¿Qué tipo de problema?', options: [
    { value: 'damage', label: 'Algo está roto' }, { value: 'cleaning', label: 'Limpieza' }, { value: 'missing', label: 'Falta algo' },
    { value: 'utilities', label: 'Agua o electricidad' }, { value: 'safety', label: 'Seguridad' }, { value: 'other', label: 'Otra cosa' },
  ], next: 'message' },
  { id: 'message', kind: 'text', question: 'Cuéntanos', placeholder: '¿Qué ha pasado o qué te gustaría?', images: true },
];

const PLACES: Record<string, string> = { habitacion: 'Habitación', comedor: 'Comedor', sala: 'Sala', banos: 'Baños', exterior: 'Exterior', piscina: 'Piscina', otro: 'Otro sitio' };
const DISPLAY: Record<string, string> = { open: 'Recibido', in_progress: 'En marcha', pending_verify: 'Resuelto', verified: 'Resuelto', dismissed: 'Cerrado' };

/** Lo que el servidor necesita de cada rama (FEEDBACK.md §7: subject, intent, category, scope). */
export function reportShape(answers: ProgressiveAnswers, current: string | null): { subject: FeedbackSubject; intent: FeedbackIntent; category?: string; scope?: Record<string, string>; place?: string } {
  const reservationId = answers.about === 'event' ? (answers.retreat ?? current) : current;
  const scope = reservationId ? { reservation_id: reservationId } : undefined;
  if (answers.about === 'event') return { subject: 'event', intent: answers.eventCat === 'other' ? 'suggestion' : 'problem', category: answers.eventCat, scope };
  if (answers.about === 'space') return { subject: 'space', intent: 'problem', category: answers.spaceKind, scope, place: PLACES[answers.place ?? ''] };
  return { subject: 'application', intent: answers.appKind === 'improvement' ? 'improvement' : 'bug' };
}

export async function openHelp(options: HelpOptions): Promise<void> {
  const { client, userId, reservationId } = options;
  // «¿De qué retiro?» solo fuera de un retiro; dentro, la respuesta ya la da la pantalla (`known`).
  let retreats: Array<{ value: string; label: string }> = [];
  try {
    retreats = (await options.api.reservations()).value.items.map((r) => ({ value: r.id, label: r.title }));
  } catch { /* sin red y sin copia: se pregunta igual, sin opciones de retiro */ }
  const api = client.api.bind(client);
  const reports = createFeedbackClient({ api, app: 'organizers', userId: () => userId });
  const mine = el('div', { id: 'helpMine', 'data-feedback-id': 'organizers.ayuda.enviados', 'data-feedback-label': 'Lo que me has enviado' });

  const steps = STEPS.map((step) => (step.id === 'retreat' ? { ...step, options: retreats } : step));
  const known = reservationId ? { retreat: reservationId } : retreats.length === 1 ? { retreat: retreats[0]!.value } : undefined;
  const form = createFeedbackProgressiveForm({
    config: { start: 'about', steps },
    ...(known ? { known } : {}),
    fallbackNode: () => ({ id: 'organizers.ayuda', path: ['Ayuda y sugerencias'] }),
    onSubmit: async (result) => {
      const shape = reportShape(result.answers, reservationId);
      const node = result.node ?? { id: shape.scope ? 'organizers.retiro' : 'organizers.retiros', path: [shape.scope ? 'Retiro' : 'Mis retiros'] };
      const id = crypto.randomUUID();
      await reports.enqueue({
        id, requestId: crypto.randomUUID(), userId, app: 'organizers', nodeId: node.id, nodePath: node.path,
        message: shape.place ? `[${shape.place}] ${result.message}` : result.message,
        intent: shape.intent, subject: shape.subject, images: result.images, updatedAt: new Date().toISOString(),
        context: await collectFeedbackContext({ app: 'organizers', node: { id: node.id, path: node.path, element: null }, role: 'editor' }),
        ...(shape.scope ? { scope: shape.scope } : {}), ...(shape.category ? { category: shape.category } : {}),
        attempts: 0,
      });
      await reports.flush().catch(() => undefined);
      const pending = (await reports.pending()).some((item) => item.id === id);
      toast(pending ? 'Lo enviaremos en cuanto vuelva la conexión.' : 'Gracias. Lo hemos recibido.');
      void paintMine();
      return pending ? 'pending' : 'sent';
    },
  });
  form.element.setAttribute('data-feedback-id', 'organizers.ayuda.formulario');
  form.element.setAttribute('data-feedback-label', 'Formulario de ayuda');

  async function paintMine(): Promise<void> {
    try {
      const out = await client.api<{ items: FeedbackReport[] }>('/feedback?mine=true&status=all&limit=20');
      if (!out.items.length) { replace(mine); return; }
      replace(mine, el('h3', null, 'Lo que me has enviado'), el('ul', { class: 'plainlist orgmine' },
        ...out.items.map((r) => el('li', null, el('span', { class: 'chip small' }, DISPLAY[r.display || r.status] ?? 'Recibido'), ' ', el('span', { 'data-feedback-ignore': '' }, r.message.slice(0, 120))))));
    } catch (error) {
      replace(mine, el('p', { class: 'muted small' }, describeError(error)));
    }
  }

  openSheet({
    title: 'Ayuda y sugerencias',
    body: el('div', { id: 'helpSheet' }, form.element, mine),
    onClose: () => reports.destroy(),
  });
  void paintMine();
}
