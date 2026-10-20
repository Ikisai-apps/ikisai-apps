/**
 * Central · «Colocar solo» del mapa de zonas (tanda 36, MUELA-024; tanda 37, MUELA-092): limpiar el SVG que se sube y
 * leerlo para colocar las estancias que trae con su nombre.
 * - **Seguridad:** el SVG se limpia con DOMPurify (perfil SVG: sin scripts, `foreignObject`, `on*` ni `javascript:`) y
 *   **lo que se sube es el limpio** (`cleanSvg`), no el archivo original; el servidor rechaza el SVG con contenido activo
 *   (#694). Se recorre con `DOMParser`, en un documento aparte. **Nunca se mete en la página:** el plano se pinta como
 *   `<image>` (kit, `createSpaceMap`).
 * - **Nombres:** `id`, `data-name`, `inkscape:label`, `aria-label` o su `<title>`. Se comparan sin tildes, mayúsculas ni
 *   signos («dormitorio_3» = «Dormitorio 3»), con el nombre, el nombre público o el código de la estancia.
 * - **Formas:** `rect`, `polygon`, `polyline`, `circle`, `ellipse`, `line` y `path` con tramos rectos (M, L, H, V y Z);
 *   un grupo (`g`) con nombre da el rectángulo que lo contiene. Con la matriz completa de sus transformaciones
 *   (`translate`, `scale`, `rotate`, `skewX`, `skewY` y `matrix`): un rectángulo girado da sus cuatro esquinas giradas. Si
 *   la transformación no se puede leer (CSS, un `<svg>` dentro de otro o un valor roto), la forma lleva su `problem` y la
 *   estancia va a «Por revisar» con el motivo: nunca se coloca mal sin avisar.
 *   Se leen todas las formas con nombre (también las capas, como «layer1»); solo cuentan las que se llaman como una estancia.
 *   El resultado, puntos entre 0 y 1 relativos al `viewBox`, como guarda `resources.spaces.plan_shape`.
 */
import DOMPurify from 'dompurify';

export interface SvgShape { name: string; points: Array<[number, number]>; problem?: string }
export interface SvgPlan { width: number; height: number; shapes: SvgShape[] }

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const num = (v: string | null | undefined, fallback = 0) => { const n = Number.parseFloat(v ?? ''); return Number.isFinite(n) ? n : fallback; };
const rad = (deg: number) => (deg * Math.PI) / 180;

/** El motivo de «Por revisar» cuando la forma no se puede leer. */
export const UNREADABLE_TRANSFORM = 'el SVG la gira o la deforma de una manera que no se puede leer';

