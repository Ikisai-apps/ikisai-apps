/**
 * Nodo señalado (FEEDBACK.md §2.1): se sube por los ancestros con `data-feedback-id` y se forma la ruta de etiquetas
 * («Reserva › Huéspedes › Añadir huésped»). Las etiquetas salen SOLO de `data-feedback-label` o, si falta, del último
 * tramo del id: nunca del texto de la página, que puede llevar nombres, teléfonos o importes (§10 de la especificación).
 */
import { FEEDBACK_MAX_PATH } from './constants.ts';

export interface FeedbackNode {
  /** `<app>.<pantalla>.<sección>.<elemento>`. */
  id: string;
  /** Etiquetas de la raíz al elemento, como mucho 6. */
  path: string[];
  /** Elemento instrumentado más cercano (o el de reserva). */
  element: Element | null;
  /** Sin `data-feedback-id` en la cadena: se usó la reserva de la página. */
  fallback?: boolean;
}

/** «guests.add» → «Add»; «reservation» → «Reservation»: solo como último recurso, la app debería poner la etiqueta. */
function labelFromId(id: string): string {
  const last = id.split('.').pop() ?? id;
  const words = last.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

export function feedbackLabel(element: Element): string {
  const explicit = element.getAttribute('data-feedback-label');
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 60);
  return labelFromId(element.getAttribute('data-feedback-id') ?? '');
}

/**
 * Nodo del elemento señalado. Sin ningún ancestro instrumentado, cae en la reserva que dé la app (página o sección),
 * por ejemplo `{ id: 'booking.reservations', path: ['Reservas'] }`.
 */
export function resolveFeedbackNode(target: Element | null, fallback?: () => { id: string; path: string[] }): FeedbackNode {
  const chain: Element[] = [];
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el.hasAttribute('data-feedback-id')) chain.push(el);
  }
  if (chain.length) {
    const nearest = chain[0]!;
    const path = chain.reverse().map(feedbackLabel).slice(-FEEDBACK_MAX_PATH);
    return { id: nearest.getAttribute('data-feedback-id')!, path, element: nearest };
  }
  const page = fallback?.() ?? { id: 'app.unmapped', path: ['Aplicación'] };
  return { id: page.id, path: page.path.slice(-FEEDBACK_MAX_PATH), element: null, fallback: true };
}
