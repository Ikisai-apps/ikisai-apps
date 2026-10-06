/** Utilidades mínimas de DOM: sin framework y sin plantillas de texto (evita inyecciones). */

export type Child = Node | string | number | null | undefined | false | Child[];

export type Attrs = Record<string, string | number | boolean | null | undefined | EventListener | Record<string, string>>;

/** Crea un elemento. `class`, `dataset`, `text` y `on*` tienen trato especial; `true` pone el atributo vacío. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'class') {
        node.className = String(value);
      } else if (key === 'dataset' && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, string>)) node.dataset[k] = v;
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Vacía el nodo y añade los hijos dados. */
export function replace(node: Node, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

/** Fecha y hora en español, o «—» si no hay valor. */
export function formatDate(iso: string | null | undefined, style: 'medium' | 'short' = 'medium'): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-ES', style === 'medium' ? { dateStyle: 'medium', timeStyle: 'short' } : { day: 'numeric', month: 'short' }).format(date);
}

/** Texto plural sencillo: `plural(n, 'cambio', 'cambios')`. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
