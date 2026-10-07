/**
 * Marcas para «Sugerencias y QA» y el catálogo de «Uso» (FEEDBACK.md §6.4, USO.md): `data-feedback-id` estable
 * (`food.<pantalla>.<sección>.<elemento>`, minúsculas, sin acentos ni ids de negocio) y `data-feedback-label` con la
 * etiqueta corta en español de ese nivel.
 *
 * En los `el(...)` propios los dos atributos se escriben directamente en el objeto de atributos.
 * Para los nodos que crea el kit (filas de lista, bloques) se usa `fb(node, { feedbackId, feedbackLabel })`: con esa forma el
 * script del catálogo también los encuentra.
 */
export type FbMark = Record<'feedbackId' | 'feedbackLabel', string>;

export function fb<T extends Element>(node: T, mark: FbMark): T {
  node.setAttribute('data-feedback-id', mark.feedbackId);
  node.setAttribute('data-feedback-label', mark.feedbackLabel);
  return node;
}

/** Zona con datos de personas (nombres de grupos o de quien edita, notas de cocina sobre huéspedes): el gesto no se dispara aquí y su texto nunca viaja en el reporte. */
export function fbIgnore<T extends Element>(node: T): T {
  node.setAttribute('data-feedback-ignore', '');
  return node;
}

/**
 * Filas de una lista del kit: cada fila lleva la marca de fila y su título y su detalle (nombres de grupos, notas) quedan
 * excluidos. El contenedor de la lista lleva su propia marca.
 */
export function fbRows<T extends Element>(list: T, listMark: FbMark, rowMark: FbMark): T {
  fb(list, listMark);
  for (const row of list.querySelectorAll(':scope > li')) {
    fb(row, rowMark);
    for (const node of row.querySelectorAll('.row-title .name, .row-meta')) fbIgnore(node);
  }
  return list;
}
