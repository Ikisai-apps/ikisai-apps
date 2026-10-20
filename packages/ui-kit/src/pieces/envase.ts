/**
 * El envase (MUELA-093 §2 y §5, común a la Compra de Food y a Compras R6 de Tasks): lo que hace falta → lo que se compra
 * en envases enteros → lo que sobra → lo que cuesta, en cuentas, en palabras y dibujado. Sin datos de ninguna app.
 *
 * Las cuentas (`Envase.plan`):
 * - con envase: envases enteros del habitual (`usual`; si no hay, el primero);
 * - a granel (`granel`): lo justo;
 * - en unidades, manojos o paquetes sin envase: el entero (no se compra medio limón, y un resto de menos de uno no es sobra);
 * - lo que sobra = lo que se compra − lo que hace falta;
 * - coste = envases × precio del envase; a granel o sin precio del envase, lo comprado × `perBase`. **Sin precio, `cost`
 *   es `null`, nunca 0**: la app dice «sin precio».
 *
 * `formats` acepta las filas de `resources.item_units` tal cual: `unit` es la etiqueta («paquete de 1 kg»), `factor` el
 * tamaño en la unidad de `need`, y además `usual` y `price`. La fila original vuelve en `source`.
 *
 * El dibujo (`draw`, `tube`) va siempre con su frase como nombre accesible (`words`); macizo lo que se usa, rayado lo que
 * sobra (en ámbar si caduca pronto): el rayado se distingue por el dibujo, no solo por el color. `keep` dice adónde va lo
 * que sobra («a la Despensa», por defecto; Tasks: «al almacén») y `where`, dónde se guarda el envase («en la Despensa»;
 * Tasks: «en el inventario»).
 *
 * La hoja (`formatSheet`) **nunca cambia el tamaño de un envase que ya existe**: «Otro envase» es una fila nueva
 * (`isNew`), y el elegido pasa a ser el habitual. Solo devuelve lo elegido en `onSave`; escribir es cosa de la app.
 * Prefijos de clases: `ev-` (el dibujo) y `fs-` (la hoja).
 */
import { el, replace } from '../dom.ts';
import { kt, kitLocaleTag } from '../i18n/i18n.ts';
import { openSheet, type Sheet } from '../overlay/sheet.ts';
import { toast } from '../toast.ts';
import { kitLayer } from '../layer.ts';

export type PackKind = 'envase' | 'granel' | 'entero' | 'sin';

/** Un envase. También vale una fila de `item_units` (`unit` como etiqueta y `factor` como tamaño). */
export interface PackFormatInput {
  label?: string | null;
  size?: number | string | null;
  unit?: string | null;
  factor?: number | string | null;
  price?: number | string | null;
  usual?: boolean | null;
  /** Plural de la etiqueta («paquetes de 1 kg»); por defecto, la primera palabra con «s». */
  plural?: string | null;
  [key: string]: unknown;
}

export interface PackFormat {
  label: string;
  size: number;
  price: number | null;
  usual: boolean;
  plural: string | null;
  /** La fila que pasó la app, tal cual. */
  source: PackFormatInput | null;
}

export interface PackPlanInput {
  /** Lo que hace falta, en `unit` (`purchase_quantity`). */
  need: number | string | null | undefined;
  /** Unidad de `need` (g, kg, ml, l, unidad, manojo, paquete…). */
  unit: string;
  formats?: PackFormatInput[] | null;
  /** Se compra suelto: lo justo. */
  granel?: boolean;
  /** Caduca pronto: lo que sobra va en ámbar. */
  perishable?: boolean;
  /** Lo que dura (texto de la app). */
  lasts?: string | null;
  /** € por unidad de `need`: a granel, o si el envase no tiene precio. */
  perBase?: number | null;
  /** Quién lo usa (texto de la app). */
  uses?: string | null;
}

export interface PackPlan {
  need: number;
  unit: string;
  kind: PackKind;
  formats: PackFormat[];
  /** El envase con el que se cuenta (el habitual). */
  fmt: PackFormat | null;
  /** Envases que se compran (con envase). */
  count: number | null;
  buy: number;
  extra: number;
  /** `null` si no hay precio: nunca 0 por falta de precio. */
  cost: number | null;
  uses: string | null;
  perBase: number | null;
  perishable: boolean;
  lasts: string | null;
}

