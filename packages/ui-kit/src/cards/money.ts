import { el, type Child } from '../dom.ts';
import { icon } from '../icons.ts';

/** Una línea del desglose: categoría, importe y, si procede, enlace a su origen (la factura). */
export interface MoneyLine {
  id?: string;
  label: string;
  amount: number;
  /** Texto secundario («3 facturas», «Mercadona · 12 oct»). */
  meta?: Child;
  /** Enlace al origen (la ficha de la factura en Invoices). */
  href?: string;
  /** Alternativa a `href`: acción propia al pulsar la línea. */
  onOpen?: () => void;
  /** Color de la barra de participación; por defecto el acento. */
  color?: string | null;
}

export interface MoneyBreakdownSpec {
  lines: MoneyLine[];
  /** Total; por defecto la suma de las líneas. */
  total?: number;
  /** Etiqueta del total («Coste real»). */
  totalLabel?: string;
  /** Referencia con la que comparar el total (presupuesto, importe final): barra de consumo y «excedido». */
  compare?: { label: string; amount: number } | null;
  format?: (n: number) => string;
  /** Orden de mayor a menor importe; por defecto sí. */
  sort?: boolean;
  /** Líneas visibles antes de plegar el resto en «y N más»; por defecto todas. */
  max?: number;
  emptyText?: string;
}

const defaultFormat = (n: number): string => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/**
 * Desglose de importes: total arriba (con barra frente a una referencia, si la hay), líneas por categoría con su
 * participación y enlace al origen. Pensado para el «Coste real» de la reserva en Booking (leído de la proyección de
 * Invoices) y reutilizable en Tasks (coste de un proyecto por etiqueta) o Food (coste de un menú por servicio).
 */
export function renderMoneyBreakdown(spec: MoneyBreakdownSpec): HTMLElement {
  const fmt = spec.format ?? defaultFormat;
  const lines = spec.sort === false ? spec.lines.slice() : spec.lines.slice().sort((a, b) => b.amount - a.amount);
  const total = spec.total ?? lines.reduce((sum, line) => sum + line.amount, 0);
  const compare = spec.compare && spec.compare.amount > 0 ? spec.compare : null;
  const ratio = compare ? total / compare.amount : 0;
  const over = !!compare && total > compare.amount;
  const root = el('div', { class: `moneybreak${over ? ' over' : ''}`, role: 'group', 'aria-label': spec.totalLabel ?? 'Importes' });

  root.append(el('div', { class: 'mb-total' },
    el('span', { class: 'mb-label' }, spec.totalLabel ?? 'Total'),
    el('strong', { class: 'mb-amount' }, fmt(total)),
    compare ? el('span', { class: 'mb-compare' }, `${over ? 'excede' : 'de'} ${fmt(compare.amount)} ${compare.label}${compare.amount ? ` · ${Math.round(ratio * 100)} %` : ''}`) : null,
  ));
  if (compare) {
    root.append(el('div', { class: 'moneybar', role: 'progressbar', 'aria-valuenow': String(Math.round(ratio * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `${Math.round(ratio * 100)} % ${compare.label}` },
      el('span', { style: `width:${Math.min(100, ratio * 100)}%` })));
  }

  if (!lines.length) {
    root.append(el('p', { class: 'hint mb-empty' }, spec.emptyText ?? 'Sin importes todavía.'));
    return root;
  }

  const list = el('ul', { class: 'mb-lines' });
  const visible = spec.max && spec.max < lines.length ? lines.slice(0, spec.max) : lines;
  const hidden = lines.length - visible.length;
  const row = (line: MoneyLine): HTMLElement => {
    const share = total > 0 ? Math.max(0, Math.min(100, (line.amount / total) * 100)) : 0;
    const body: Child[] = [
      el('span', { class: 'mb-name' }, line.label, line.meta ? el('small', { class: 'mb-meta' }, line.meta) : null),
      el('span', { class: 'mb-amount' }, fmt(line.amount)),
      line.href || line.onOpen ? icon('chevronRight', 16) : null,
    ];
    const open = line.href
      ? el('a', { class: 'mb-open', href: line.href }, ...body)
      : line.onOpen
        ? el('button', { class: 'mb-open', type: 'button', onclick: () => line.onOpen?.() }, ...body)
        : el('span', { class: 'mb-open' }, ...body);
    return el('li', { class: 'mb-line', dataset: { line: line.id ?? '' } },
      open,
      el('span', { class: 'mb-share', 'aria-hidden': 'true' }, el('span', { style: `width:${share}%${line.color ? `;background:${line.color}` : ''}` })),
    );
  };
  list.append(...visible.map(row));
  if (hidden > 0) {
    const more = el('li', { class: 'mb-more' },
      el('button', { class: 'linkbtn', type: 'button', onclick: () => { more.replaceWith(...lines.slice(visible.length).map(row)); } }, `y ${hidden} más`));
    list.append(more);
  }
  root.append(list);
  return root;
}
