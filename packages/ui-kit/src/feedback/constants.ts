/** Constantes del feedback (FEEDBACK.md §2.3, §2.7 y §7): un único sitio para ajustarlas. */
export const FEEDBACK_LONG_PRESS_MS = 600;
export const FEEDBACK_MOVE_TOLERANCE_PX = 8;
export const FEEDBACK_MAX_MESSAGE = 4000;
export const FEEDBACK_MAX_ATTACHMENTS = 3;
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const FEEDBACK_MAX_CONTEXT_BYTES = 8 * 1024;
export const FEEDBACK_MAX_PATH = 6;
/** Zonas donde el gesto no se dispara: arrastre de listas y de Tasks, y lo que la app marque. */
export const FEEDBACK_IGNORE_SELECTOR = '[data-feedback-ignore], .sortable-handle, .draghandle, [data-drag], [draggable="true"]';
/** Campos editables: mantener pulsado sigue siendo seleccionar texto. */
export const FEEDBACK_EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

export type FeedbackIntent = 'bug' | 'improvement' | 'idea' | 'problem' | 'suggestion';
export type FeedbackSubject = 'application' | 'event' | 'space';

export const FEEDBACK_INTENT_LABELS: Record<FeedbackIntent, string> = {
  bug: 'Algo falla', improvement: 'Mejora', idea: 'Idea', problem: 'Problema', suggestion: 'Sugerencia',
};
export const FEEDBACK_DISPLAY_LABELS: Record<string, string> = {
  open: 'Abierto', in_progress: 'En curso', pending_verify: 'Pendiente de verificar', verified: 'Verificado', dismissed: 'Descartado',
};
