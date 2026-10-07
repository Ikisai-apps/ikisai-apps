/**
 * Marcas para «Sugerencias y QA» (FEEDBACK.md §6.4): `data-feedback-id` estable (`booking.<pantalla>.<sección>.<elemento>`,
 * minúsculas, sin acentos y sin ids de negocio) y `data-feedback-label` con la etiqueta corta en español de ese nivel.
 * Estas funciones son para los nodos que crea el kit (filas de lista, hojas) y no admiten atributos propios;
 * en el resto de elementos los atributos se escriben directamente en el `el(...)`.
 */
export function fbMark<T extends Element>(node: T, id: string, label: string): T {
  node.setAttribute('data-feedback-id', id);
  node.setAttribute('data-feedback-label', label);
  return node;
}

/** Zona con datos personales o que se copian: el gesto no se dispara aquí y su contenido nunca viaja en el reporte. */
export function fbIgnore<T extends Element>(node: T): T {
  node.setAttribute('data-feedback-ignore', '');
  return node;
}

/** Marca `data-feedback-ignore` en los descendientes que casen con el selector (nombres y contactos de las filas del kit). */
export function fbIgnoreWithin<T extends Element>(root: T, selector: string): T {
  for (const node of root.querySelectorAll(selector)) node.setAttribute('data-feedback-ignore', '');
  return root;
}
