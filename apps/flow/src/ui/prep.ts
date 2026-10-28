import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, fieldAttrs, icon, openSheet, renderMedal, replace, toast } from '@ikisai/ui-kit';
import { nextUnitStatus, PROCEDURES, UNIT_STATUS_LABELS, type UnitStatus } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { productMedal } from './sheets-common.ts';
import { callProcedure, errorCode, errorDetails, flowActions, isOnline } from '../app/actions.ts';
import { generateIngredientTasks } from '../app/ingredients.ts';
import { askTasks, quickPurchase } from '../app/links.ts';
import { customerNumber, fillMetricText, loadStationMetrics, steadyMetrics, watchData, type FlowData, type StationMetric, type Unit } from '../app/data.ts';
import { loadPeople, personName } from '../app/people.ts';
import { createStableList } from './stable-list.ts';
import { serviceToggle, type ViewMount } from './shell.ts';

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

/** Columna de unidades con toques: Preparación (unidades de producto), Logística e Ingredientes (tareas). */
export type QueueKind = 'prep' | 'logistics' | 'ingredients';
/** Los ajustes que entiende cualquiera; el resto va en «Ajustes técnicos». */
const SIMPLE_PARAMS = ['warmup_min', 'bread_per_unit', 'machine_capacity', 'min_target'];
/** Nivel intermedio: se entienden, pero se tocan poco (van debajo, más pequeños). */
const MID_PARAMS = ['lead_min', 'lookback_min'];
/** Qué es cada ajuste, en una frase (bocadillo al tocar su nombre). */
const PARAM_HELP: Record<string, string> = {
  warmup_min: 'Lo que tarda un pan en estar listo desde que entra a calentar.',
  bread_per_unit: 'Cuántos panes lleva cada montadito.',
  machine_capacity: 'Máximo de panes que caben calentándose a la vez.',
  min_target: 'Panes que siempre deben estar calentándose aunque no haya pedidos.',
  lead_min: 'Cuántos minutos por delante se calienta pan para lo que se espera vender.',
  lookback_min: 'Cuántos minutos atrás se miran las ventas para calcular el ritmo.',
  smooth_min: 'Ventana para suavizar el ritmo y que la cifra no salte con cada pedido.',
  smooth_weight: 'Cuánto pesa el ritmo de los últimos minutos frente al de antes (0 nada, 1 todo).',
  hysteresis: 'La cifra solo cambia si se mueve al menos estos panes, para que no baile.',
  per_order_cap: 'Máximo de panes que cuenta un solo pedido grande, para que no dispare la cifra.',
};
/** Ajustes de los puestos con nombre que se entiende (VG, 28-10: salían las claves internas). */
const PARAM_LABELS: Record<string, string> = {
  warmup_min: 'Minutos que tarda en calentarse', lead_min: 'Minutos de adelanto', lookback_min: 'Minutos para medir el ritmo',
  machine_capacity: 'Panes que caben a la vez', smooth_min: 'Minutos para suavizar', smooth_weight: 'Peso del ritmo reciente (0 a 1)',
  bread_per_unit: 'Panes por montadito', hysteresis: 'Cambio mínimo para avisar (panes)', min_target: 'Panes mínimos calentándose',
  per_order_cap: 'Tope de panes por pedido',
};
const isBread = (u: Unit) => (u.payload as { metric?: string } | null)?.metric === 'bread_v2';
const QUEUE_TITLE: Record<QueueKind, string> = { prep: 'Preparación', logistics: 'Logística', ingredients: 'Ingredientes' };
const QUEUE_EMPTY: Record<QueueKind, string> = {
  prep: 'No hay montaditos cobrados todavía.',
  logistics: 'No hay tareas. Crea la primera arriba.',
  ingredients: 'No hay tareas de ingredientes. El encargado puede generarlas desde la previsión de Food, o créalas a mano arriba.',
};
const fmtQty = (q: number | undefined, unit: string | undefined) => (q === undefined || q === null ? '' : `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: unit === 'ud' ? 0 : 2 }).format(q)} ${unit ?? ''}`.trim());

