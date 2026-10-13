import { METHOD_STEP_MAX, methodStepsFromText, type MethodStep } from '@ikisai/domain-food';
import { createSortableList, el, icon, type Sortable } from '@ikisai/ui-kit';
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

/** Un paso del editor. Sus nodos se crean una vez y las listas ordenables solo los recolocan (no se pierde lo escrito ni el foco). */
interface StepModel {
  id: string;
  parent: StepModel | null;
  area: HTMLTextAreaElement;
  num: HTMLElement;
  remove: HTMLElement;
  addSub: HTMLElement | null;
  subs: StepModel[];
  subList: Sortable<StepModel> | null;
  node: HTMLElement;
}

export interface StepsEditor {
  element: HTMLElement;
  /** Pasos con texto, en orden; un paso vacío con subpasos los deja en el primer nivel. */
  value(): MethodStep[];
  /** Si la elaboración es distinta de la que se abrió. */
  changed(): boolean;
}

/**
 * Editor de la elaboración por bloques (FB_2026_028): pasos de una o dos líneas con subpasos (dos niveles), numerados
 * (1, 1.1…) y reordenables con la lista del kit (asa, teclado y subir/bajar). Una lista para los pasos y una por paso para
 * sus subpasos; se crean una vez y se actualizan con `setItems`.
 */
export function createStepsEditor(initial: MethodStep[], onChange: () => void): StepsEditor {
  let steps: StepModel[] = [];

  const numberOf = (m: StepModel): string => (m.parent ? `${steps.indexOf(m.parent) + 1}.${m.parent.subs.indexOf(m) + 1}` : `${steps.indexOf(m) + 1}`);

  function renumber(): void {
    for (const m of steps) for (const s of [m, ...m.subs]) {
      const n = numberOf(s);
      const what = s.parent ? 'Subpaso' : 'Paso';
      s.num.textContent = n;
      s.area.setAttribute('aria-label', `${what} ${n}`);
      s.remove.setAttribute('aria-label', `Quitar ${what.toLowerCase()} ${n}`);
      s.addSub?.setAttribute('aria-label', `Añadir subpaso al paso ${n}`);
    }
    empty.hidden = steps.length > 0;
  }

  /** Repinta las listas (las etiquetas de mover llevan el número) y la numeración visible. */
  function refresh(): void {
    list.setItems(steps);
    for (const m of steps) { m.subList!.setItems(m.subs); m.subList!.element.hidden = m.subs.length === 0; }
    renumber();
  }

  function removeStep(m: StepModel): void {
    if (m.parent) m.parent.subs = m.parent.subs.filter((s) => s !== m);
    else steps = steps.filter((s) => s !== m);
    refresh();
    onChange();
  }

  function make(step: MethodStep | null, parent: StepModel | null): StepModel {
    const area = parent
      ? el('textarea', { 'data-feedback-id': 'food.recetario.formulario.subpaso', 'data-feedback-label': 'Subpaso', class: 'steparea', rows: '2', maxlength: String(METHOD_STEP_MAX), placeholder: 'Subpaso' })
      : el('textarea', { 'data-feedback-id': 'food.recetario.formulario.paso', 'data-feedback-label': 'Paso', class: 'steparea', rows: '2', maxlength: String(METHOD_STEP_MAX), placeholder: 'Qué hay que hacer en este paso' });
    area.value = step?.text ?? '';
    const m: StepModel = {
      id: step?.id ?? crypto.randomUUID(), parent, area, subs: [], subList: null, addSub: null,
      num: el('span', { class: 'stepnum', 'aria-hidden': 'true' }),
      remove: el('button', { 'data-feedback-id': 'food.recetario.formulario.quitar_paso', 'data-feedback-label': 'Quitar paso', class: 'iconbtn', type: 'button', title: 'Quitar', onclick: () => removeStep(m) }, icon('close', 18)),
      node: el('div'),
    };
    const head = el('div', { class: 'stephead' }, m.num, area, m.remove);
    if (parent) {
      m.node = el('div', { class: 'stepedit sub' }, head);
      return m;
    }
    m.subs = (step?.steps ?? []).map((s) => make(s, m));
    m.subList = createSortableList<StepModel>({
      items: m.subs,
      key: (s) => s.id,
      name: (s) => `subpaso ${numberOf(s)}`,
      label: 'Subpasos',
      rowClass: 'steprow sub',
      buttons: false,
      render: (s) => s.node,
      onReorder: (ordered) => { m.subs = ordered; refresh(); onChange(); },
    });
    fb(m.subList.element, { feedbackId: 'food.recetario.formulario.subpasos', feedbackLabel: 'Subpasos' });
    m.addSub = el('button', { 'data-feedback-id': 'food.recetario.formulario.anadir_subpaso', 'data-feedback-label': 'Añadir subpaso', class: 'linkbtn addsub', type: 'button',
      onclick: () => {
        const sub = make(null, m);
        m.subs = [...m.subs, sub];
        refresh();
        onChange();
        sub.area.focus();
      } }, icon('plus', 16), 'Añadir subpaso');
    m.node = el('div', { class: 'stepedit' }, head, m.subList.element, m.addSub);
    return m;
  }

  steps = initial.map((s) => make(s, null));
  if (!steps.length) steps = [make(null, null)]; // un primer bloque vacío para empezar a escribir
  const empty = el('p', { class: 'muted stepsempty' }, 'Sin pasos todavía.');
  const list: Sortable<StepModel> = createSortableList<StepModel>({
    items: steps,
    key: (m) => m.id,
    name: (m) => `paso ${numberOf(m)}`,
    label: 'Pasos de la elaboración',
    rowClass: 'steprow',
    render: (m) => m.node,
    onReorder: (ordered) => { steps = ordered; refresh(); onChange(); },
  });
  fb(list.element, { feedbackId: 'food.recetario.formulario.pasos', feedbackLabel: 'Pasos de la elaboración' });
  const add = el('button', { 'data-feedback-id': 'food.recetario.formulario.anadir_paso', 'data-feedback-label': 'Añadir paso', class: 'ghost', type: 'button', id: 'addStep',
    onclick: () => {
      const m = make(null, null);
      steps = [...steps, m];
      refresh();
      onChange();
      m.area.focus();
    } }, icon('plus', 18), 'Añadir paso');
  const element = el('div', { 'data-feedback-id': 'food.recetario.formulario.elaboracion', 'data-feedback-label': 'Elaboración', class: 'field stepsfield', id: 'r-method' },
    el('span', null, 'Elaboración'), list.element, empty, add,
    el('span', { class: 'hint' }, 'Un bloque por paso, de una o dos líneas. Los subpasos van dentro de su paso. Arrastra el asa o usa las flechas para reordenar.'));

  const value = (): MethodStep[] => steps.flatMap((m): MethodStep[] => {
    const subs = m.subs.map((s) => ({ id: s.id, text: s.area.value.trim() })).filter((s) => s.text);
    const text = m.area.value.trim();
    if (!text) return subs;
    return [subs.length ? { id: m.id, text, steps: subs } : { id: m.id, text }];
  });
  refresh();
  const start = JSON.stringify(value());
  return { element, value, changed: () => JSON.stringify(value()) !== start };
}
