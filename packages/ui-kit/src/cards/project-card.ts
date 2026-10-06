import { el, type Child } from '../dom.ts';
import { icon } from '../icons.ts';
import { itemColorStyle } from '../theme.ts';

/** Anillo de progreso SVG (0–100) con el porcentaje en el centro; toma el acento o `--item-ink` en tarjetas coloreadas. */
export function ringSvg(pct: number, size = 46, label?: string): SVGSVGElement {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label ?? `${p} por ciento`);
  const r = 15.9, c = 2 * Math.PI * r;
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('class', 'track'); track.setAttribute('cx', '18'); track.setAttribute('cy', '18'); track.setAttribute('r', String(r));
  const value = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  value.setAttribute('class', 'value'); value.setAttribute('cx', '18'); value.setAttribute('cy', '18'); value.setAttribute('r', String(r));
  value.setAttribute('stroke-dasharray', `${(c * p) / 100} ${c}`);
  value.setAttribute('transform', 'rotate(-90 18 18)');
  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('x', '18'); text.setAttribute('y', '21'); text.setAttribute('text-anchor', 'middle');
  text.textContent = `${p}%`;
  svg.append(track, value, text);
  return svg;
}

export interface ProjectCardSpec {
  id: string;
  title: string;
  /** «3 pendientes · 40 %», «pausado». */
  meta?: Child;
  /** Progreso 0–100 para el anillo y la línea; sin valor no hay ninguno. */
  progress?: number | null;
  /** Anillo en la esquina; `false` deja solo la línea de progreso (p. ej. tarjeta del sistema). */
  ring?: boolean;
  /** Color elegido por la persona: tiñe toda la tarjeta (`--item-color`), con tinta calculada. */
  color?: string | null;
  pinned?: boolean;
  /** Urgencia heredada: estrella parcial o llena. */
  urgency?: 'normal' | 'high' | 'critical';
  /** Chips ya construidos (p. ej. `labelChips`). */
  chips?: HTMLElement[];
  /** Presupuesto: barra con lo consumido. */
  budget?: { spent: number; total: number; format?: (n: number) => string } | null;
  /** Tarjeta del sistema (Entrada): sin pin ni color, borde discontinuo. */
  system?: boolean;
  /** Guardado en este dispositivo, pendiente de sincronizar. */
  pending?: boolean;
  onOpen?: () => void;
  onPin?: (pinned: boolean) => void;
  /** Acciones extra en la esquina (menú, arrastre). */
  actions?: HTMLElement[];
  /** Atributos extra del `article` (p. ej. `data-drop-project` en Tasks). */
  attrs?: Record<string, string | null | undefined>;
  /** Atributos extra del botón de fijar (p. ej. `data-project-pin`, `data-tip`, otro `aria-label`). */
  pinAttrs?: Record<string, string | null | undefined>;
}

/** Tarjeta de proyecto con anillo de progreso, pin, estrella de urgencia, chips, presupuesto y color propio. */
export function renderProjectCard(spec: ProjectCardSpec): HTMLElement {
  const classes = ['card', 'project'];
  if (spec.color && !spec.system) classes.push('colored');
  if (spec.system) classes.push('system');
  if (spec.pinned) classes.push('pinned');
  const pct = spec.progress ?? null;
  const star = spec.urgency && spec.urgency !== 'normal'
    // Mismo ámbar para los dos niveles: el relleno dice cuál (media estrella = alta, entera = crítica).
    ? el('span', { class: `star star-${spec.urgency}`, role: 'img', 'aria-label': spec.urgency === 'critical' ? 'Urgencia crítica' : 'Urgencia alta' }, icon('star', 16), el('span', { class: 'star-fill', 'aria-hidden': 'true' }, icon('star', 16)))
    : null;
  const open = el('button', { class: 'projectopen', type: 'button', dataset: { openProject: spec.id }, onclick: () => spec.onOpen?.() },
    el('div', { class: 'projecttitle' }, star, spec.title),
    spec.meta ? el('div', { class: 'projectmeta' }, spec.meta) : null,
  );
  const pin = spec.onPin && !spec.system
    ? el('button', { class: `iconbtn small pinbtn${spec.pinned ? ' pinned' : ''}`, type: 'button', 'aria-pressed': String(!!spec.pinned), 'aria-label': spec.pinned ? 'Desfijar proyecto' : 'Fijar proyecto', ...(spec.pinAttrs ?? {}), onclick: (e: Event) => { e.stopPropagation(); spec.onPin?.(!spec.pinned); } }, icon('pin', 16))
    : null;
  // Dinero: con presupuesto, barra de consumo (y «excedido»); sin presupuesto pero con coste, solo la cifra.
  const budget = spec.budget && (spec.budget.total > 0 || spec.budget.spent > 0)
    ? (() => {
      const fmt = spec.budget!.format ?? ((n: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n));
      const total = spec.budget!.total > 0 ? spec.budget!.total : 0;
      const ratio = total ? Math.min(1.2, spec.budget!.spent / total) : 0;
      const over = total > 0 && spec.budget!.spent > total;
      return el('div', { class: `money${over ? ' over' : ''}`, title: total ? 'Coste de las tareas frente al presupuesto' : 'Coste de las tareas' },
        el('div', { class: 'moneytext' }, icon('euro', 14), el('strong', null, fmt(spec.budget!.spent)), total ? ` de ${fmt(total)}${over ? ' · excedido' : ''}` : ''),
        total ? el('div', { class: 'moneybar', role: 'progressbar', 'aria-valuenow': String(Math.round(ratio * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('span', { style: `width:${Math.min(100, ratio * 100)}%` })) : null,
      );
    })()
    : null;
  return el('article', { class: classes.join(' '), style: spec.color && !spec.system ? itemColorStyle(spec.color) : null, dataset: { project: spec.id, pending: String(!!spec.pending) }, ...(spec.attrs ?? {}) },
    el('div', { class: 'projecttop' },
      pct !== null && spec.ring !== false ? el('span', { class: 'cardring', 'aria-hidden': 'true' }, ringSvg(pct, 46, '')) : null,
      open,
      el('div', { class: 'projecttools' }, pin, ...(spec.actions ?? [])),
    ),
    pct !== null ? el('div', { class: 'progressline' }, el('span', { style: `width:${Math.max(0, Math.min(100, pct))}%` })) : null,
    budget,
    spec.chips?.length ? el('div', { class: 'chips' }, ...spec.chips) : null,
    spec.pending ? el('span', { class: 'chip pending projectpending' }, el('span', null, 'Pendiente de sincronizar')) : null,
  );
}
