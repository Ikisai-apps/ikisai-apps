/**
 * Guiado mínimo del kit (0.68; Core 27-10-2026): con `?campo=<id>` el kit señala un campo del inventario. Si el campo
 * está escondido, la app lo enseña (`registerReveal`):
 * - en la ficha de la reserva, va a la pestaña de su bloque (`goTo`);
 * - en cualquier pantalla, abre los `<details>` cerrados que lo contienen.
 * Las hojas cerradas no están en la página: no se abren solas.
 */

/** Enseña el anclaje `id` (campo o feedback) que está en `root` aunque no se vea. */
export function revealFor(root: ParentNode, id: string, goTo?: (block: string) => void): void {
  const q = CSS.escape(id);
  const node = root.querySelector<HTMLElement>(`[data-field-id="${q}"], [data-feedback-id="${q}"]`);
  if (!node) return;
  const block = node.closest<HTMLElement>('article[id^="block"]');
  if (block && goTo) goTo(block.id);
  for (let d = node.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
}
