/**
 * Central · «Colocar solo» del mapa de zonas (tanda 36, MUELA-024): leer un SVG subido para colocar las estancias que
 * trae con su nombre.
 * - **Seguridad:** el SVG se limpia antes de leerlo con DOMPurify (perfil SVG: sin scripts, `foreignObject`, `on*` ni
 *   `javascript:`) y se recorre con `DOMParser`, en un documento aparte. **Nunca se mete en la página:** el plano se pinta
 *   como `<image>` (kit, `createSpaceMap`).
 * - **Nombres:** `id`, `data-name`, `inkscape:label`, `aria-label` o su `<title>`. Se comparan sin tildes, mayúsculas ni
 *   signos («dormitorio_3» = «Dormitorio 3»), con el nombre, el nombre público o el código de la estancia.
 * - **Formas:** `rect`, `polygon`, `polyline`, `circle`, `ellipse`, `line` y `path` con tramos rectos (M, L, H, V y Z);
 *   un grupo (`g`) con nombre da el rectángulo que lo contiene. Con las transformaciones `translate`, `scale` y `matrix`.
 *   Se leen todas las formas con nombre (también las capas, como «layer1»); solo cuentan las que se llaman como una estancia.
 *   El resultado, puntos entre 0 y 1 relativos al `viewBox`, como guarda `resources.spaces.plan_shape`.
 */
import DOMPurify from 'dompurify';

export interface SvgShape { name: string; points: Array<[number, number]> }
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

function parseTransform(value: string | null): Matrix {
  let m: Matrix = IDENTITY;
  if (!value) return m;
  for (const [, fn, raw] of value.matchAll(/(matrix|translate|scale)\s*\(([^)]*)\)/gi)) {
    const a = raw!.split(/[\s,]+/).filter(Boolean).map(Number);
    if (fn!.toLowerCase() === 'matrix' && a.length === 6) m = multiply(m, a as Matrix);
    else if (fn!.toLowerCase() === 'translate') m = multiply(m, [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]);
    else if (fn!.toLowerCase() === 'scale') m = multiply(m, [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]);
  }
  return m;
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

function matrixOf(node: Element, root: Element): Matrix {
  const chain: Element[] = [];
  for (let at: Element | null = node; at && at !== root; at = at.parentElement) chain.unshift(at);
  return chain.reduce((m, n) => multiply(m, parseTransform(n.getAttribute('transform'))), IDENTITY);
}

/** Todos los puntos de un elemento y lo que tiene dentro, ya transformados al sistema del dibujo. */
function pointsOf(node: Element, root: Element): Array<[number, number]> {
  const own = ownPoints(node);
  if (own.length) { const m = matrixOf(node, root); return own.map(([x, y]) => apply(m, x, y)); }
  return [...node.children].flatMap((c) => pointsOf(c, root));
}

const NAME_ATTRS = ['data-name', 'inkscape:label', 'aria-label', 'id'];
function nameOf(node: Element): string | null {
  for (const attr of NAME_ATTRS) { const v = node.getAttribute(attr); if (v && v.trim()) return v.trim(); }
  const title = [...node.children].find((c) => c.localName === 'title');
  return title?.textContent?.trim() || null;
}

/** «Dormitorio_3», «dormitorio-3» o «DORMITORIO 3» → «dormitorio 3». */
export const foldName = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Limpia (DOMPurify, perfil SVG) y lee el dibujo. `null` si no es un SVG que se pueda leer. */
export function readSvgPlan(text: string): SvgPlan | null {
  const clean = DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_ATTR: ['inkscape:label', 'data-name'], WHOLE_DOCUMENT: false });
  const doc = new DOMParser().parseFromString(String(clean), 'image/svg+xml');
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
    const raw = pointsOf(node, root);
    if (raw.length < 3) continue;
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

/** Empareja las formas con nombre con las estancias: por nombre, nombre público o código (sin tildes ni signos). */
export function matchShapes<S extends { id: string; name: string; publicName?: string | null; code?: string | null }>(plan: SvgPlan, spaces: readonly S[]): { placed: Array<{ space: S; points: Array<[number, number]> }>; unmatched: string[] } {
  const keys = new Map<string, S>();
  for (const s of spaces) for (const k of [s.name, s.publicName, s.code]) if (k && !keys.has(foldName(k))) keys.set(foldName(k), s);
  const placed: Array<{ space: S; points: Array<[number, number]> }> = [];
  const used = new Set<string>();
  const unmatched: string[] = [];
  for (const shape of plan.shapes) {
    const s = keys.get(foldName(shape.name));
    if (!s || used.has(s.id)) { if (!s) unmatched.push(shape.name); continue; }
    // Una forma sin área (todos los puntos en una línea) no sirve.
    const xs = shape.points.map((p) => p[0]); const ys = shape.points.map((p) => p[1]);
    if (Math.max(...xs) - Math.min(...xs) < 0.002 || Math.max(...ys) - Math.min(...ys) < 0.002) continue;
    used.add(s.id);
    placed.push({ space: s, points: shape.points });
  }
  return { placed, unmatched };
}