export function mountQueue(kind: QueueKind): ViewMount {
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
    const isOwner = client.bootstrap()?.membership.role === 'owner';
    const noticeEl = el('p', { class: 'station-notice', role: 'status', hidden: true });
    const nextButton = el('button', { type: 'button', class: 'primary fqueue-next', hidden: true, onclick: goToNext }, icon('chevronDown', 18), el('span', null, 'Ir al siguiente pendiente'));
    const empty = el('p', { class: 'muted fqueue-empty', hidden: true }, QUEUE_EMPTY[kind]);
    const head = kind === 'prep' ? null : taskForm();
    const ownerTools = (kind === 'ingredients' || (kind === 'logistics' && ctx.mergeIngredients)) && isOwner
      ? [el('div', { class: 'orders-owner' }, el('button', { type: 'button', class: 'ghost', onclick: () => void generate() }, 'Generar tareas de ingredientes'))] : [];
    main.append(
      el('h1', { class: 'col-title' }, ctx.columnLabel ?? QUEUE_TITLE[kind]),
      // Modo servicio (pantalla encendida, aviso de pedido nuevo): aquí, donde se usa (VG, 28-10).
      ...(kind === 'prep' && serviceToggle ? [el('div', { class: 'orders-owner' }, serviceToggle)] : []),
      noticeEl,
      ...ownerTools,
      ...(kind === 'prep' ? [el('p', { class: 'muted small' }, 'Toca para tomar un montadito, otra vez cuando esté listo para servir. Un tercer toque lo devuelve a pendiente.')] : []),
      ...(head ? [head] : []),
      olderButton, listEl, empty, nextButton,
    );

    const list = createStableList<Unit>({ element: listEl, key: (u) => u.id, render: (u) => { const n = cardShell(u); fill(n, u); return n; }, update: fill });

    function units(): Unit[] {
      if (!data) return [];
      // El pan no es una tarjeta (VG, 28-10): es una cifra arriba, sin toques.
      const cols = kind === 'logistics' && ctx.mergeIngredients ? ['logistics', 'ingredients'] : [kind];
      const all = data.units.filter((u) => (kind === 'prep' ? u.kind === 'prep' && u.column_key === 'prep' : (u.kind === 'task' || (u.kind === 'station' && !isBread(u))) && cols.includes(u.column_key)));
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
        el('button', { type: 'button', class: 'iconbtn qcard-edit', hidden: true, 'aria-label': 'Revisar la cantidad', onclick: () => editQty(u.id) }, icon('edit', 18)),
        el('button', { type: 'button', class: 'iconbtn qcard-params', hidden: true, 'aria-label': 'Parámetros del puesto', onclick: () => editParams(u.id) }, icon('settings', 18)),
        el('button', { type: 'button', class: 'iconbtn qcard-tasks', hidden: true, 'aria-label': 'Pedir a Tasks', onclick: () => { const x = data?.units.find((y) => y.id === u.id); if (!x) return; if (x.payload?.purchase) void quickPurchase(client, x); else askTasks(client, x); } }, icon('tasks', 18)),
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
      node.querySelector('.qcard-title')!.textContent = product ? product.name : (u.label ?? 'Producto que ya no está en la carta');
      const who = status === 'done' ? personName(people, u.done_by, me) : status === 'in_progress' ? personName(people, u.assigned_to, me) : '';
      const number = order ? customerNumber(data!, order) : null;
      const load = u.payload?.qty !== undefined ? `${fmtQty(u.payload.qty, u.payload.unit)}${u.payload.to ? ` a ${u.payload.to}` : ''}${u.payload.from ? ` desde ${u.payload.from}` : ''}` : '';
      const ext = u.payload?.external?.app === 'tasks' ? `en Tasks: ${u.payload.external.kind === 'purchase_request' ? 'compra' : 'tarea'}` : '';
      const sub = [order?.pay_seq ? `Pedido ${order.pay_seq}` : '', number ? `cliente ${number}` : '', load, ext, u.priority ? 'prioritaria' : '', who].filter(Boolean).join(' · ');
      node.querySelector('.qcard-sub')!.textContent = sub;
      // En una columna con propuestas, «pendiente» es «confirmada» (propuesta → confirmada → asignada → hecha). Un puesto: libre u ocupado.
      const label = u.kind === 'station' ? (status === 'in_progress' ? 'Lo llevas tú o alguien: toca para soltarlo' : 'Libre: toca para encargarte')
        : u.column_key === 'ingredients' && status === 'pending' ? 'Confirmada' : UNIT_STATUS_LABELS[status];
      if (u.kind === 'station') {
        const mv = metrics.get(u.id)?.value as Record<string, number> | undefined;
        // El pan (bread_v2): solo lo que hace falta saber; lo demás está en sus ajustes.
        const live = u.payload?.metric === 'bread_v2' && mv
          ? `Calentando ahora: ${mv.target ?? 0} panes (${mv.firm ?? 0} ya cobrados + ${Math.round(mv.forecast ?? 0)} previstos)`
          : fillMetricText(u.payload?.text, metrics.get(u.id));
        node.querySelector('.qcard-sub')!.textContent = [live, status === 'in_progress' ? personName(people, u.assigned_to, me) : ''].filter(Boolean).join(' · ');
      }
      node.querySelector('.qcard-state')!.textContent = pending ? `${label} · pendiente de confirmar` : label;
      const edit = node.querySelector<HTMLButtonElement>('.qcard-edit')!;
      edit.hidden = !(canEdit && u.kind === 'task' && u.payload?.qty !== undefined && (status === 'proposed' || status === 'pending'));
      const role = client.bootstrap()?.membership.role;
      const tasksButton = node.querySelector<HTMLButtonElement>('.qcard-tasks')!;
      tasksButton.hidden = !(u.kind === 'task' && !u.payload?.external && status !== 'done' && (role === 'editor' || role === 'owner'));
      tasksButton.setAttribute('aria-label', u.payload?.purchase ? 'Pedir la compra a Tasks' : 'Pedir a Tasks');
      node.querySelector<HTMLButtonElement>('.qcard-params')!.hidden = !(u.kind === 'station' && role === 'owner');
      const main = node.querySelector<HTMLButtonElement>('.qcard-main')!;
      main.disabled = !canEdit || status === 'cancelled' || inFlight.has(u.id);
      main.setAttribute('aria-label', `${product ? product.name : u.label}: ${UNIT_STATUS_LABELS[status]}${sub ? `, ${sub}` : ''}`);
      const notice = node.querySelector<HTMLElement>('.qcard-notice')!;
      const text = notices.get(u.id);
      notice.hidden = !text;
      notice.textContent = text ?? '';
    }

    /** Métricas de los puestos (servidor), refrescadas con los datos y cada 20 s. */
    let metrics = new Map<string, StationMetric>();
    async function refreshMetrics(): Promise<void> {
      if (!ctx.projectId || !data?.units.some((u) => u.kind === 'station')) { noticeEl.hidden = true; return; }
      metrics = steadyMetrics(metrics, await loadStationMetrics(client, ctx.projectId));
      for (const u of units()) if (u.kind === 'station') repaintOne(u);
      // Aviso pequeño en la cabecera de las columnas que lo pidan (notice_in).
      const notes = data!.units.filter((u) => u.kind === 'station' && !isBread(u) && (u.payload?.notice_in ?? []).includes(kind))
        .map((u) => fillMetricText(u.payload?.notice, metrics.get(u.id))).filter(Boolean);
      replace(noticeEl, notes.join(' · '));
      noticeEl.hidden = !notes.length;
    }
    const metricsTimer = setInterval(() => void refreshMetrics(), 20_000);

    /** Owner: parámetros numéricos de la métrica de un puesto. */
    function editParams(id: string): void {
      const u = data?.units.find((x) => x.id === id);
      if (u) openStationParams(client, u, metrics.get(u.id)?.value as Record<string, number> | undefined, () => void refreshMetrics());
    }

    /** Revisar la cantidad antes de confirmar o hacer la tarea (FLOW-DIR VG 27-10). */
    function editQty(id: string): void {
      const u = data?.units.find((x) => x.id === id);
      if (!u || u.payload?.qty === undefined) return;
      const input = el('input', { ...fieldAttrs({ id: 'flow.preparacion.cantidad', entity: 'flow.units', prop: 'payload', type: 'number' }), type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: String(u.payload.qty), 'aria-label': `Cantidad (${u.payload.unit ?? ''})` });
      const sheet = openSheet({ title: u.label ?? 'Cantidad', meta: u.payload.unit ? `En ${u.payload.unit}` : undefined, body: el('div', null, input),
        foot: el('div', { class: 'flow-actions' }, el('button', { type: 'button', class: 'primary', onclick: async () => {
          const qty = Number(input.value);
          if (!Number.isFinite(qty) || qty < 0) { toast('Cantidad no válida.'); return; }
          try { await callProcedure(client, PROCEDURES.unitSetQty, { unit_id: u.id, qty, expected_revision: u.revision }); sheet.close(); }
          catch (error) { toast(describeError(error)); }
        } }, 'Guardar')) });
    }

    /** Owner: tareas de preparación desde la previsión de Food (app/ingredients.ts). */
    async function generate(): Promise<void> {
      if (!isOnline(client)) { toast('Generar necesita conexión.'); return; }
      if (!(await confirmDialog({ title: 'Generar tareas de ingredientes', text: 'Se proponen «Preparar X para mesa» y «para nevera» con la previsión de Food. Lo ya generado hoy no se duplica.', confirmLabel: 'Generar' }))) return;
      try {
        const out = await generateIngredientTasks(client, ctx.projectId!);
        if (!out.notes.length) { toast(out.message); return; }
        // Lo que falta se queda a la vista hasta cerrarlo: el motivo y dónde se arregla.
        const sheet = openSheet({ title: 'Generar tareas de ingredientes', meta: out.message,
          body: el('ul', { class: 'generate-notes', role: 'list' }, ...out.notes.map((n) => el('li', null, n))),
          foot: el('div', { class: 'flow-actions' }, el('button', { type: 'button', class: 'primary', onclick: () => sheet.close() }, 'Entendido')) });
      } catch (error) { toast(describeError(error)); }
    }

    async function tap(id: string): Promise<void> {
      const u = data?.units.find((x) => x.id === id);
      if (!u || inFlight.has(id)) return; // una sola transición en vuelo por tarjeta
      // Se parte de lo que se enseña: incluye lo que el servidor ya confirmó aunque el espejo aún no lo traiga (dos toques
      // seguidos no deben dar un falso «otra persona se adelantó»).
      const from = shownStatus(u);
      // Un puesto no se termina: un toque lo ocupa y otro lo suelta.
      const next: UnitStatus | null = u.kind === 'station' ? (from === 'pending' ? 'in_progress' : 'pending') : nextUnitStatus(from);
      if (!next) return;
      notices.delete(id);
      inFlight.set(id, next);
      repaintOne(u);
      try {
        await actions.unitStep(id, from);
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
      const input = el('input', { ...fieldAttrs({ id: 'flow.preparacion.nueva_tarea', entity: 'flow.units', prop: 'label', type: 'text' }), type: 'text', name: 'task', maxlength: '120', placeholder: 'Reponer tomate, traer pan…', 'aria-label': 'Nueva tarea', autocomplete: 'off' });
      const priority = el('input', { ...fieldAttrs({ id: 'flow.preparacion.prioridad', entity: 'flow.units', prop: 'priority', type: 'checkbox' }), type: 'checkbox', name: 'priority' });
      const form = el('form', { class: 'task-form', onsubmit: async (e: Event) => {
        e.preventDefault();
        const label = input.value.trim();
        if (!label || !data?.project) return;
        try {
          await client.commit([{ op: 'insert', table: 'flow.units', id: crypto.randomUUID(), fields: { project_id: data.project.id, column_key: kind, kind: 'task', label, priority: priority.checked } }]);
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
    const offData = watchData(client, (d) => { data = d; paint(); void refreshMetrics(); }, ctx.projectId);
    void loadPeople(client).then((p) => { people = p; for (const u of units()) repaintOne(u); });

    return () => { offData(); clearInterval(metricsTimer); window.removeEventListener('scroll', onScroll); };
  };
}

/** Owner: parámetros numéricos de la métrica de un puesto (lo simple arriba, lo intermedio debajo, lo técnico plegado). */
export function openStationParams(client: SyncClient, u: Unit, mv: Record<string, number> | undefined, onSaved: () => void): void {
    const params = (u.payload?.params ?? {}) as Record<string, unknown>;
    const inputs = Object.entries(params).filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => [k, el('input', { ...fieldAttrs({ id: 'flow.preparacion.ingrediente', entity: 'flow.units', prop: 'payload', type: 'number' }), type: 'number', step: 'any', min: '0', value: String(v), 'aria-label': k }) as HTMLInputElement] as const);
    const sheet = openSheet({ title: `Parámetros · ${u.label ?? ''}`,
      body: (() => {
        // Lo que importa arriba (cuántos panes poner ahora y lo básico de la máquina); lo técnico, plegado.
        // Cada nombre se toca para ver qué es: un bocadillo pequeño debajo, sin tapar la pantalla.
        const row = ([k, input]: readonly [string, HTMLInputElement]) => {
          const tip = el('span', { class: 'param-tip', role: 'note', hidden: true }, PARAM_HELP[k] ?? 'Ajuste técnico del cálculo.');
          const name = el('button', { type: 'button', class: 'param-name', 'aria-expanded': 'false', onclick: (e: Event) => {
            e.preventDefault(); tip.hidden = !tip.hidden; name.setAttribute('aria-expanded', String(!tip.hidden)); } },
            PARAM_LABELS[k] ?? k, el('span', { class: 'param-i', 'aria-hidden': 'true' }, 'ⓘ'));
          return el('div', { class: 'param-row' }, name, tip, input);
        };
        const simple = inputs.filter(([k]) => SIMPLE_PARAMS.includes(k));
        const mid = inputs.filter(([k]) => MID_PARAMS.includes(k));
        const tech = inputs.filter(([k]) => !SIMPLE_PARAMS.includes(k) && !MID_PARAMS.includes(k));
        return el('div', { class: 'station-params' },
          mv ? el('p', { class: 'station-now' }, el('strong', null, `Ahora: ${mv.target ?? 0} panes calentándose`),
            el('small', { class: 'muted' }, ` (${mv.firm ?? 0} de pedidos ya cobrados + ${Math.round(mv.forecast ?? 0)} que se esperan)`)) : null,
          ...simple.map(row),
          mid.length ? el('div', { class: 'param-mid' }, ...mid.map(row)) : null,
          tech.length ? el('details', { class: 'station-tech' }, el('summary', null, 'Ajustes técnicos (no hace falta tocarlos)'), ...tech.map(row)) : null);
      })(),
      foot: el('div', { class: 'flow-actions' }, el('button', { type: 'button', class: 'primary', onclick: async () => {
        const next = Object.fromEntries(inputs.map(([k, input]) => [k, Number(input.value)]));
        try { await callProcedure(client, PROCEDURES.stationSetParams, { unit_id: u.id, params: next, expected_revision: u.revision }); sheet.close(); onSaved(); }
        catch (error) { toast(describeError(error)); }
      } }, 'Guardar')) });
  }

/**
 * El pan (VG, 28-10): una cifra encima del tablero, a la vista desde cualquier carril; se calcula sola con lo cobrado y lo
 * previsto, sin toques. El owner abre sus ajustes desde ahí.
 */
export function mountBreadBanner(client: SyncClient, projectId: string, host: HTMLElement): () => void {
  const isOwner = client.bootstrap()?.membership.role === 'owner';
  let bread: Unit | undefined;
  let metrics = new Map<string, StationMetric>();
  async function refresh(): Promise<void> {
    if (!bread) { host.hidden = true; return; }
    metrics = steadyMetrics(metrics, await loadStationMetrics(client, projectId));
    const mv = metrics.get(bread.id)?.value as Record<string, number> | undefined;
    host.hidden = !mv;
    if (!mv) return;
    const u = bread;
    replace(host, el('strong', null, `Pan: calentando ${mv.target ?? 0}`), ` (${mv.firm ?? 0} cobrados + ${Math.round(mv.forecast ?? 0)} previstos)`,
      ...(isOwner ? [' ', el('button', { type: 'button', class: 'linkbtn', onclick: () => openStationParams(client, u, mv, () => void refresh()) }, 'Ajustes')] : []));
  }
  const off = watchData(client, (d) => { bread = d.units.find((u) => u.kind === 'station' && isBread(u) && u.status !== 'cancelled'); void refresh(); }, projectId);
  const timer = setInterval(() => void refresh(), 20_000);
  return () => { off(); clearInterval(timer); };
}
