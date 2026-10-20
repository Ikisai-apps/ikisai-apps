import { el } from '@ikisai/ui-kit';

export interface ChipSpec { text: string; kind?: string | null }

const chip = (c: ChipSpec) => el('span', { class: `chip${c.kind ? ` ${c.kind}` : ''}` }, c.text);

/**
 * Las etiquetas de una fila: como mucho `max` a la vista (las más graves, que van primero) y «+n», que despliega las
 * demás sin abrir la fila (tanda 27 en Facturas; tanda 30, MUELA-081, en Emitidas).
 */
export function chipsWithMore(list: ChipSpec[], max = 2): HTMLElement[] {
  const rest = list.slice(max);
  const more = rest.length ? el('button', { type: 'button', class: 'chip inv-more', 'aria-label': `Ver ${rest.length} etiqueta${rest.length === 1 ? '' : 's'} más: ${rest.map((l) => l.text).join(', ')}`,
    onclick: (e: Event) => { e.stopPropagation(); (e.currentTarget as HTMLElement).replaceWith(...rest.map(chip)); } }, `+${rest.length}`) : null;
  return [...list.slice(0, max).map(chip), ...(more ? [more] : [])];
}
