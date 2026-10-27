/**
 * Lista de comprobación (encargo de Core del 27-10 para el catálogo de piezas de Flow, `MUELA/equipo/feedback/flow/PIEZAS_GENERICAS.md`):
 * ítems que se marcan, cada uno con quién y cuándo, obligatorios u opcionales, y arriba «3 de 5 hechas · faltan 2
 * obligatorias» con su barra.
 * - Marcar o desmarcar llama a `onToggle(id, checked)`. Si la promesa falla, la marca vuelve atrás y lo dice;
 *   sin conexión queda «Pendiente».
 * - `who()` da el nombre de quien marca («Ana»), solo para pintar: la app guarda su id.
 * - `summary()` dice `complete` cuando están todas las obligatorias. Con `onComplete`, avisa al llegar ahí.
 * - Sin capacidad detrás: el kit no guarda nada.
 * Prefijo de clases: `clist-`.
 */
import { el, replace } from '../dom.ts';
import { kt, kitLocaleTag } from '../i18n/i18n.ts';
import { createSaveState } from '../fields/save-state.ts';

export interface ChecklistItem {
  id: string;
  text: string;
  /** Por defecto, obligatorio. */
  required?: boolean;
  hint?: string | null;
}

/** Quién y cuándo (ISO) marcó cada ítem. */
export type ChecklistChecked = Record<string, { by: string; at: string }>;

export interface ChecklistSummary {
  done: number;
  total: number;
  requiredDone: number;
  requiredTotal: number;
  /** Todas las obligatorias hechas. */
  complete: boolean;
}

export interface ChecklistOptions {
  label: string;
  items: ChecklistItem[];
  checked?: ChecklistChecked;
  /** Nombre de quien marca ahora. */
  who: () => string;
  onToggle: (id: string, checked: boolean, mark: { by: string; at: string } | null) => Promise<unknown> | void;
  onComplete?: (summary: ChecklistSummary) => void;
  /** Reloj (pruebas). */
  now?: () => Date;
  /** Solo lectura (p. ej. una pasada ya cerrada). */
  readOnly?: boolean;
  feedbackId?: string;
}

export interface Checklist {
  element: HTMLElement;
  checked(): ChecklistChecked;
  summary(): ChecklistSummary;
  /** Repinta con lo del servidor. */
  setChecked(checked: ChecklistChecked): void;
}

export function checklistSummary(items: ChecklistItem[], checked: ChecklistChecked): ChecklistSummary {
  const req = items.filter((i) => i.required !== false);
  const done = items.filter((i) => checked[i.id]).length;
  const requiredDone = req.filter((i) => checked[i.id]).length;
  return { done, total: items.length, requiredDone, requiredTotal: req.length, complete: requiredDone === req.length };
}

export function createChecklist(options: ChecklistOptions): Checklist {
  const now = options.now ?? (() => new Date());
  const base = options.feedbackId;
  let state: ChecklistChecked = { ...options.checked };
  let wasComplete = checklistSummary(options.items, state).complete;
  const save = createSaveState();
  let uid = 0;
  const prefix = `kit-clist-${Math.random().toString(36).slice(2, 8)}`;
  const element = el('section', { class: 'clist-box', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) });
  const head = el('div', { class: 'clist-head' });
  const list = el('ul', { class: 'clist-list' });
  const error = el('p', { class: 'fielderror clist-error', role: 'alert' });
  element.append(head, list, el('div', { class: 'clist-foot' }, error, save.element));

  const time = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = now();
    const same = d.toDateString() === today.toDateString();
    return new Intl.DateTimeFormat(kitLocaleTag(), same ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  };

  function paintHead(): void {
    const s = checklistSummary(options.items, state);
    const left = s.requiredTotal - s.requiredDone;
    const text = kt('{n} de {m} hechas', { n: String(s.done), m: String(s.total) });
    const rest = s.complete ? kt('todas las obligatorias hechas') : left === 1 ? kt('falta 1 obligatoria') : kt('faltan {n} obligatorias', { n: String(left) });
    replace(head,
      el('p', { class: 'clist-summary', role: 'status', dataset: { complete: String(s.complete) } },
        el('span', { class: 'clist-count' }, text), ' · ', el('span', { class: 'clist-rest' }, rest)),
      el('div', { class: 'ask-bar clist-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(s.total), 'aria-valuenow': String(s.done), 'aria-label': text },
        el('span', { style: `width:${s.total ? Math.round((s.done / s.total) * 100) : 0}%` })));
  }

  function row(item: ChecklistItem): HTMLElement {
    const id = `${prefix}-${++uid}`;
    const mark = state[item.id];
    const required = item.required !== false;
    const box = el('input', { type: 'checkbox', id, class: 'clist-check', checked: !!mark, disabled: !!options.readOnly, 'aria-describedby': `${id}-meta`,
      ...(base ? { 'data-feedback-id': `${base}.item`, 'data-feedback-label': 'Ítem' } : {}),
      onchange: () => void toggle(item, box.checked) }) as HTMLInputElement;
    return el('li', { class: 'clist-item', dataset: { item: item.id, done: String(!!mark), required: String(required) } },
      box,
      el('label', { for: id, class: 'clist-text' }, item.text,
        item.hint ? el('span', { class: 'clist-hint' }, item.hint) : null),
      el('span', { class: 'clist-meta', id: `${id}-meta` },
        el('span', { class: `clist-tag ${required ? 'clist-req' : 'clist-opt'}` }, required ? kt('Obligatoria') : kt('Opcional')),
        mark ? el('span', { class: 'clist-who' }, kt('Hecho por {who} · {time}', { who: mark.by, time: time(mark.at) })) : null));
  }

  function paint(): void {
    const focused = (document.activeElement as HTMLElement | null)?.closest?.('.clist-item') as HTMLElement | null;
    const keep = focused && list.contains(focused) ? focused.dataset.item : null;
    paintHead();
    replace(list, ...options.items.map(row));
    if (keep) list.querySelector<HTMLInputElement>(`.clist-item[data-item="${CSS.escape(keep)}"] .clist-check`)?.focus();
  }

  async function toggle(item: ChecklistItem, on: boolean): Promise<void> {
    const before = state[item.id];
    const mark = on ? { by: options.who(), at: now().toISOString() } : null;
    const next = { ...state };
    if (mark) next[item.id] = mark; else delete next[item.id];
    state = next;
    error.textContent = '';
    paint();
    const work = () => Promise.resolve().then(() => options.onToggle(item.id, on, mark));
    try {
      await save.track(item.id, work(), { retry: work });
    } catch {
      if (save.field(item.id).status() !== 'pending') {
        // No se guardó: vuelve como estaba, sin «Reintentar» (reintentaría algo que ya no se ve marcado).
        save.set(item.id, 'idle');
        error.textContent = kt('No se guardó «{item}». Prueba otra vez.', { item: item.text });
        const back = { ...state };
        if (before) back[item.id] = before; else delete back[item.id];
        state = back;
        paint();
        return;
      }
    }
    const s = checklistSummary(options.items, state);
    if (s.complete && !wasComplete) options.onComplete?.(s);
    wasComplete = s.complete;
  }

  paint();
  return {
    element,
    checked: () => ({ ...state }),
    summary: () => checklistSummary(options.items, state),
    setChecked(checked) { state = { ...checked }; wasComplete = checklistSummary(options.items, state).complete; paint(); },
  };
}
