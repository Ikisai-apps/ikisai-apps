import { METHOD_STEP_MAX, methodStepsFromText, type MethodStep } from '@ikisai/domain-food';
import { el, icon } from '@ikisai/ui-kit';
import {
  blockEnd, canIndent, dropDepths, flatten, hasSubsteps, indent, moveBlock, moveDown, moveUp, normalize, numbering, outdent, snapGap, toTree,
  type Depth, type FlatRow,
} from '../app/method-tree.ts';
import { fb } from './feedback.ts';

/** Pasos de la elaboración de una receta: `method_steps` o, si la receta es anterior, su `method` convertido al vuelo. */
export function stepsOf(recipe: { method: string | null; method_steps?: MethodStep[] | null }): MethodStep[] {
  if (Array.isArray(recipe.method_steps) && recipe.method_steps.length) return recipe.method_steps;
  let n = 0;
  return methodStepsFromText(recipe.method, () => `t${++n}`);
}

/** Elaboración en lectura: lista numerada 1, 1.1, 2… con los subpasos sangrados (ficha, vista de cocinero e impresión). */
export function methodStepsView(recipe: { method: string | null; method_steps?: MethodStep[] | null }): HTMLElement | null {
  const steps = stepsOf(recipe);
  if (!steps.length) return null;
  const item = (number: string, step: MethodStep, inner: HTMLElement | null) =>
    el('li', { class: 'methodstep' }, el('span', { class: 'stepnum' }, number), el('span', { class: 'steptext' }, step.text), inner);
  return el('ol', { class: 'methodsteps', 'aria-label': 'Elaboración' }, ...steps.map((step, i) => item(`${i + 1}`, step,
    step.steps?.length ? el('ol', { class: 'methodsteps sub' }, ...step.steps.map((sub, j) => item(`${i + 1}.${j + 1}`, sub, null))) : null)));
}

/** Una fila del editor. Sus nodos se crean una vez y solo se recolocan (no se pierde lo escrito ni el foco). */
interface RowModel extends FlatRow {
  node: HTMLLIElement;
  area: HTMLTextAreaElement;
  num: HTMLElement;
  handle: HTMLButtonElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
  indentBtn: HTMLButtonElement;
  outdentBtn: HTMLButtonElement;
  remove: HTMLButtonElement;
  /** «Añadir subpaso» de un paso: se coloca tras su último subpaso. */
  addSub: HTMLLIElement;
  addSubBtn: HTMLButtonElement;
}

export interface StepsEditor {
  element: HTMLElement;
  /** Pasos con texto, en orden; un paso vacío con subpasos los deja en el primer nivel. */
  value(): MethodStep[];
  /** Si la elaboración es distinta de la que se abrió. */
  changed(): boolean;
}

let editors = 0;
/** Desplazamiento horizontal (px) a partir del cual el arrastre mete (derecha) o saca (izquierda) de nivel. */
const LEVEL_SHIFT = 24;

/**
 * Editor de la elaboración por bloques (FB_2026_028, «subpasos sin restricción, como las tareas de Tasks»): una sola
 * lista plana de filas con profundidad 1 (paso) o 2 (subpaso), numeradas 1, 1.1… Un subpaso se puede llevar a otro paso
 * y cualquier fila se puede meter o sacar de nivel (dos como máximo; reglas en `app/method-tree.ts`):
 * - dedo y ratón: arrastrar el asa (en táctil, al moverla o tras una pulsación corta); a la derecha mete de nivel y a la
 *   izquierda saca; una línea con el número que tendrá indica dónde cae;
 * - teclado, con el asa enfocada: ↑/↓ mueven (un paso, con sus subpasos), → mete de nivel, ← saca, Esc cancela un arrastre;
 * - botones en cada fila: Subir, Bajar y Meter en el paso anterior / Sacar de nivel.
 */
