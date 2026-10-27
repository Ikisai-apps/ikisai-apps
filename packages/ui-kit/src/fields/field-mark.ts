/**
 * Inventario semántico de campos (visión V0.2, «Uso y cobertura» de Central): cada campo de un formulario declara qué es,
 * no lo que se escribe en él. Lo lee `scripts/feature-catalog.mjs` al publicar (lista `fields`) y lo que no lo declara sale
 * en `fieldsUninstrumented`. Nunca lleva valores ni contenido: solo metadatos del código.
 * - Campos del kit (`createDateField`, `createQuantityField`, `createSuggestField`, `createColorField`, `createLabelPicker`,
 *   `createLevelStar`, `createSignaturePad`): opción `field`; el tipo y «obligatorio» los ponen ellos.
 * - `createStepForm({ feedbackId })`: cada pregunta se marca sola como `<feedbackId>.<id>`; `field` en la pregunta añade el resto.
 * - Campos sueltos: `el('input', { …, ...fieldAttrs({ id, entity, prop }) })`, `markField(nodo, { … })` o los atributos
 *   `data-field-*` en el HTML. Siempre con literales, como los `data-feedback-id`.
 * Si el campo no tiene ya un `data-feedback-id`, se le pone el mismo id (el ancla del feedback y del uso).
 */
export type FieldSensitivity = 'public' | 'internal' | 'personal' | 'sensitive';
export type FieldConfirm = 'save' | 'event' | 'none';
export const FIELD_CONFIRMS: readonly FieldConfirm[] = ['save', 'event', 'none'];

export interface FieldSpec {
  /** Estable: `<app>.<pantalla>.<campo>` en minúsculas y sin acentos, como los ids de feedback. */
  id: string;
  /** Entidad y propiedad que guarda (`booking.reservations` y `check_in`), si el formulario lo sabe. */
  entity?: string;
  prop?: string;
  /** Tipo (`text`, `date`, `number`, `select`, `multi`, `toggle`, `color`, `labels`, `signature`…). Los del kit lo ponen solos. */
  type?: string;
  /** `true` siempre, `false` nunca, o la condición en palabras («si la reserva es de grupo»). */
  required?: boolean | string;
  /** Permiso que hace falta para editarlo (`booking.edit`). */
  permission?: string;
  sensitivity?: FieldSensitivity;
  /** Versión de la app en la que apareció, si se sabe (si no, la pone el núcleo con la primera publicación en que lo ve). */
  since?: string;
  /** Ruta de la pantalla (`#/reservas/:id`), si no basta la del id. */
  route?: string;
  /** `data-feedback-id` del campo, si es otro que `id`. */
  anchor?: string;
  /**
   * Qué prueba que se guardó, para el Guiado: `save` (lo guarda `createSaveState` con este id como clave y avisa solo),
   * `event` (la app llama a `announceSaved(id)` al confirmarlo) o `none` (no se confirma por sí solo).
   */
  confirm?: FieldConfirm;
  /** Nombre del validador que aplica la app (`dni`, `fecha_futura`); nunca código. */
  validator?: string;
  label?: string;
}

const ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$/;
export const FIELD_SENSITIVITIES: readonly FieldSensitivity[] = ['public', 'internal', 'personal', 'sensitive'];

/** `'always'`, `'never'` o la condición; `null` si no se dice. */
export function fieldRequired(required: boolean | string | undefined | null): string | null {
  if (required === true) return 'always';
  if (required === false) return 'never';
  return typeof required === 'string' && required.trim() ? required.trim() : null;
}

/** Atributos `data-field-*` (y el ancla de feedback) para `el()`. Con un id mal formado no marca nada y lo avisa en consola. */
export function fieldAttrs(spec: FieldSpec | null | undefined, defaults: Partial<FieldSpec> = {}): Record<string, string | null> {
  if (!spec) return {};
  if (!ID.test(spec.id)) { console.warn(`[ui-kit] field: id «${spec.id}» no válido (app.pantalla.campo)`); return {}; }
  const s = { ...defaults, ...spec };
  return {
    'data-field-id': s.id,
    'data-field-type': s.type ?? null,
    'data-field-entity': s.entity ?? null,
    'data-field-prop': s.prop ?? null,
    'data-field-required': fieldRequired(s.required),
    'data-field-permission': s.permission ?? null,
    'data-field-sensitivity': s.sensitivity && FIELD_SENSITIVITIES.includes(s.sensitivity) ? s.sensitivity : null,
    'data-field-since': s.since ?? null,
    'data-field-route': s.route ?? null,
    'data-field-confirm': s.confirm && FIELD_CONFIRMS.includes(s.confirm) ? s.confirm : null,
    'data-field-validator': s.validator && /^[a-z][a-z0-9_]{0,40}$/.test(s.validator) ? s.validator : null,
    'data-feedback-id': s.anchor ?? s.id,
    'data-feedback-label': s.label ?? null,
  };
}

/** Marca un nodo ya creado. No pisa un `data-feedback-id` que ya tenga. */
export function markField<T extends Element>(node: T, spec: FieldSpec, defaults: Partial<FieldSpec> = {}): T {
  for (const [key, value] of Object.entries(fieldAttrs(spec, defaults))) {
    if (value === null) continue;
    if ((key === 'data-feedback-id' || key === 'data-feedback-label') && node.hasAttribute(key)) continue;
    node.setAttribute(key, value);
  }
  return node;
}