export interface PackTextOptions {
  /** Adónde va lo que sobra, en minúscula. Por defecto «a la Despensa». */
  keep?: string;
}

export interface PackDrawOptions extends PackTextOptions {
  scale?: number;
  /** Nombre accesible; por defecto, `words(r)`. */
  label?: string;
}

export interface PackTicket {
  label: string;
  size: number;
  price?: number | null;
  supplier?: string | null;
  /** Fecha ISO (`2026-10-03`). */
  date?: string | null;
}

export interface PackSaved extends PackFormat {
  /** Es un envase nuevo («Otro envase», una sugerencia o el del ticket que no estaba): la app crea una fila. */
  isNew: boolean;
}

export interface PackSheetOptions {
  /** Nombre del artículo. */
  name: string;
  r: PackPlan;
  ticket?: PackTicket | null;
  /** Lo elegido (habitual) y todos los envases, con `usual` puesto. Los que ya existían conservan su tamaño. */
  onSave: (format: PackSaved, formats: PackSaved[]) => void;
  /** Dónde se guarda, en minúscula. Por defecto «en la Despensa». */
  where?: string;
  keep?: string;
  feedbackId?: string;
  /** Adónde vuelve el foco al cerrar (si la app repinta la baldosa, el dibujo nuevo). */
  returnFocus?: HTMLElement | (() => HTMLElement | null | undefined) | null;
}

const EPS = 1e-9;
let uid = 0;
const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
  return Number.isFinite(n) ? n : null;
};

function num(q: number): string {
  return Number(q).toLocaleString(kitLocaleTag(), { maximumFractionDigits: 3, useGrouping: false });
}

/** La cantidad legible y con plural: «4,76 l», «144 g», «12 unidades». */
function legible(q: number, unit: string): string {
  q = Math.round(Number(q) * 1000) / 1000;
  if (unit === 'g' && q >= 1000) return `${num(Math.round(q) / 1000)} kg`;
  if (unit === 'ml' && q >= 1000) return `${num(Math.round(q) / 1000)} l`;
  if (unit === 'kg' && q < 1) return `${num(Math.round(q * 1000))} g`;
  if (unit === 'l' && q < 1) return `${num(Math.round(q * 1000))} ml`;
  if (unit === 'unidad') return q === 1 ? kt('1 unidad') : kt('{n} unidades', { n: num(q) });
  if (unit === 'paquete') return q === 1 ? kt('1 paquete') : kt('{n} paquetes', { n: num(q) });
  if (unit === 'manojo') return q === 1 ? kt('1 manojo') : kt('{n} manojos', { n: num(q) });
  return `${num(q)} ${unit}`;
}

/** «1 paquete de 1 kg», «5 paquetes de 1 kg». */
function packText(count: number, label: string, plural?: string | null): string {
  return count === 1 ? `1 ${label}` : `${count} ${plural || label.replace(/^(\S+)/, (w) => (/[aeiouáéíóúk]$/i.test(w) ? `${w}s` : `${w}es`))}`;
}

function normalize(f: PackFormatInput): PackFormat | null {
  const label = String(f.label ?? f.unit ?? '').trim();
  const size = toNum(f.size ?? f.factor);
  if (!label || size === null || size <= 0) return null;
  const price = toNum(f.price);
  return { label, size, price: price !== null && price > 0 ? price : null, usual: !!f.usual, plural: f.plural ?? null, source: f };
}

/* ---------- las cuentas ---------- */
function plan(o: PackPlanInput): PackPlan {
  const need = Math.max(toNum(o.need) ?? 0, 0);
  const pb = toNum(o.perBase);
  const formats = (o.formats ?? []).map(normalize).filter((f): f is PackFormat => !!f);
  const r: PackPlan = {
    need, unit: o.unit, kind: 'sin', formats, fmt: null, count: null, buy: need, extra: 0, cost: pb !== null ? need * pb : null,
    uses: o.uses ?? null, perBase: pb, perishable: !!o.perishable, lasts: o.lasts ?? null,
  };
  if (formats.length) {
    const f = formats.find((x) => x.usual) ?? formats[0]!;
    const c = need > EPS ? Math.ceil(need / f.size - EPS) : 0;
    r.kind = 'envase'; r.fmt = f; r.count = c; r.buy = c * f.size; r.extra = r.buy - need;
    r.cost = f.price !== null ? c * f.price : pb !== null ? r.buy * pb : null;
  } else if (o.unit === 'unidad' || o.unit === 'manojo' || o.unit === 'paquete') {
    r.kind = 'entero'; r.buy = Math.ceil(need - EPS); r.extra = r.buy - need; r.cost = pb !== null ? r.buy * pb : null;
  } else if (o.granel) r.kind = 'granel';
  return r;
}

