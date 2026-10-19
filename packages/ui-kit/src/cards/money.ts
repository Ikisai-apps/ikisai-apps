import { el, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { kitLocaleTag, kt } from '../i18n/i18n.ts';

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

/** Un movimiento del extracto: un pago recibido, una factura o lo que queda por pagar. */
export interface MoneyMove {
  id?: string;
  /** `YYYY-MM-DD`: agrupa por mes (en el orden en que llegan). */
  date?: string | null;
  label: string;
  /** Línea secundaria ya escrita («12 oct · te quedan 820 €», «antes del 1 de dic»). */
  meta?: Child;
  amount: number;
  /** `in`: pago recibido (+, verde); `doc`: factura o documento; `due`: por pagar (borde discontinuo). */
  kind?: 'in' | 'doc' | 'due';
  /** Estado escrito («Pagado», «Atrasado», «Pendiente»). */
  chip?: { text: string; tone?: 'ok' | 'warn' | 'alert' | null } | null;
  href?: string;
  onOpen?: () => void;
}

export interface MoneyBreakdownSpec {
  lines?: MoneyLine[];
  /**
   * `statement` (extracto, MUELA-075 pieza 23: Organizers, Booking, Finance): lo que queda en grande («Te queda por
   * pagar»), lo próximo y los movimientos por meses. El saldo y los estados los calcula la app.
   */
  mode?: 'breakdown' | 'statement';
  /** Extracto: bajo la cifra («de 2.400 € contratados»). */
  subtitle?: string | null;
  /** Extracto: lo que viene («Próximamente»). */
  upcoming?: MoneyMove[];
  upcomingLabel?: string;
  /** Extracto: lo que ya pasó, por meses. */
  moves?: MoneyMove[];
  movesLabel?: string;
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
  if (spec.mode === 'statement') return renderStatement(spec);
  const fmt = spec.format ?? defaultFormat;
  const lines = spec.sort === false ? (spec.lines ?? []).slice() : (spec.lines ?? []).slice().sort((a, b) => b.amount - a.amount);
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

/** Extracto (`mode: 'statement'`): cifra grande, lo próximo y los movimientos por meses. */
function renderStatement(spec: MoneyBreakdownSpec): HTMLElement {
  const fmt = spec.format ?? defaultFormat;
  const label = spec.totalLabel ?? kt('Te queda por pagar');
  const move = (m: MoneyMove): HTMLElement => {
    const kind = m.kind ?? 'doc';
    const sign = kind === 'in' ? '+' : '';
    const body: Child[] = [
      el('span', { class: 'mb-ic', 'aria-hidden': 'true' }, icon(kind === 'in' ? 'check' : kind === 'due' ? 'calendar' : 'invoice', 18)),
      el('span', { class: 'mb-name' }, m.label, m.meta ? el('small', { class: 'mb-meta' }, m.meta) : null),
      el('span', { class: 'mb-moveamt' }, el('b', null, `${sign}${fmt(m.amount)}`), m.chip ? el('span', { class: `chip small${m.chip.tone ? ` ${m.chip.tone}` : ''}` }, m.chip.text) : null),
    ];
    const open = m.href ? el('a', { class: 'mb-open', href: m.href }, ...body)
      : m.onOpen ? el('button', { type: 'button', class: 'mb-open', onclick: () => m.onOpen?.() }, ...body)
        : el('span', { class: 'mb-open' }, ...body);
    return el('li', { class: `mb-move mb-${kind}`, dataset: { move: m.id ?? '' } }, open);
  };
  const monthOf = (d: string) => {
    const text = new Intl.DateTimeFormat(kitLocaleTag(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0, 7)}-01T12:00:00Z`));
    return text.charAt(0).toLocaleUpperCase() + text.slice(1);
  };
  const months: { key: string; label: string; moves: MoneyMove[] }[] = [];
  for (const m of spec.moves ?? []) {
    const key = m.date ? m.date.slice(0, 7) : '';
    let group = months.find((g) => g.key === key);
    if (!group) { group = { key, label: key ? monthOf(m.date!) : '', moves: [] }; months.push(group); }
    group.moves.push(m);
  }
  const upcoming = spec.upcoming ?? [];
  return el('div', { class: 'moneybreak mb-statement', role: 'group', 'aria-label': label },
    el('div', { class: 'mb-total' },
      el('span', { class: 'mb-label' }, label),
      el('strong', { class: 'mb-amount' }, fmt(spec.total ?? 0)),
      spec.subtitle ? el('span', { class: 'mb-compare' }, spec.subtitle) : null),
    upcoming.length ? el('section', { class: 'mb-feed', 'aria-label': spec.upcomingLabel ?? kt('Próximamente') },
      el('h3', { class: 'mb-feedh' }, spec.upcomingLabel ?? kt('Próximamente')),
      el('ul', { class: 'mb-moves' }, ...upcoming.map((m) => move({ kind: 'due', ...m })))) : null,
    el('section', { class: 'mb-feed', 'aria-label': spec.movesLabel ?? kt('Movimientos') },
      el('h3', { class: 'mb-feedh' }, spec.movesLabel ?? kt('Movimientos')),
      months.length
        ? el('div', null, ...months.map((g) => el('div', { class: 'mb-month' }, g.label ? el('p', { class: 'mb-monthh' }, g.label) : null, el('ul', { class: 'mb-moves' }, ...g.moves.map(move)))))
        : el('p', { class: 'hint mb-empty' }, spec.emptyText ?? kt('Aún no hay movimientos.'))));
}