/** La matriz de un `transform`; `null` si trae algo que no se sabe leer (y entonces no se coloca sola). */
export function parseTransform(value: string | null): Matrix | null {
  let m: Matrix = IDENTITY;
  if (!value || !value.trim()) return m;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/giy;
  let at = 0;
  for (let hit = re.exec(value); hit; hit = re.exec(value)) {
    at = re.lastIndex;
    const fn = hit[1]!.toLowerCase();
    const a = hit[2]!.split(/[\s,]+/).filter(Boolean).map(Number);
    if (a.some((n) => !Number.isFinite(n))) return null;
    if (fn === 'matrix' && a.length === 6) m = multiply(m, a as Matrix);
    else if (fn === 'translate' && (a.length === 1 || a.length === 2)) m = multiply(m, [1, 0, 0, 1, a[0]!, a[1] ?? 0]);
    else if (fn === 'scale' && (a.length === 1 || a.length === 2)) m = multiply(m, [a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0]);
    else if (fn === 'rotate' && (a.length === 1 || a.length === 3)) {
      const c = Math.cos(rad(a[0]!)); const s = Math.sin(rad(a[0]!));
      const [cx, cy] = a.length === 3 ? [a[1]!, a[2]!] : [0, 0];
      m = multiply(multiply(multiply(m, [1, 0, 0, 1, cx, cy]), [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === 'skewx' && a.length === 1) m = multiply(m, [1, 0, Math.tan(rad(a[0]!)), 1, 0, 0]);
    else if (fn === 'skewy' && a.length === 1) m = multiply(m, [1, Math.tan(rad(a[0]!)), 0, 1, 0, 0]);
    else return null;
  }
  return at === value.length || !value.slice(at).trim() ? m : null;
}

/** Puntos de un `path` con tramos rectos; con curvas (C, Q, A…) se quedan sus extremos, que bastan para el contorno. */
function pathPoints(d: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let x = 0; let y = 0; let startX = 0; let startY = 0;
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let cmd = '';
  let i = 0;
  const take = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': case 'L': case 'T': { const nx = take(); const ny = take(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; if (cmd.toUpperCase() === 'M') { startX = x; startY = y; cmd = rel ? 'l' : 'L'; } out.push([x, y]); break; }
      case 'H': { const nx = take(); x = rel ? x + nx : nx; out.push([x, y]); break; }
      case 'V': { const ny = take(); y = rel ? y + ny : ny; out.push([x, y]); break; }
      case 'C': { take(); take(); take(); take(); const nx = take(); const ny = take(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; out.push([x, y]); break; }
      case 'S': case 'Q': { take(); take(); const nx = take(); const ny = take(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; out.push([x, y]); break; }
      case 'A': { take(); take(); take(); take(); take(); const nx = take(); const ny = take(); x = rel ? x + nx : nx; y = rel ? y + ny : ny; out.push([x, y]); break; }
      case 'Z': x = startX; y = startY; break;
      default: i++;
    }
    if (out.length > 400) break;
  }
  return out;
}

function ownPoints(node: Element): Array<[number, number]> {
  const a = (k: string) => num(node.getAttribute(k));
  switch (node.localName) {
    case 'rect': { const x = a('x'); const y = a('y'); const w = a('width'); const h = a('height'); return w > 0 && h > 0 ? [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] : []; }
    case 'circle': { const r = a('r'); const cx = a('cx'); const cy = a('cy'); return r > 0 ? [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]] : []; }
    case 'ellipse': { const rx = a('rx'); const ry = a('ry'); const cx = a('cx'); const cy = a('cy'); return rx > 0 && ry > 0 ? [[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]] : []; }
    case 'polygon': case 'polyline': {
      const n = (node.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const pts: Array<[number, number]> = [];
      for (let k = 0; k + 1 < n.length; k += 2) pts.push([n[k]!, n[k + 1]!]);
      return pts;
    }
    case 'path': return pathPoints(node.getAttribute('d') ?? '');
    default: return [];
  }
}

/** La transformación de un elemento hasta la raíz; `null` si alguna no se puede leer (CSS o un `<svg>` dentro). */
function matrixOf(node: Element, root: Element): Matrix | null {
  const chain: Element[] = [];
  for (let at: Element | null = node; at && at !== root; at = at.parentElement) chain.unshift(at);
  let m: Matrix = IDENTITY;
  for (const n of chain) {
    if (n.localName === 'svg' || /(?:^|;)\s*transform(?:-origin|-box)?\s*:/i.test(n.getAttribute('style') ?? '')) return null;
    const t = parseTransform(n.getAttribute('transform'));
    if (!t) return null;
    m = multiply(m, t);
  }
  return m;
}

/** Todos los puntos de un elemento y lo que tiene dentro, ya transformados al sistema del dibujo. */
function pointsOf(node: Element, root: Element): { points: Array<[number, number]>; readable: boolean } {
  const own = ownPoints(node);
  if (own.length) {
    const m = matrixOf(node, root);
    return m ? { points: own.map(([x, y]) => apply(m, x, y)), readable: true } : { points: own, readable: false };
  }
  let readable = true;
  const points = [...node.children].flatMap((c) => { const r = pointsOf(c, root); readable &&= r.readable; return r.points; });
  return { points, readable };
}

const NAME_ATTRS = ['data-name', 'inkscape:label', 'aria-label', 'id'];
function nameOf(node: Element): string | null {
  for (const attr of NAME_ATTRS) { const v = node.getAttribute(attr); if (v && v.trim()) return v.trim(); }
  const title = [...node.children].find((c) => c.localName === 'title');
  return title?.textContent?.trim() || null;
}

/** «Dormitorio_3», «dormitorio-3» o «DORMITORIO 3» → «dormitorio 3». */
export const foldName = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Los nombres que pone el programa de dibujo (`layer1`, `rect123`, «Capa 1»…): no son estancias ni hay que avisar de ellos. */
export const generatedName = (name: string) => /^(?:layer|capa|group|grupo|g|svg|rect|path|polygon|polyline|circle|ellipse|line|text|tspan|use|image|defs|title|metadata|namedview|base)[\s_-]*\d*$/i.test(name.trim());

// --- Limpieza ---------------------------------------------------------------------------------------------------

/** Una instancia propia (sus reglas no tocan a otros usos), creada al usarla: el módulo se carga también en Node (pruebas). */
let purifier: ReturnType<typeof DOMPurify> | null = null;
/** Lo que el servidor rechaza (#694) y DOMPurify deja pasar en algún caso (un `data:text/html` en `<image>` o CSS). */
const ACTIVE_LINK = /(?:java|vb)script\s*:|data\s*:\s*text\/html|expression\s*\(|@import/i;
const flat = (v: string) => v.replace(/&#x?[0-9a-f]+;?|[\t\n\r]/gi, '');

/** Lo que aún sería contenido activo en un SVG ya limpio, con las mismas reglas que la verificación del servidor. */
export function activeContent(text: string): string | null {
  const t = text.replace(/<!--[\s\S]*?-->/g, '');
  if (/<\s*(?:[a-z0-9_-]+:)?(?:script|foreignObject|iframe|embed|object)\b/i.test(t)) return 'elemento';
  if (/[\s"'/]on[a-z]+\s*=/i.test(t)) return 'manejador';
  if (/(?:java|vb)script\s*:|data\s*:\s*text\/html/i.test(flat(t))) return 'enlace';
  if (/<!ENTITY/i.test(t)) return 'entidad';
  return null;
}

/**
 * El SVG limpio, listo para subir: DOMPurify (perfil SVG) y, además, fuera los enlaces que no son de dentro del dibujo
 * (`#…`) ni imágenes incrustadas, el CSS con enlaces activos y los atributos de programas de dibujo sin su espacio de
 * nombres (`inkscape:label` pasa a `data-name`, para no perder el nombre). `null` si no queda un SVG con tamaño o si,
 * aun limpio, sigue llevando contenido activo.
 */
export function cleanSvg(text: string): string | null {
  purifier ??= DOMPurify(window);
  const fragment = purifier.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_ATTR: ['inkscape:label', 'data-name'], RETURN_DOM_FRAGMENT: true });
  const svg = [...fragment.children].find((c) => c.localName === 'svg');
  if (!svg) return null;
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    if (node.localName === 'style' && ACTIVE_LINK.test(flat(node.textContent ?? ''))) { node.remove(); continue; }
    const label = node.getAttribute('inkscape:label');
    if (label && !node.hasAttribute('data-name')) node.setAttribute('data-name', label);
    for (const attr of [...node.attributes]) {
      const value = flat(attr.value);
      const isLink = attr.localName === 'href';
      if ((!attr.namespaceURI && attr.name.includes(':')) || ACTIVE_LINK.test(value)
        || (isLink && !value.trim().startsWith('#') && !/^data:image\/(?:png|jpe?g|gif|webp);/i.test(value.trim()))) node.removeAttributeNode(attr);
    }
  }
  const out = new XMLSerializer().serializeToString(svg);
  return activeContent(out) ? null : out;
}

/** Limpia (DOMPurify, perfil SVG) y lee el dibujo. `null` si no es un SVG que se pueda leer. */
export function readSvgPlan(text: string): SvgPlan | null {
  const clean = cleanSvg(text);
  if (!clean) return null;
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.querySelector('parsererror')) return null;
  const box = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const [vx, vy, vw, vh] = box.length === 4 && box[2]! > 0 && box[3]! > 0 ? box as [number, number, number, number] : [0, 0, num(root.getAttribute('width'), 0), num(root.getAttribute('height'), 0)];
  if (!(vw > 0 && vh > 0)) return null;
  const shapes: SvgShape[] = [];
  for (const node of root.querySelectorAll('*')) {
    if (['title', 'desc', 'defs', 'style', 'metadata'].includes(node.localName) || node.closest('defs')) continue;
    const name = nameOf(node);
    if (!name) continue;
    const { points: raw, readable } = pointsOf(node, root);
    if (raw.length < 3) continue;
    if (!readable) { shapes.push({ name, points: [], problem: UNREADABLE_TRANSFORM }); continue; }
    // Un grupo da el rectángulo que lo contiene; una forma, sus puntos (como mucho 200, que es lo que guarda Recursos).
    let pts = raw;
    if (node.localName === 'g' || raw.length > 200) {
      const xs = raw.map((p) => p[0]); const ys = raw.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    }
    const norm = pts.map(([x, y]) => [clamp01((x - vx) / vw), clamp01((y - vy) / vh)] as [number, number]);
    shapes.push({ name, points: norm });
  }
  return { width: vw, height: vh, shapes };
}

const clamp01 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;

/**
 * Empareja las formas con nombre con las estancias: por nombre, nombre público o código (sin tildes ni signos).
 * `skipped`: las estancias nombradas cuya forma no se ha podido leer, con el motivo (van a «Por revisar»).
 * `unmatched`: los nombres del SVG que no son de ninguna de `spaces`.
 */
export function matchShapes<S extends { id: string; name: string; publicName?: string | null; code?: string | null }>(plan: SvgPlan, spaces: readonly S[]): {
  placed: Array<{ space: S; points: Array<[number, number]> }>; skipped: Array<{ space: S; reason: string }>; unmatched: string[];
} {
  const keys = new Map<string, S>();
  for (const s of spaces) for (const k of [s.name, s.publicName, s.code]) if (k && !keys.has(foldName(k))) keys.set(foldName(k), s);
  const placed: Array<{ space: S; points: Array<[number, number]> }> = [];
  const skipped: Array<{ space: S; reason: string }> = [];
  const used = new Set<string>();
  const unmatched: string[] = [];
  for (const shape of plan.shapes) {
    const s = keys.get(foldName(shape.name));
    if (!s || used.has(s.id)) { if (!s) unmatched.push(shape.name); continue; }
    if (shape.problem) { used.add(s.id); skipped.push({ space: s, reason: shape.problem }); continue; }
    // Una forma sin área (todos los puntos en una línea) no sirve.
    const xs = shape.points.map((p) => p[0]); const ys = shape.points.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) < 0.002 || Math.max(...ys) - Math.min(...ys) < 0.002) continue;
    used.add(s.id);
    placed.push({ space: s, points: shape.points });
  }
  return { placed, skipped, unmatched };
}