function buyText(r: PackPlan): string {
  return r.kind === 'envase' && r.fmt ? packText(r.count ?? 0, r.fmt.label, r.fmt.plural) : legible(r.buy, r.unit);
}

/** Lo que sobra; en unidades, un resto de menos de uno es el redondeo al entero, no un sobrante. */
function extraText(r: PackPlan): string | null {
  return r.extra > EPS && !(r.kind === 'entero' && r.extra < 1 - EPS) ? legible(r.extra, r.unit) : null;
}

const keepOf = (o?: PackTextOptions | null) => o?.keep || kt('a la Despensa');
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Lo que dice el dibujo, en palabras: «5 paquetes de 1 kg: se usa 4,8 kg y 200 g van a la Despensa.» */
function words(r: PackPlan, opts?: PackTextOptions | null): string {
  if (r.kind === 'sin') return kt('Sin envase: se compra lo justo, {need}.', { need: legible(r.need, r.unit) });
  const x = extraText(r);
  const vars = { buy: buyText(r), need: legible(r.need, r.unit), extra: x ?? '', keep: keepOf(opts) };
  if (!x) return kt('{buy}: se usa {need}, sin que sobre.', vars);
  return r.perishable ? kt('{buy}: se usa {need} y {extra} van {keep} (caduca pronto).', vars) : kt('{buy}: se usa {need} y {extra} van {keep}.', vars);
}

/* ---------- el dibujo ---------- */
const NS = 'http://www.w3.org/2000/svg';
function s(tag: string, attrs?: Record<string, string | null | undefined> | null, kids?: Array<Node | null>): SVGElement {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) n.setAttribute(k, v);
  for (const c of kids ?? []) if (c) n.appendChild(c);
  return n;
}

