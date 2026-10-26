import { el, icon, renderMedal, replace, toast } from '@ikisai/ui-kit';
import { nextUnitStatus, SCOPE_LABELS, UNIT_STATUS_LABELS, type UnitStatus } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { productMedal } from './sheets-common.ts';
import { errorCode, errorDetails, flowActions } from '../app/actions.ts';
import { customerNumber, watchData, type FlowData, type Unit } from '../app/data.ts';
import { loadPeople, personName } from '../app/people.ts';
import { createStableList } from './stable-list.ts';
import type { ViewMount } from './shell.ts';

/**
 * Cola de unidades con toques sucesivos (canon V1 §5 y §7; FLOW-DIR-001 §5–6). La usan Preparación (montaditos) y
 * Logística (tareas): el comportamiento `quick_steps`/`free_task` es el mismo.
 * - Orden canónico estable: Preparación, por número de cobro y posición dentro del pedido; Logística, por creación.
 *   Nunca por estado. Lo terminado se queda en su sitio, gris, tachado y más bajo.
 * - Toque: pendiente → en curso (para quien toca) → terminado → pendiente (corrección). Se ve al momento como «pendiente de
 *   confirmar»; solo una transición en vuelo por tarjeta; si otra persona se adelantó (UNIT_CHANGED), la tarjeta enseña el
 *   estado real y un aviso localizado, sin sobrescribir.
 * - Se ven las últimas 10 terminadas; las anteriores se despliegan hacia arriba en la misma lista.
 * - «Ir al siguiente pendiente» solo si el siguiente pendiente no está a la vista.
 */
export const VISIBLE_DONE = 10;

