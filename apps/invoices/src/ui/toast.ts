let node: HTMLDivElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Aviso breve, no bloqueante, anunciado a lectores de pantalla. */
export function toast(message: string, ms = 3200): void {
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => node?.classList.remove('show'), ms);
}