/** Las tramas, una vez por documento (fuera de la vista), en la capa del kit: con el CSS acotado, ahí tienen sus colores. */
function defs(): void {
  if (document.getElementById('evDefs')) return;
  const pat = (id: string, cls: string) => s('pattern', { id, width: '6', height: '6', patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    [s('rect', { width: '6', height: '6', class: 'ev-hbg' }), s('rect', { width: '2.6', height: '6', class: cls })]);
  kitLayer().appendChild(s('svg', { id: 'evDefs', class: 'ev-defs', width: '0', height: '0', 'aria-hidden': 'true', focusable: 'false', style: 'position:absolute;width:0;height:0;overflow:hidden' },
    [s('defs', null, [pat('evHatch', 'ev-hline'), pat('evHatchWarn', 'ev-hline warn')])]));
}

const SHAPES: Record<string, string> = { bolsa: 'bag', paquete: 'box', caja: 'box', saco: 'bag', botella: 'bottle', garrafa: 'jug', bote: 'jar', tarro: 'jar', tarrina: 'jar', brik: 'carton', cuña: 'block', bloque: 'block', docena: 'tray', bandeja: 'tray', pack: 'tray', manojo: 'bunch', bombona: 'jug' };
function shapeOf(r: PackPlan): string {
  if (r.kind === 'sin') return 'sin';
  if (r.kind === 'granel') return 'granel';
  if (r.kind === 'entero') return 'units';
  return SHAPES[(r.fmt!.label.split(' ')[0] ?? '').toLowerCase()] ?? 'box';
}
function outline(shape: string): string {
  switch (shape) {
    case 'bag': return 'M7 8 L33 8 L37 58 L3 58 Z';
    case 'bottle': return 'M15 2 L25 2 L25 12 Q34 15 34 24 L34 54 Q34 58 30 58 L10 58 Q6 58 6 54 L6 24 Q6 15 15 12 Z';
    case 'jug': return 'M14 4 L22 4 L22 12 L34 12 Q38 12 38 16 L38 54 Q38 58 34 58 L6 58 Q2 58 2 54 L2 20 Q2 12 10 12 L14 12 Z';
    case 'jar': return 'M8 4 L32 4 L32 12 L35 16 L35 54 Q35 58 31 58 L9 58 Q5 58 5 54 L5 16 L8 12 Z';
    case 'carton': return 'M8 14 L20 4 L32 14 L32 58 L8 58 Z';
    case 'block': return 'M3 26 L37 26 L37 58 L3 58 Z';
    case 'bunch': return 'M20 58 C2 46 2 18 20 4 C38 18 38 46 20 58 Z';
    case 'unit': return 'M2 38 A18 18 0 1 0 38 38 A18 18 0 1 0 2 38 Z';
    default: return 'M4 8 L36 8 L36 58 L4 58 Z';
  }
}
const hatch = (warn: boolean) => (warn ? 'url(#evHatchWarn)' : 'url(#evHatch)');
function container(shape: string, frac: number, warn: boolean, x: number): SVGElement {
  const id = `evc${++uid}`;
  const d = outline(shape);
  const used = Math.max(0, Math.min(1, frac)) * 54;
  return s('g', { transform: `translate(${x},0)` }, [
    s('clipPath', { id }, [s('path', { d })]),
    s('g', { 'clip-path': `url(#${id})` }, [s('rect', { x: '0', y: '0', width: '40', height: '60', fill: hatch(warn) }), s('rect', { x: '0', y: String(58 - used), width: '40', height: String(used + 2), class: 'ev-used' })]),
    s('path', { d, class: 'ev-out' }),
  ]);
}
function tray(cells: number, used: number, warn: boolean, x: number): SVGElement {
  cells = Math.max(1, Math.min(Math.round(cells), 36));
  const cols = cells <= 4 ? 2 : cells <= 12 ? 4 : 6;
  const rows = Math.ceil(cells / cols);
  const cw = 34 / cols;
  const ch = Math.min(cw, 50 / rows);
  const kids: SVGElement[] = [s('rect', { x: '1', y: String(58 - rows * ch - 6), width: '38', height: String(rows * ch + 6), rx: '4', class: 'ev-tray' })];
  for (let i = 0; i < cells; i++) {
    kids.push(s('circle', { cx: String(3 + (i % cols) * cw + cw / 2), cy: String(55 - (Math.floor(i / cols) + 0.5) * ch), r: String(Math.min(cw, ch) / 2 - 1), class: i < used ? 'ev-used' : 'ev-free', fill: i < used ? null : hatch(warn) }));
  }
  return s('g', { transform: `translate(${x},0)` }, kids);
}
const more = (n: number, x: number) => s('text', { x: String(x), y: '40', class: 'ev-more' }, [document.createTextNode(`+${n}`)]);

/** Un envase dibujado por cada uno que se compra (como mucho 6; con más, «+N»). `role="img"` con su frase. */
function draw(r: PackPlan, opts: PackDrawOptions = {}): SVGSVGElement {
  defs();
  const shape = shapeOf(r);
  const warn = r.perishable;
  const kids: SVGElement[] = [];
  let n: number;
  if (shape === 'sin') {
    kids.push(s('path', { d: outline('box'), class: 'ev-dash' }), s('text', { x: '20', y: '40', 'text-anchor': 'middle', class: 'ev-q' }, [document.createTextNode('?')]));
    n = 1;
  } else if (shape === 'granel') {
    kids.push(s('path', { d: 'M2 30 Q20 62 38 30 Z', class: 'ev-used' }), s('path', { d: 'M2 30 Q20 62 38 30 Z', class: 'ev-out' }));
    n = 1;
  } else if (shape === 'units') {
    const us = r.unit === 'manojo' ? 'bunch' : r.unit === 'paquete' ? 'box' : 'unit';
    const tot = Math.max(1, Math.ceil(r.buy - EPS));
    n = tot > 6 ? 5 : tot;
    for (let i = 0; i < n; i++) kids.push(container(us, r.need - i, warn, i * 44));
    if (tot > 6) { kids.push(more(tot - 5, n * 44 + 4)); n = 6; }
  } else if (shape === 'tray') {
    const count = Math.max(1, r.count ?? 1);
    n = count > 6 ? 5 : count;
    const size = r.fmt!.size;
    for (let i = 0; i < n; i++) kids.push(tray(size, Math.max(0, Math.min(size, Math.ceil(r.need - i * size - EPS))), warn, i * 44));
    if (count > 6) { kids.push(more(count - 5, n * 44 + 4)); n = 6; }
  } else {
    const count = Math.max(1, r.count ?? 1);
    n = count > 6 ? 5 : count;
    for (let i = 0; i < n; i++) kids.push(container(shape, (r.need - i * r.fmt!.size) / r.fmt!.size, warn, i * 44));
    if (count > 6) { kids.push(more(count - 5, n * 44 + 4)); n = 6; }
  }
  const w = n * 44 - 4;
  const k = opts.scale || 1;
  return s('svg', { viewBox: `0 0 ${w} 60`, width: String(Math.round(w * k)), height: String(Math.round(60 * k)), role: 'img', 'aria-label': opts.label || words(r, opts), class: 'ev', focusable: 'false' }, kids) as SVGSVGElement;
}

/** La tira, para filas: una casilla por envase. */
function tube(r: PackPlan, opts: PackDrawOptions = {}): SVGSVGElement {
  defs();
  const n = r.kind === 'envase' ? Math.max(1, r.count ?? 1) : r.kind === 'entero' ? Math.max(1, Math.ceil(r.buy - EPS)) : 1;
  const size = r.kind === 'envase' ? r.fmt!.size : r.kind === 'entero' ? 1 : Math.max(r.need, EPS);
  const W = 300;
  const gap = n > 1 ? Math.min(4, 40 / n) : 0;
  const sw = (W - gap * (n - 1)) / n;
  const kids: SVGElement[] = [];
  if (r.kind === 'sin') kids.push(s('rect', { x: '1', y: '1', width: String(W - 2), height: '22', rx: '11', class: 'ev-dash' }));
  else for (let i = 0; i < n; i++) {
    const f = Math.max(0, Math.min(1, (r.need - i * size) / size));
    const x = i * (sw + gap);
    const id = `evt${++uid}`;
    const rx = n > 12 ? '2' : '8';
    kids.push(s('clipPath', { id }, [s('rect', { x: String(x), y: '1', width: String(sw), height: '22', rx })]),
      s('g', { 'clip-path': `url(#${id})` }, [s('rect', { x: String(x), y: '0', width: String(sw), height: '24', fill: hatch(r.perishable) }), s('rect', { x: String(x), y: '0', width: String(sw * f), height: '24', class: 'ev-used' })]),
      s('rect', { x: String(x), y: '1', width: String(sw), height: '22', rx, class: 'ev-out' }));
  }
  return s('svg', { viewBox: '0 0 300 24', preserveAspectRatio: 'none', class: 'ev ev-tube', role: 'img', 'aria-label': opts.label || words(r, opts), focusable: 'false' }, kids) as SVGSVGElement;
}

/** La leyenda: lo que se usa (macizo), lo que sobra (rayado) y lo que sobra y caduca pronto (rayado en ámbar). */
function legend(opts: { used?: string; keep?: string } = {}): HTMLElement {
  defs();
  const sw = (kind: 'use' | 'keep' | 'warn') => s('svg', { viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': 'true', focusable: 'false' },
    [s('rect', { width: '14', height: '14', rx: '3', class: kind === 'use' ? 'ev-used' : null, fill: kind === 'use' ? null : hatch(kind === 'warn') })]);
  const keep = cap(keepOf(opts));
  return el('p', { class: 'ev-legend' },
    el('span', null, sw('use'), opts.used || kt('Lo que se usa')),
    el('span', null, sw('keep'), keep),
    el('span', null, sw('warn'), kt('{keep}, caduca pronto', { keep })));
}

/* ---------- la hoja del envase ---------- */
const SUGGEST: Record<string, Array<[string, number, string]>> = {
  masa: [['bolsa de 250 g', 250, 'g'], ['paquete de 500 g', 500, 'g'], ['paquete de 1 kg', 1000, 'g'], ['saco de 5 kg', 5000, 'g']],
  volumen: [['botella de 500 ml', 500, 'ml'], ['botella de 1 l', 1000, 'ml'], ['garrafa de 5 l', 5000, 'ml']],
  unidad: [['pack de 6', 6, 'unidad'], ['docena', 12, 'unidad'], ['bandeja de 30', 30, 'unidad']],
};
const FACT: Record<string, number> = { g: 1, kg: 1000, ml: 1, l: 1000, unidad: 1 };
const famOf = (unit: string) => (unit === 'g' || unit === 'kg' ? 'masa' : unit === 'ml' || unit === 'l' ? 'volumen' : 'unidad');
const toUnit = (size: number, from: string, to: string) => (size * (FACT[from] ?? 1)) / (FACT[to] ?? 1);
const euros = (v: number) => Number(v).toLocaleString(kitLocaleTag(), { style: 'currency', currency: 'EUR' });
function day(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(kitLocaleTag(), { day: 'numeric', month: 'long' });
}
const same = (a: { label: string; size: number }, b: { label: string; size: number }) => a.label === b.label && Math.abs(a.size - b.size) < EPS;

interface Choice { label: string; size: number; price: number | null; existing: PackFormat | null }

/** La hoja «¿Cómo se vende…?» / «Envase de…»: el del último ticket, los que ya tiene, sugerencias, «Otro envase» y el precio. */
function formatSheet(o: PackSheetOptions): Sheet {
  const r = o.r;
  const first = r.kind !== 'envase';
  const fam = famOf(r.unit);
  const where = o.where || kt('en la Despensa');
  const base = o.feedbackId ?? null;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const existing = r.formats;
  const find = (c: { label: string; size: number }) => existing.find((f) => same(f, c)) ?? null;
  let pick: Choice | null = first || !r.fmt ? null : { label: r.fmt.label, size: r.fmt.size, price: r.fmt.price, existing: r.fmt };
  const preview = el('div', { class: 'fs-preview', 'aria-live': 'polite' });
  const price = el('input', { type: 'text', inputmode: 'decimal', class: 'qty', 'aria-label': kt('Precio del envase en euros'), placeholder: kt('Opcional'), autocomplete: 'off' });
  const chips: Array<{ b: HTMLButtonElement; f: Choice }> = [];
  const sim = (f: Choice) => plan({ need: r.need, unit: r.unit, formats: [{ label: f.label, size: f.size, price: f.price, usual: true }], perishable: r.perishable, perBase: r.perBase });
  function show(): void {
    if (!pick) { replace(preview, draw(r, { scale: 1.2, keep: o.keep }), el('p', null, kt('Elige cómo se vende y lo verás aquí.'))); }
    else {
      const p = sim(pick);
      const x = extraText(p);
      replace(preview, draw(p, { scale: 1.2, keep: o.keep }), el('p', null,
        el('b', null, kt('Hace falta {need}', { need: legible(p.need, p.unit) })), ` → ${kt('compras')} `, el('b', null, buyText(p)),
        x ? ` · ${kt('sobran {extra}', { extra: x })}` : ` · ${kt('no sobra nada')}`));
    }
    for (const c of chips) c.b.setAttribute('aria-pressed', String(!!pick && same(c.f, pick)));
  }
  function choose(f: Choice): void { pick = f; if (f.price !== null) price.value = num(f.price); show(); }
  const opts: Array<{ f: Choice; t: string; sub: string; main?: boolean }> = [];
  if (o.ticket && o.ticket.size > 0) {
    const t = o.ticket;
    const tp = toNum(t.price);
    const sub = [t.label, tp !== null ? euros(tp) : null, [t.supplier, t.date ? day(t.date) : null].filter(Boolean).join(', ') || null].filter(Boolean).join(' · ');
    opts.push({ f: { label: t.label, size: t.size, price: tp, existing: find(t) }, t: kt('Como en el último ticket'), sub, main: true });
  }
  existing.forEach((f) => {
    if (opts.some((x) => same(x.f, f))) return;
    const sub = [f === r.fmt ? kt('el habitual') : null, f.price !== null ? euros(f.price) : null].filter(Boolean).join(' · ');
    opts.push({ f: { label: f.label, size: f.size, price: f.price, existing: f }, t: f.label, sub });
  });
  for (const [label, size0, from] of SUGGEST[fam] ?? []) {
    const size = toUnit(size0, from, r.unit);
    if (!opts.some((x) => Math.abs(x.f.size - size) < EPS)) opts.push({ f: { label, size, price: null, existing: null }, t: label, sub: '' });
  }
  const grid = el('div', { class: 'fs-chips', role: 'group', 'aria-label': kt('Cómo se vende') }, ...opts.map((x) => {
    const b = el('button', { type: 'button', class: `fs-chip${x.main ? ' main' : ''}`, 'aria-pressed': 'false', ...mark('formato', 'Envase'), onclick: () => choose(x.f) }, el('b', null, x.t), x.sub ? el('small', null, x.sub) : null);
    chips.push({ b, f: x.f });
    return b;
  }));
  const qty = el('input', { type: 'text', inputmode: 'decimal', class: 'qty', 'aria-label': kt('Cuánto trae cada envase'), autocomplete: 'off' });
  const units = fam === 'masa' ? ['g', 'kg'] : fam === 'volumen' ? ['ml', 'l'] : ['unidad'];
  const unitSel = el('select', { 'aria-label': kt('Unidad') }, ...units.map((u) => el('option', { value: u }, u === 'unidad' ? kt('unidades') : u)));
  const kinds = ['bolsa', 'paquete', 'bote', 'botella', 'garrafa', 'caja', 'bandeja', 'brik', 'tarro', 'saco'];
  const kind = el('select', { 'aria-label': kt('Tipo de envase') }, ...kinds.map((k) => el('option', { value: k }, k)));
  const other = () => {
    const q = toNum(qty.value);
    if (q === null || q <= 0) return;
    const u = unitSel.value;
    const label = `${kind.value} de ${num(q)} ${u === 'unidad' ? (q === 1 ? 'unidad' : 'unidades') : u}`;
    const size = toUnit(q, u, r.unit);
    choose({ label, size, price: null, existing: find({ label, size }) });
  };
  qty.addEventListener('input', other);
  unitSel.addEventListener('change', other);
  kind.addEventListener('change', other);
  const body = el('div', { class: 'fs', ...(base ? { 'data-feedback-id': base, 'data-feedback-label': 'Envase' } : {}) },
    el('p', { class: 'fs-lead' }, first
      ? kt('Una vez y vale para todas las listas: se guarda en la ficha del artículo, {where}.', { where })
      : kt('Lo que cambies se guarda en la ficha del artículo, {where}.', { where })),
    preview, grid,
    el('details', { class: 'fs-other' }, el('summary', mark('otro', 'Otro envase'), kt('Otro envase')),
      el('div', { class: 'fs-otherrow' }, kind, el('span', null, kt('de')), qty, unitSel)),
    el('label', { class: 'field' }, el('span', null, kt('Precio del envase (€)')), price),
    existing.length ? el('p', { class: 'hint' }, kt('Si hay varios envases, se propone el habitual. El que guardes aquí pasa a serlo.')) : null);
  if (pick?.price != null) price.value = num(pick.price);
  show();
  const back = () => {
    const t = typeof o.returnFocus === 'function' ? o.returnFocus() : o.returnFocus;
    if (t && document.contains(t)) t.focus({ preventScroll: true });
  };
  const save = el('button', { type: 'button', class: 'primary', ...mark('guardar', 'Guardar el envase'), onclick: () => {
    if (!pick) { toast(kt('Elige cómo se vende.')); return; }
    const typed = toNum(price.value);
    const chosen: PackSaved = {
      label: pick.label, size: pick.existing ? pick.existing.size : pick.size,
      price: typed !== null && typed > 0 ? typed : pick.price ?? (r.perBase !== null ? r.perBase * pick.size : null),
      usual: true, plural: pick.existing?.plural ?? null, source: pick.existing?.source ?? null, isNew: !pick.existing,
    };
    // Los que ya existían conservan su tamaño (las recetas convierten con ellos); el elegido pasa a ser el habitual.
    const all: PackSaved[] = existing.map((f) => (pick!.existing === f ? chosen : { ...f, usual: false, isNew: false }));
    if (chosen.isNew) all.push(chosen);
    void sheet.close(true).then(() => {
      o.onSave(chosen, all);
      if (o.returnFocus) requestAnimationFrame(back);
    });
  } }, kt('Guardar {where}', { where }));
  const sheet = openSheet({
    title: first ? kt('¿Cómo se vende {name}?', { name: o.name.toLowerCase() }) : kt('Envase de {name}', { name: o.name.toLowerCase() }),
    body,
    foot: [el('button', { type: 'button', class: 'ghost', ...mark('cancelar', 'Cancelar'), onclick: () => void sheet.close() }, kt('Cancelar')), save],
    onClose: (why) => { if (why === 'close' && o.returnFocus) requestAnimationFrame(back); },
  });
  return sheet;
}

/** La pieza «envase» (MUELA-093 §5). */
export const Envase = { plan, packText, buyText, extraText, words, legible, draw, tube, legend, formatSheet };