export function mountQueue(kind: 'prep' | 'logistics'): ViewMount {
  return (ctx) => {
    const { main, client } = ctx;
    const actions = flowActions(client);
    const me = client.bootstrap()?.profile.userId ?? null;
    const canEdit = client.bootstrap()?.membership.role !== 'reader';
    let data: FlowData | null = null;
    let people: Map<string, string> | null = null;
    let showAllDone = false;
    /** Toques en vuelo: estado que se enseña mientras el servidor no responde. */
    const inFlight = new Map<string, UnitStatus>();
    /** Confirmados por el servidor que el espejo aún no trae: se enseñan hasta que llega una revisión nueva (sin parpadeo). */
    const settled = new Map<string, { status: UnitStatus; revision: number }>();
    /** Avisos localizados por tarjeta (otra persona se adelantó). */
    const notices = new Map<string, string>();

    const olderButton = el('button', { type: 'button', class: 'ghost fqueue-older', hidden: true, onclick: () => { showAllDone = true; paint(); } });
    const listEl = el('div', { class: 'fqueue', role: 'list', 'aria-label': kind === 'prep' ? 'Montaditos' : 'Tareas' });
    const nextButton = el('button', { type: 'button', class: 'primary fqueue-next', hidden: true, onclick: goToNext }, icon('chevronDown', 18), el('span', null, 'Ir al siguiente pendiente'));
    const empty = el('p', { class: 'muted fqueue-empty', hidden: true }, kind === 'prep' ? 'No hay montaditos cobrados todavía.' : 'No hay tareas. Crea la primera arriba.');
    const head = kind === 'logistics' ? taskForm() : null;
    main.append(
      el('h1', { class: 'col-title' }, kind === 'prep' ? 'Preparación' : 'Logística'),
      ...(kind === 'prep' ? [el('p', { class: 'muted small' }, 'Toca para tomar un montadito, otra vez cuando esté listo para servir. Un tercer toque lo devuelve a pendiente.')] : []),
      ...(head ? [head] : []),
      olderButton, listEl, empty, nextButton,
    );

    const list = createStableList<Unit>({ element: listEl, key: (u) => u.id, render: (u) => { const n = cardShell(u); fill(n, u); return n; }, update: fill });

    function units(): Unit[] {
      if (!data) return [];
      const all = data.units.filter((u) => (kind === 'prep' ? u.kind === 'prep' && u.column_key === 'prep' : u.kind === 'task' && u.column_key === 'logistics'));
      return all.sort(kind === 'prep'
        ? (a, b) => (a.pay_seq ?? 0) - (b.pay_seq ?? 0) || a.idx - b.idx || a.id.localeCompare(b.id)
        : (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    }

    /** Las terminadas más antiguas que las últimas 10 se esconden; nunca las abiertas. */
    function visible(all: Unit[]): { shown: Unit[]; hidden: number } {
      if (showAllDone) return { shown: all, hidden: 0 };
      const doneIdx = all.map((u, i) => (shownStatus(u) === 'done' || u.status === 'cancelled' ? i : -1)).filter((i) => i >= 0);
      const hide = new Set(doneIdx.slice(0, Math.max(0, doneIdx.length - VISIBLE_DONE)));
      return { shown: all.filter((_, i) => !hide.has(i)), hidden: hide.size };
    }

    function shownStatus(u: Unit): UnitStatus {
      const flying = inFlight.get(u.id);
      if (flying) return flying;
      const done = settled.get(u.id);
      if (done && done.revision === u.revision) return done.status;
      if (done) settled.delete(u.id);
      return u.status;
    }

    function cardShell(u: Unit): HTMLElement {
      const node = el('div', { class: 'qcard', role: 'listitem' });
      node.append(
        el('button', { type: 'button', class: 'qcard-main', onclick: () => tap(u.id) },
          el('span', { class: 'qcard-medal' }),
          el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }), el('small', { class: 'qcard-sub muted' })),
          el('span', { class: 'qcard-state' })),
        el('p', { class: 'qcard-notice', role: 'status', hidden: true }),
      );
      return node;
    }

    function fill(node: HTMLElement, u: Unit): void {
      const status = shownStatus(u);
      const pending = inFlight.has(u.id) || !!u._pending;
      node.className = `qcard is-${status}${pending ? ' is-unconfirmed' : ''}${u.priority ? ' is-priority' : ''}`;
      node.dataset.status = status;
      const product = u.product_id ? data?.products.get(u.product_id) : null;
      const order = u.order_id ? data?.orders.find((o) => o.id === u.order_id) : null;
      const medal = node.querySelector('.qcard-medal')!;
      const medalKey = product ? `${product.scope}:${product.code}` : 'task';
      if (medal.getAttribute('data-k') !== medalKey) {
        medal.setAttribute('data-k', medalKey);
        replace(medal as HTMLElement, product ? productMedal(product, 44) : renderMedal({ icon: 'list', size: 44 }));
      }
      node.querySelector('.qcard-title')!.textContent = product ? product.name : (u.label ?? '');
      const who = status === 'done' ? personName(people, u.done_by, me) : status === 'in_progress' ? personName(people, u.assigned_to, me) : '';
      const number = order ? customerNumber(data!, order) : null;
      const sub = [order?.pay_seq ? `Pedido ${order.pay_seq}` : '', number ? `cliente ${number}` : '', u.priority ? 'prioritaria' : '', who].filter(Boolean).join(' · ');
      node.querySelector('.qcard-sub')!.textContent = sub;
      node.querySelector('.qcard-state')!.textContent = pending ? `${UNIT_STATUS_LABELS[status]} · pendiente de confirmar` : UNIT_STATUS_LABELS[status];
      const main = node.querySelector<HTMLButtonElement>('.qcard-main')!;
      main.disabled = !canEdit || status === 'cancelled' || inFlight.has(u.id);
      main.setAttribute('aria-label', `${product ? product.name : u.label}: ${UNIT_STATUS_LABELS[status]}${sub ? `, ${sub}` : ''}`);
      const notice = node.querySelector<HTMLElement>('.qcard-notice')!;
      const text = notices.get(u.id);
      notice.hidden = !text;
      notice.textContent = text ?? '';
    }

    async function tap(id: string): Promise<void> {
      const u = data?.units.find((x) => x.id === id);
      if (!u || inFlight.has(id)) return; // una sola transición en vuelo por tarjeta
      const next = nextUnitStatus(u.status);
      if (!next) return;
      notices.delete(id);
      inFlight.set(id, next);
      repaintOne(u);
      try {
        await actions.unitStep(id, u.status);
        settled.set(id, { status: next, revision: u.revision });
      } catch (error) {
        if (errorCode(error) === 'UNIT_CHANGED') {
          const d = errorDetails(error);
          const by = d.status === 'in_progress' ? personName(people, d.assignedTo, me) : d.status === 'done' ? personName(people, d.doneBy, me) : '';
          notices.set(id, `Otra persona se adelantó: ahora está ${UNIT_STATUS_LABELS[d.status as UnitStatus]?.toLowerCase() ?? d.status}${by ? ` (${by})` : ''}.`);
          void client.sync().catch(() => undefined);
        } else {
          toast(describeError(error));
        }
      } finally {
        inFlight.delete(id);
        const fresh = data?.units.find((x) => x.id === id);
        if (fresh) repaintOne(fresh);
      }
    }

    function repaintOne(u: Unit): void {
      const node = list.node(u.id);
      if (node) fill(node, u);
    }

    function firstPending(all: Unit[]): Unit | undefined {
      return all.find((u) => shownStatus(u) === 'pending');
    }

    function goToNext(): void {
      const target = firstPending(units());
      const node = target ? list.node(target.id) : null;
      node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node?.querySelector<HTMLElement>('.qcard-main')?.focus({ preventScroll: true });
    }

    /** El botón sale solo si el siguiente pendiente no está a la vista. */
    function paintNext(): void {
      const target = firstPending(units());
      const node = target ? list.node(target.id) : null;
      if (!node) { nextButton.hidden = true; return; }
      const r = node.getBoundingClientRect();
      nextButton.hidden = r.bottom > 0 && r.top < window.innerHeight;
    }

    function paint(): void {
      const all = units();
      const { shown, hidden } = visible(all);
      list.set(shown);
      olderButton.hidden = hidden === 0;
      olderButton.textContent = `Ver ${hidden} ${hidden === 1 ? 'terminada anterior' : 'terminadas anteriores'}`;
      empty.hidden = all.length > 0;
      paintNext();
    }

    function taskForm(): HTMLElement {
      const input = el('input', { type: 'text', name: 'task', maxlength: '120', placeholder: 'Reponer tomate, traer pan…', 'aria-label': 'Nueva tarea', autocomplete: 'off' });
      const priority = el('input', { type: 'checkbox', name: 'priority' });
      const form = el('form', { class: 'task-form', onsubmit: async (e: Event) => {
        e.preventDefault();
        const label = input.value.trim();
        if (!label || !data?.project) return;
        try {
          await client.commit([{ op: 'insert', table: 'flow.units', id: crypto.randomUUID(), fields: { project_id: data.project.id, column_key: 'logistics', kind: 'task', label, priority: priority.checked } }]);
          input.value = ''; priority.checked = false;
        } catch (error) { toast(describeError(error)); }
      } },
        input,
        el('label', { class: 'task-priority' }, priority, el('span', null, 'Prioritaria')),
        el('button', { type: 'submit', class: 'primary' }, icon('plus', 18), el('span', null, 'Añadir')));
      if (!canEdit) form.hidden = true;
      return form;
    }

    const onScroll = () => paintNext();
    window.addEventListener('scroll', onScroll, { passive: true });
    const offData = watchData(client, (d) => { data = d; paint(); }, ctx.projectId);
    void loadPeople(client).then((p) => { people = p; for (const u of units()) repaintOne(u); });

    return () => { offData(); window.removeEventListener('scroll', onScroll); };
  };
}