export function createStepsEditor(initial: MethodStep[], onChange: () => void): StepsEditor {
  const uid = `steps${++editors}`;
  let rows: RowModel[] = [];

  const live = el('div', { class: 'vh', 'aria-live': 'polite' });
  const howto = el('span', { class: 'vh', id: `${uid}-howto` }, 'Arrastra, o usa las flechas: arriba y abajo para mover, derecha para meter en el paso anterior, izquierda para sacar de nivel.');
  const list = el('ol', { 'data-feedback-id': 'food.recetario.formulario.pasos', 'data-feedback-label': 'Pasos de la elaboración', class: 'stepslist', 'aria-label': 'Pasos de la elaboración' });
  const indicator = el('div', { class: 'stepdrop', 'aria-hidden': 'true', hidden: true }, el('span', { class: 'stepdrop-label' }));
  const empty = el('p', { class: 'muted stepsempty' }, 'Sin pasos todavía.');

  const flat = (): FlatRow[] => rows.map((m) => ({ id: m.id, depth: m.depth }));
  const what = (depth: Depth) => (depth === 1 ? 'Paso' : 'Subpaso');
  const nameOf = (i: number, nums = numbering(rows)) => `${what(rows[i]!.depth)} ${nums[i]}`;
  const announce = (text: string) => { live.textContent = ''; live.textContent = text; };

  /** Coloca los nodos en el orden de `rows` moviéndolos (sin recrearlos) y pone números, etiquetas y botones al día. */
  function paint(): void {
    const active = document.activeElement as HTMLElement | null;
    const keep = active && list.contains(active) ? active : null;
    const selection = keep instanceof HTMLTextAreaElement ? [keep.selectionStart, keep.selectionEnd] as const : null;

    const sequence: HTMLElement[] = [];
    let owner: RowModel | null = null;
    rows.forEach((m, i) => {
      if (m.depth === 1) owner = m;
      sequence.push(m.node);
      if (owner && (i + 1 === rows.length || rows[i + 1]!.depth === 1)) sequence.push(owner.addSub);
    });
    sequence.forEach((node, k) => { if (list.children[k] !== node) list.insertBefore(node, list.children[k] ?? null); });
    while (list.children.length > sequence.length) list.lastElementChild!.remove();

    const nums = numbering(rows);
    const order = flat();
    rows.forEach((m, i) => {
      const n = nums[i]!;
      const sub = m.depth === 2;
      const label = `${what(m.depth)} ${n}`;
      const lower = label.toLowerCase();
      m.node.className = sub ? 'steprow sub' : 'steprow';
      m.node.dataset.depth = String(m.depth);
      m.num.textContent = n;
      m.area.setAttribute('aria-label', label);
      m.area.placeholder = sub ? 'Subpaso' : 'Qué hay que hacer en este paso';
      if (sub) fb(m.area, { feedbackId: 'food.recetario.formulario.subpaso', feedbackLabel: 'Subpaso' });
      else fb(m.area, { feedbackId: 'food.recetario.formulario.paso', feedbackLabel: 'Paso' });
      m.handle.setAttribute('aria-label', `Mover ${lower}`);
      m.up.setAttribute('aria-label', `Subir ${lower}`);
      m.up.disabled = !moveUp(order, i);
      m.down.setAttribute('aria-label', `Bajar ${lower}`);
      m.down.disabled = !moveDown(order, i);
      m.indentBtn.hidden = sub;
      m.indentBtn.disabled = !canIndent(order, i);
      m.indentBtn.setAttribute('aria-label', i > 0 ? `Meter ${lower} en el paso ${previousStep(nums, i)}` : `Meter ${lower} en el paso anterior`);
      m.indentBtn.title = hasSubsteps(order, i) ? 'Un paso con subpasos no se puede meter en otro' : i === 0 ? 'El primer paso no se puede meter en otro' : 'Meter en el paso anterior';
      m.outdentBtn.hidden = !sub;
      m.outdentBtn.setAttribute('aria-label', `Sacar ${lower} de nivel`);
      m.remove.setAttribute('aria-label', `Quitar ${lower}`);
      m.addSubBtn.setAttribute('aria-label', `Añadir subpaso al paso ${n}`);
    });
    empty.hidden = rows.length > 0;

    if (keep && document.activeElement !== keep) {
      if (keep.isConnected && !(keep as HTMLButtonElement).disabled && !keep.hidden) keep.focus({ preventScroll: true });
      if (selection && keep instanceof HTMLTextAreaElement) keep.setSelectionRange(selection[0], selection[1]);
    }
  }

  /** Número del paso que hay encima de la fila `i` (el que la recibiría al meterla de nivel). */
  function previousStep(nums: string[], i: number): string {
    for (let k = i - 1; k >= 0; k -= 1) if (rows[k]!.depth === 1) return nums[k]!;
    return '';
  }

  /** Aplica un orden nuevo (o avisa de por qué no se puede) y anuncia el número nuevo de la fila movida. */
  function apply(next: FlatRow[] | null, m: RowModel, refusal: string, focus: HTMLElement | null): boolean {
    if (!next) { announce(refusal); return false; }
    const before = nameOf(rows.indexOf(m));
    const same = next.length === rows.length && next.every((r, k) => r.id === rows[k]!.id && r.depth === rows[k]!.depth);
    if (same) return false;
    const byId = new Map(rows.map((r) => [r.id, r]));
    rows = next.map((r) => { const model = byId.get(r.id)!; model.depth = r.depth; return model; });
    paint();
    onChange();
    const after = nameOf(rows.indexOf(m));
    announce(before === after ? `${after}.` : `${before}, ahora ${after.toLowerCase()}.`);
    const target = focus && focus.isConnected && !(focus as HTMLButtonElement).disabled && !focus.hidden ? focus : m.handle;
    if (document.activeElement !== target) target.focus({ preventScroll: true });
    m.node.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  function step(m: RowModel, action: 'up' | 'down' | 'in' | 'out', focus: HTMLElement | null): void {
    const order = flat();
    const i = rows.indexOf(m);
    if (action === 'up') apply(moveUp(order, i), m, 'No se puede subir más.', focus);
    else if (action === 'down') apply(moveDown(order, i), m, 'No se puede bajar más.', focus);
    else if (action === 'in') {
      apply(indent(order, i), m, m.depth === 2 ? 'Ya es un subpaso: solo hay dos niveles.'
        : hasSubsteps(order, i) ? 'Un paso con subpasos no se puede meter en otro paso.' : 'El primer paso no se puede meter en otro paso.', focus);
    } else apply(outdent(order, i), m, 'Ya es un paso.', focus);
  }

  function removeRow(m: RowModel): void {
    const i = rows.indexOf(m);
    const end = blockEnd(rows, i); // un paso se va con sus subpasos
    rows = [...rows.slice(0, i), ...rows.slice(end)];
    if (rows[0]?.depth === 2) rows[0].depth = 1; // la primera fila siempre es un paso
    paint();
    onChange();
    (rows[Math.max(0, i - 1)]?.area ?? add).focus();
  }

  function onKey(e: KeyboardEvent, m: RowModel): void {
    const keys: Record<string, 'up' | 'down' | 'in' | 'out'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'in', ArrowLeft: 'out' };
    const action = keys[e.key];
    if (!action || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || drag) return;
    e.preventDefault();
    step(m, action, m.handle);
  }

  function make(id: string, text: string, depth: Depth): RowModel {
    const area = el('textarea', { 'data-field-id': 'food.recetario.formulario.paso', 'data-field-entity': 'food.recipes', 'data-field-prop': 'method_steps', 'data-feedback-id': 'food.recetario.formulario.paso', 'data-feedback-label': 'Paso', class: 'steparea', rows: '2', maxlength: String(METHOD_STEP_MAX) });
    area.value = text;
    const small = (attrs: Record<string, string>, name: Parameters<typeof icon>[0], action: 'up' | 'down' | 'in' | 'out') => {
      const button: HTMLButtonElement = el('button', { ...attrs, class: 'iconbtn small stepmove', type: 'button', title: attrs['data-feedback-label']!, onclick: () => step(m, action, button) }, icon(name, 16));
      return button;
    };
    const m: RowModel = {
      id, depth, area,
      node: el('li', { class: 'steprow' }),
      num: el('span', { class: 'stepnum', 'aria-hidden': 'true' }),
      handle: el('button', { 'data-feedback-id': 'food.recetario.formulario.mover_paso', 'data-feedback-label': 'Mover paso', class: 'stephandle', type: 'button', title: 'Arrastrar o usar las flechas',
        'aria-describedby': `${uid}-howto`, onkeydown: (e: Event) => onKey(e as KeyboardEvent, m), onpointerdown: (e: Event) => onPointerDown(e as PointerEvent, m),
        oncontextmenu: (e: Event) => e.preventDefault() }, icon('grip', 18)),
      up: small({ 'data-feedback-id': 'food.recetario.formulario.subir_paso', 'data-feedback-label': 'Subir' }, 'chevronUp', 'up'),
      down: small({ 'data-feedback-id': 'food.recetario.formulario.bajar_paso', 'data-feedback-label': 'Bajar' }, 'chevronDown', 'down'),
      indentBtn: small({ 'data-feedback-id': 'food.recetario.formulario.meter_nivel', 'data-feedback-label': 'Meter en el paso anterior' }, 'chevronRight', 'in'),
      outdentBtn: small({ 'data-feedback-id': 'food.recetario.formulario.sacar_nivel', 'data-feedback-label': 'Sacar de nivel' }, 'chevronLeft', 'out'),
      remove: el('button', { 'data-feedback-id': 'food.recetario.formulario.quitar_paso', 'data-feedback-label': 'Quitar paso', class: 'iconbtn small stepmove', type: 'button', title: 'Quitar', onclick: () => removeRow(m) }, icon('close', 16)),
      addSubBtn: el('button', { 'data-feedback-id': 'food.recetario.formulario.anadir_subpaso', 'data-feedback-label': 'Añadir subpaso', class: 'linkbtn addsub', type: 'button',
        onclick: () => {
          const i = rows.indexOf(m);
          const end = blockEnd(rows, i);
          const sub = make(crypto.randomUUID(), '', 2);
          rows = [...rows.slice(0, end), sub, ...rows.slice(end)];
          paint();
          onChange();
          sub.area.focus();
        } }, icon('plus', 16), 'Añadir subpaso'),
      addSub: el('li', { class: 'stepaddsub' }),
    };
    m.addSub.append(m.addSubBtn);
    m.node.append(m.handle, m.num, area, el('div', { class: 'stepmoves' }, m.up, m.down), el('div', { class: 'stepmoves' }, m.indentBtn, m.outdentBtn, m.remove));
    return m;
  }

  // --- Arrastre con Pointer Events (ratón, dedo y lápiz) -------------------------------------------------------
  let drag: { cancel(): void } | null = null;

  /** Contenedor que se desplaza (el cuerpo de la hoja) o la ventana. */
  function scroller(): HTMLElement {
    for (let node = list.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  }

  function onPointerDown(e: PointerEvent, m: RowModel): void {
    if (e.button !== 0 || drag) return;
    const handle = m.handle;
    const touch = e.pointerType !== 'mouse';
    try { handle.setPointerCapture(e.pointerId); } catch { /* sin captura, los eventos siguen llegando mientras el puntero esté encima */ }
    const startX = e.clientX, startY = e.clientY;
    const scroll = scroller();
    const pageScroll = scroll === document.scrollingElement || scroll === document.documentElement;
    const scrollTop = () => (pageScroll ? window.scrollY : scroll.scrollTop);
    const startScroll = scrollTop();
    let x = startX, y = startY;
    let started = false;
    let frame = 0;
    let target: { gap: number; depth: Depth; next: FlatRow[] } | null = null;
    const i0 = rows.indexOf(m);
    const order0 = flat();
    const end0 = blockEnd(order0, i0);
    const block = rows.slice(i0, end0);
    const lifted: HTMLElement[] = [...block.map((b) => b.node), ...(m.depth === 1 ? [m.addSub] : [])];
    const rest = rows.filter((r) => !block.includes(r));
    const restFlat: FlatRow[] = rest.map((r) => ({ id: r.id, depth: r.depth }));
    const timer = touch ? setTimeout(start, 250) : null;

    function start(): void {
      if (started) return;
      started = true;
      document.body.classList.add('dragging');
      for (const node of lifted) node.classList.add('lifting');
      indicator.hidden = false;
      frame = requestAnimationFrame(tick);
      update();
    }

    /** Hueco y profundidad según la posición del puntero; mueve la fila con él y pinta el indicador. */
    function update(): void {
      const dy = y - startY + (scrollTop() - startScroll);
      for (const node of lifted) node.style.transform = `translate(${Math.max(-20, Math.min(40, x - startX))}px, ${dy}px)`;
      let gap = rest.length;
      for (let k = 0; k < rest.length; k += 1) {
        const r = rest[k]!.node.getBoundingClientRect();
        if (y < r.top + r.height / 2) { gap = k; break; }
      }
      if (block.length > 1) gap = snapGap(restFlat, gap);
      const shift = x - startX;
      const wanted: Depth = shift > LEVEL_SHIFT ? 2 : shift < -LEVEL_SHIFT ? 1 : m.depth;
      const allowed = dropDepths(restFlat, gap, block.length === 1);
      const depth = allowed.includes(wanted) ? wanted : allowed[0]!;
      const next = moveBlock(order0, i0, gap, depth);
      target = next ? { gap, depth, next } : null;
      paintIndicator(gap, depth, next);
    }

    function paintIndicator(gap: number, depth: Depth, next: FlatRow[] | null): void {
      if (!next) { indicator.hidden = true; return; }
      indicator.hidden = false;
      const box = list.getBoundingClientRect();
      // Un subpaso cae justo bajo la fila de encima (antes de «Añadir subpaso»); un paso, justo encima de la fila de debajo.
      const above = rest[gap - 1]?.node.getBoundingClientRect();
      const below = rest[gap]?.node.getBoundingClientRect();
      const tail = Array.from(list.children).filter((node) => !lifted.includes(node as HTMLElement)).pop();
      const top = depth === 2 && above ? above.bottom : below ? below.top : (tail?.getBoundingClientRect().bottom ?? box.top);
      indicator.style.top = `${top - box.top - 1}px`;
      indicator.dataset.depth = String(depth);
      const k = next.findIndex((r) => r.id === m.id);
      indicator.firstElementChild!.textContent = `${what(depth)} ${numbering(next)[k]}`;
    }

    function tick(): void {
      const box = pageScroll ? { top: 0, bottom: window.innerHeight } : scroll.getBoundingClientRect();
      const edge = 56;
      const speed = y < box.top + edge ? -Math.ceil((box.top + edge - y) / 4) : y > box.bottom - edge ? Math.ceil((y - box.bottom + edge) / 4) : 0;
      if (speed) {
        if (pageScroll) window.scrollBy(0, speed); else scroll.scrollTop += speed;
        update();
      }
      frame = requestAnimationFrame(tick);
    }

    const move = (ev: PointerEvent) => {
      x = ev.clientX; y = ev.clientY;
      if (!started) {
        if (Math.hypot(x - startX, y - startY) < (touch ? 6 : 4)) return;
        start();
      }
      ev.preventDefault();
      update();
    };
    const finish = (commit: boolean) => {
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);
      document.removeEventListener('keydown', escape, true);
      for (const node of lifted) { node.classList.remove('lifting'); node.style.transform = ''; }
      indicator.hidden = true;
      document.body.classList.remove('dragging');
      drag = null;
      if (started && commit && target) apply(target.next, m, '', m.handle);
      else if (started) announce('Movimiento cancelado.');
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const escape = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); } };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', escape, true);
    drag = { cancel };
  }

  rows = normalize(flatten(initial)).map((s) => make(s.id, s.text, s.depth));
  if (!rows.length) rows = [make(crypto.randomUUID(), '', 1)]; // un primer bloque vacío para empezar a escribir
  const add = el('button', { 'data-feedback-id': 'food.recetario.formulario.anadir_paso', 'data-feedback-label': 'Añadir paso', class: 'ghost', type: 'button', id: 'addStep',
    onclick: () => {
      const m = make(crypto.randomUUID(), '', 1);
      rows = [...rows, m];
      paint();
      onChange();
      m.area.focus();
    } }, icon('plus', 18), 'Añadir paso');
  const element = el('div', { 'data-feedback-id': 'food.recetario.formulario.elaboracion', 'data-feedback-label': 'Elaboración', class: 'field stepsfield', id: 'r-method' },
    el('span', null, 'Elaboración'), el('div', { class: 'stepslist-wrap' }, list, indicator, howto, live), empty, add,
    el('span', { class: 'hint' }, 'Un bloque por paso, de una o dos líneas. Arrastra el asa para mover: hacia la derecha lo mete como subpaso y hacia la izquierda lo saca. También con las flechas sobre el asa o con los botones de cada paso.'));

  const value = (): MethodStep[] => toTree(rows.map((m) => ({ id: m.id, depth: m.depth, text: m.area.value })));
  paint();
  const start = JSON.stringify(value());
  return { element, value, changed: () => JSON.stringify(value()) !== start };
}
