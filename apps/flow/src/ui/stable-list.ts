/**
 * Lista con clave que nunca se reconstruye (canon V1 §5 y FLOW-DIR-001 §5–6): cada elemento conserva su nodo y su
 * posición. Al llegar datos nuevos solo se actualiza lo que cambió, y solo se mueve un nodo si su orden canónico cambió
 * (por ejemplo, un pedido nuevo al final). Así un toque nunca cae sobre otra tarjeta durante un repintado, y el foco y el
 * scroll se conservan (con `overflow-anchor`, el navegador compensa lo que se inserte arriba).
 */
export interface StableList<T> {
  element: HTMLElement;
  /** Pinta `items` en ese orden. `render` crea el nodo la primera vez; `update` lo ajusta en las siguientes. */
  set(items: readonly T[]): void;
  node(key: string): HTMLElement | undefined;
}

export function createStableList<T>(options: {
  element: HTMLElement;
  key: (item: T) => string;
  render: (item: T) => HTMLElement;
  update: (node: HTMLElement, item: T) => void;
}): StableList<T> {
  const nodes = new Map<string, HTMLElement>();
  const { element } = options;
  return {
    element,
    node: (key) => nodes.get(key),
    set(items) {
      const keep = new Set<string>();
      let previous: HTMLElement | null = null;
      for (const item of items) {
        const key = options.key(item);
        keep.add(key);
        let node = nodes.get(key);
        if (!node) {
          node = options.render(item);
          node.dataset.key = key;
          nodes.set(key, node);
        } else {
          options.update(node, item);
        }
        const expected: ChildNode | null = previous ? previous.nextSibling : element.firstChild;
        if (expected !== node) element.insertBefore(node, expected);
        previous = node;
      }
      for (const [key, node] of nodes) {
        if (!keep.has(key)) { node.remove(); nodes.delete(key); }
      }
    },
  };
}
