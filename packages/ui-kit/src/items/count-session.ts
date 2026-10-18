/**
 * Recuento en el móvil (`createCountSession`, R3; aprobado el 18-10-2026).
 *
 * - **Qué se cuenta:** un sitio y lo de dentro (`spaceId`), todo (`null`) o solo unos artículos (`itemIds`: el «Recontar»
 *   de una fila). Retoma el recuento abierto de ese sitio o lo abre al guardar la primera línea.
 * - **A ciegas por defecto:** lo calculado no se ve (`showExpected` o «Ver lo calculado» lo enseñan).
 * - **Cada línea** se guarda al escribirla (`count_lines`, sin red también); − y + para contar de uno en uno. Chips para
 *   saltar entre sitios y «Sin contar». «Contar otro artículo aquí» para lo que no estaba en la lista.
 * - **Revisar y cerrar:** cada diferencia frente a lo calculado y cuántos cuadran; «Cerrar y ajustar» llama a
 *   `resources.close_count`, que **se aplica al sincronizar** con el stock de ese momento (lo dice). Lo no contado no cambia.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { formatQuantity, parseQuantity } from '../fields/quantity.ts';
import { createSpacePicker } from '../spaces/picker.ts';
import { indexSpaces, spaceDescendants, type SpaceRow, type SpaceSource } from '../spaces/model.ts';
import { createItemPicker } from './picker.ts';
import { expiryText } from './catalog.ts';
import { DEFAULT_ITEM_KINDS, countTargets, newItemId, stockAt, type CountLineRow, type CountRow, type ItemSnapshot, type ItemSource } from './model.ts';

export interface CountDifference {
  itemId: string;
  spaceId: string;
  lotId: string | null;
  expected: number;
  counted: number;
  difference: number;
}

export interface CountSessionOptions {
  source: ItemSource;
  spaces?: SpaceSource | SpaceRow[];
  /** Sitio que se cuenta (con lo de dentro); `null` = todo. */
  spaceId?: string | null;
  /** Solo estos artículos (el «Recontar» de una fila). */
  itemIds?: string[];
  /** Retomar este recuento. */
  countId?: string;
  /** Enseñar lo calculado desde el principio (por defecto, a ciegas). */
  showExpected?: boolean;
  onClosed?: (differences: CountDifference[]) => void;
  /** «Seguir luego»: el recuento queda abierto. */
  onLeave?: () => void;
  today?: string;
  feedbackId?: string;
}

export interface CountSession {
  element: HTMLElement;
  destroy(): void;
}

export const COUNT_SESSION_MARKS = {
  line: ['linea', 'Cantidad contada'],
  minus: ['restar', 'Restar uno'],
  plus: ['sumar', 'Sumar uno'],
  expected: ['calculado', 'Ver lo calculado'],
  filter: ['filtro', 'Sitio del recuento'],
  add: ['otro', 'Contar otro artículo'],
  leave: ['luego', 'Seguir luego'],
  review: ['revisar', 'Revisar y cerrar'],
  close: ['cerrar', 'Cerrar y ajustar'],
  back: ['volver', 'Volver a contar'],
} as const;

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const keyOf = (t: { itemId: string; spaceId: string; lotId: string | null }) => `${t.itemId}|${t.spaceId}|${t.lotId ?? ''}`;

export function createCountSession(options: CountSessionOptions): CountSession {
  const base = options.feedbackId;
  const mark = (key: keyof typeof COUNT_SESSION_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${COUNT_SESSION_MARKS[key][0]}`, 'data-feedback-label': COUNT_SESSION_MARKS[key][1] } : {});
  const today = options.today ?? localToday();
  let snap: ItemSnapshot = { items: [], units: [], kinds: DEFAULT_ITEM_KINDS, stock: [] };
  let spaceRows: SpaceRow[] = Array.isArray(options.spaces) ? options.spaces : [];
  let spaceIndex = indexSpaces(spaceRows);
  let showExpected = !!options.showExpected;
  let view: 'count' | 'review' | 'done' = 'count';
  let chip: string | 'todo' | 'pending' = 'todo';
  let countId: string | null = options.countId ?? null;
  let opening: Promise<void> | null = null;
  let showMatching = false;
  /** Artículos añadidos a mano en esta sesión (aún sin línea). */
  const added: Array<{ itemId: string; spaceId: string; lotId: string | null }> = [];
  /** Lo escrito y aún sin guardar, para no pisarlo al repintar. */
  const typing = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const scopeIds = (): string[] | null => (options.spaceId ? [options.spaceId, ...spaceDescendants(spaceRows, options.spaceId, true)] : null);
  const spaceName = (sid: string | null) => (sid ? spaceIndex.get(sid)?.name ?? kt('Sin sitio') : kt('Todo'));
  const itemOf = (iid: string) => snap.items.find((i) => i.id === iid) ?? null;
  const lotOf = (lid: string | null) => (lid ? (snap.lots ?? []).find((l) => l.id === lid) ?? null : null);
  const qty = (n: number, unit: string) => `${formatQuantity(n, 3)} ${unit}`;
  const count = (): CountRow | null => (countId ? (snap.counts ?? []).find((c) => c.id === countId) ?? null : null);
  const lines = (): CountLineRow[] => (countId ? (snap.countLines ?? []).filter((l) => l.countId === countId) : []);

  const body = el('div', { class: 'stk-count-body' });
  const element = el('section', { class: 'stk-count', 'aria-label': kt('Recuento'), ...(base ? { 'data-feedback-id': base, 'data-feedback-label': kt('Recuento') } : {}) }, body);

  // --- Qué se espera y qué se ha contado ---------------------------------------------------------------------
  type Target = { itemId: string; spaceId: string; lotId: string | null; expected: number; line: CountLineRow | null };
  function targets(): Target[] {
    const byKey = new Map(lines().map((l) => [keyOf(l), l]));
    const out = new Map<string, Target>();
    for (const t of countTargets(snap, scopeIds(), options.itemIds ?? null)) out.set(keyOf(t), { ...t, line: byKey.get(keyOf(t)) ?? null });
    for (const a of added) if (!out.has(keyOf(a))) out.set(keyOf(a), { ...a, expected: stockAt(snap.stock, a.itemId, a.spaceId, a.lotId), line: byKey.get(keyOf(a)) ?? null });
    for (const l of byKey.values()) if (!out.has(keyOf(l))) out.set(keyOf(l), { itemId: l.itemId, spaceId: l.spaceId, lotId: l.lotId, expected: stockAt(snap.stock, l.itemId, l.spaceId, l.lotId), line: l });
    return [...out.values()].filter((t) => itemOf(t.itemId))
      .sort((a, b) => spaceName(a.spaceId).localeCompare(spaceName(b.spaceId)) || itemOf(a.itemId)!.name.localeCompare(itemOf(b.itemId)!.name) || (lotOf(a.lotId)?.expiresOn ?? '').localeCompare(lotOf(b.lotId)?.expiresOn ?? ''));
  }

  async function ensureCount(): Promise<string | null> {
    if (countId) return countId;
    if (!options.source.openCount) return null;
    if (!opening) {
      const newId = newItemId();
      opening = options.source.openCount({ id: newId, spaceId: options.spaceId ?? null }).then(() => { countId = newId; });
    }
    await opening;
    return countId;
  }

  async function saveLine(t: Target, value: number): Promise<void> {
    const cid = await ensureCount();
    if (!cid || !options.source.saveCountLine) return;
    const existing = lines().find((l) => keyOf(l) === keyOf(t)) ?? null;
    const line: CountLineRow = { id: existing?.id ?? newItemId(), countId: cid, itemId: t.itemId, spaceId: t.spaceId, lotId: t.lotId, quantity: value, note: existing?.note ?? null };
    await options.source.saveCountLine(line, !existing);
  }

  // --- Contar ------------------------------------------------------------------------------------------------
  function lineRow(t: Target): HTMLElement {
    const it = itemOf(t.itemId)!;
    const k = keyOf(t);
    const lot = lotOf(t.lotId);
    const inputId = `stk-count-${k.replace(/[^a-z0-9]/gi, '')}`;
    const value = typing.get(k) ?? (t.line ? formatQuantity(t.line.quantity, 3) : '');
    const error = el('span', { class: 'fielderror', role: 'alert' });
    const input = el('input', { type: 'text', id: inputId, inputmode: 'decimal', value, autocomplete: 'off', 'aria-describedby': `${inputId}-sub`, ...mark('line'),
      oninput: () => { typing.set(k, input.value); schedule(); paintReviewState(); },
      onblur: () => { if (typing.has(k)) commit(); },
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); commit(); } },
    }) as HTMLInputElement;
    function commit(): void {
      clearTimeout(timers.get(k));
      const n = parseQuantity(input.value);
      if (n === null) { typing.delete(k); return; }
      if (Number.isNaN(n) || n < 0) { error.textContent = kt('Escribe un número, por ejemplo 12,5.'); return; }
      error.textContent = '';
      typing.delete(k);
      void saveLine(t, Math.round(n * 1e6) / 1e6);
    }
    function schedule(): void { clearTimeout(timers.get(k)); timers.set(k, setTimeout(commit, 600)); }
    function nudge(d: number): void {
      const n = parseQuantity(input.value);
      const next = Math.max(0, (n === null || Number.isNaN(n) ? 0 : n) + d);
      input.value = formatQuantity(next, 3);
      typing.set(k, input.value);
      commit();
    }
    const sub = [spaceName(t.spaceId), lot ? `${lot.code ? kt('lote {code}', { code: lot.code }) : kt('lote sin código')}${lot.expiresOn ? ` · ${expiryText(lot.expiresOn, today)}` : ''}` : null, showExpected ? kt('calculado {q}', { q: qty(t.expected, it.baseUnit) }) : null].filter(Boolean).join(' · ');
    return el('div', { class: `stk-count-line${t.line ? ' done' : ''}${t.line?.pending ? ' pending' : ''}`, dataset: { itemId: t.itemId, spaceId: t.spaceId, lotId: t.lotId ?? '' } },
      el('label', { class: 'stk-count-name', for: inputId }, it.name, t.line ? el('span', { class: 'stk-count-check', 'aria-label': kt('contado') }, icon('check', 14)) : null),
      el('div', { class: 'qty with-unit stk-count-qty' },
        el('button', { type: 'button', class: 'iconbtn small qty-step', 'aria-label': kt('Restar uno a {name}', { name: it.name }), ...mark('minus'), onclick: () => nudge(-1) }, icon('minus', 14)),
        el('div', { class: 'qty-input' }, input, el('span', { class: 'qty-unit' }, it.baseUnit)),
        el('button', { type: 'button', class: 'iconbtn small qty-step', 'aria-label': kt('Sumar uno a {name}', { name: it.name }), ...mark('plus'), onclick: () => nudge(1) }, icon('plus', 14))),
      el('small', { class: 'stk-count-sub', id: `${inputId}-sub` }, sub),
      error);
  }

  function addOther(host: HTMLElement): void {
    let spaceId: string | null = chip !== 'todo' && chip !== 'pending' ? chip : options.spaceId ?? null;
    const scope = scopeIds();
    const spacePicker = spaceRows.length ? createSpacePicker({ label: kt('Dónde'), rows: scope ? spaceRows.filter((r) => scope.includes(r.id)) : spaceRows, value: spaceId, onChange: (ids) => { spaceId = ids[0] ?? null; } }) : null;
    const picker = createItemPicker({
      label: kt('Artículo'), source: options.source, create: true, ...(options.spaces ? { spaces: options.spaces } : {}),
      onChange: (p) => {
        if (!p.itemId) return;
        const it = itemOf(p.itemId);
        const where = spaceId ?? it?.defaultSpaceId ?? null;
        if (!where) { replace(host, el('p', { class: 'fielderror' }, kt('Elige dónde está.')), spacePicker?.element ?? null, picker.element); return; }
        added.push({ itemId: p.itemId, spaceId: where, lotId: null });
        picker.destroy();
        replace(host);
        paint();
        body.querySelector<HTMLInputElement>(`[data-item-id="${p.itemId}"][data-space-id="${where}"] input`)?.focus();
      },
    });
    replace(host, el('div', { class: 'stk-count-add' }, spacePicker?.element ?? null, picker.element,
      el('button', { type: 'button', class: 'ghost small', onclick: () => { picker.destroy(); replace(host); } }, kt('Cancelar'))));
    picker.focus();
  }

  function paintCount(): void {
    const all = targets();
    const done = all.filter((t) => t.line).length;
    const spacesHere = [...new Set(all.map((t) => t.spaceId))];
    const shown = all.filter((t) => (chip === 'todo' ? true : chip === 'pending' ? !t.line : t.spaceId === chip));
    const addHost = el('div', { class: 'stk-count-add-host' });
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    replace(body,
      el('header', { class: 'stk-count-head' },
        el('h3', { class: 'stk-sheet-title' }, kt('Recuento · {space}', { space: options.itemIds?.length === 1 ? itemOf(options.itemIds[0]!)?.name ?? '' : spaceName(options.spaceId ?? null) })),
        el('div', { class: 'stk-count-progress-row' },
          el('span', { class: 'stk-count-progress-text', 'aria-live': 'polite' }, el('strong', null, kt('{n} de {m}', { n: String(done), m: String(all.length) })), ` ${kt('contados')}`),
          el('button', { type: 'button', class: 'linkbtn', 'aria-pressed': String(showExpected), ...mark('expected'), onclick: () => { showExpected = !showExpected; paint(); } }, showExpected ? kt('Ocultar lo calculado') : kt('Ver lo calculado'))),
        el('div', { class: 'stk-count-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(all.length), 'aria-valuenow': String(done), 'aria-label': kt('Contados') },
          el('span', { style: `width:${all.length ? Math.round((done / all.length) * 100) : 0}%` }))),
      spacesHere.length > 1 || all.length > done
        ? el('div', { class: 'stk-chips', role: 'group', 'aria-label': kt('Sitios') },
          el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(chip === 'todo'), ...mark('filter'), onclick: () => { chip = 'todo'; paint(); } }, kt('Todo')),
          ...(spacesHere.length > 1 ? spacesHere.map((sid) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(chip === sid), ...mark('filter'), onclick: () => { chip = sid; paint(); } }, spaceName(sid))) : []),
          el('button', { type: 'button', class: 'filterchip stk-count-pending-chip', 'aria-pressed': String(chip === 'pending'), ...mark('filter'), onclick: () => { chip = 'pending'; paint(); } }, kt('Sin contar ({n})', { n: String(all.length - done) })))
        : null,
      el('div', { class: 'stk-count-lines' }, ...shown.map(lineRow), shown.length ? null : el('p', { class: 'hint stk-empty' }, all.length ? kt('Todo contado aquí.') : kt('No consta nada en este sitio: añade lo que encuentres.'))),
      addHost,
      el('button', { type: 'button', class: 'ghost small stk-count-other', ...mark('add'), onclick: () => addOther(addHost) }, icon('plus', 14), kt('Contar otro artículo aquí')),
      el('div', { class: 'stk-count-foot' },
        offline ? el('p', { class: 'item-offline' }, icon('offline', 14), kt('Sin conexión: las líneas se guardan y se suben al volver.')) : null,
        el('div', { class: 'stk-sheet-actions' },
          options.onLeave ? el('button', { type: 'button', class: 'ghost', ...mark('leave'), onclick: () => options.onLeave!() }, kt('Seguir luego')) : null,
          el('button', { type: 'button', class: 'primary stk-count-review', disabled: !done && !typed(), ...mark('review'), onclick: () => { flush(); view = 'review'; paint(); } }, kt('Revisar y cerrar')))));
  }

  /** Hay alguna cantidad escrita y aún sin guardar. */
  const typed = () => [...typing.values()].some((v) => v.trim() !== '');

  /**
   * Lo que depende de cuántos van contados, sin repintar las líneas: el contador, «Sin contar (n)» y si «Revisar y
   * cerrar» se puede pulsar. Lo usa el repintado parcial (con el foco en una casilla) y cada tecla.
   */
  function paintReviewState(all = targets()): void {
    const done = all.filter((t) => t.line).length;
    const label = body.querySelector('.stk-count-progress-text');
    if (label) replace(label, el('strong', null, kt('{n} de {m}', { n: String(done), m: String(all.length) })), ` ${kt('contados')}`);
    const bar = body.querySelector<HTMLElement>('.stk-count-bar');
    if (bar) { bar.setAttribute('aria-valuenow', String(done)); const fill = bar.querySelector<HTMLElement>('span'); if (fill) fill.style.width = `${all.length ? Math.round((done / all.length) * 100) : 0}%`; }
    const pending = body.querySelector('.stk-count-pending-chip');
    if (pending) pending.textContent = kt('Sin contar ({n})', { n: String(all.length - done) });
    const review = body.querySelector<HTMLButtonElement>('.stk-count-review');
    if (review) review.disabled = !done && !typed();
  }

  /** Guarda ya lo que quede escrito (antes de revisar). */
  function flush(): void {
    for (const [k, t] of timers) { clearTimeout(t); timers.delete(k); }
    body.querySelectorAll<HTMLInputElement>('.stk-count-line input').forEach((i) => i.dispatchEvent(new Event('blur')));
  }

  // --- Revisar y cerrar ----------------------------------------------------------------------------------------
  function differences(): CountDifference[] {
    return lines().map((l) => {
      const expected = stockAt(snap.stock, l.itemId, l.spaceId, l.lotId);
      return { itemId: l.itemId, spaceId: l.spaceId, lotId: l.lotId, expected, counted: l.quantity, difference: Math.round((l.quantity - expected) * 1e6) / 1e6 };
    });
  }

  function paintReview(): void {
    const diffs = differences();
    const off = diffs.filter((d) => d.difference !== 0);
    const ok = diffs.filter((d) => d.difference === 0);
    const row = (d: CountDifference) => {
      const it = itemOf(d.itemId)!;
      const lot = lotOf(d.lotId);
      return el('div', { class: `stk-diff${d.difference ? '' : ' ok'}`, dataset: { itemId: d.itemId } },
        el('span', { class: 'stk-diff-name' }, el('strong', null, it.name), el('small', null, [spaceName(d.spaceId), lot?.code ? kt('lote {code}', { code: lot.code }) : null, kt('calculado {a} · contado {b}', { a: qty(d.expected, it.baseUnit), b: qty(d.counted, it.baseUnit) })].filter(Boolean).join(' · '))),
        el('span', { class: `stk-diff-n${d.difference < 0 ? ' minus' : d.difference > 0 ? ' plus' : ''}` }, d.difference ? `${d.difference > 0 ? '+' : '−'}${qty(Math.abs(d.difference), it.baseUnit)}` : kt('cuadra')));
    };
    replace(body,
      el('header', { class: 'stk-count-head' }, el('h3', { class: 'stk-sheet-title' }, kt('Cerrar el recuento'))),
      el('p', { class: 'stk-callout' }, kt('{n} contados · {d} con diferencia · {k} cuadran', { n: String(diffs.length), d: String(off.length), k: String(ok.length) })),
      el('div', { class: 'stk-diffs' }, ...off.map(row), ...(showMatching ? ok.map(row) : [])),
      ok.length ? el('button', { type: 'button', class: 'linkbtn', onclick: () => { showMatching = !showMatching; paint(); } }, showMatching ? kt('Ocultar los que cuadran') : kt('Ver los {n} que cuadran', { n: String(ok.length) })) : null,
      el('p', { class: 'hint stk-close-note' }, kt('Se cierra al sincronizar: el ajuste se calcula con el stock que haya entonces, así que lo que se mueva mientras tanto entra en la diferencia. Lo que no se ha contado no cambia.')),
      el('div', { class: 'stk-sheet-actions' },
        el('button', { type: 'button', class: 'ghost', ...mark('back'), onclick: () => { view = 'count'; paint(); } }, kt('Volver a contar')),
        el('button', { type: 'button', class: 'primary', ...mark('close'), onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          try {
            await options.source.closeCount?.(countId!);
            view = 'done';
            paint();
            options.onClosed?.(diffs);
          } catch (error) {
            btn.disabled = false;
            body.append(el('p', { class: 'fielderror', role: 'alert' }, kt('No se ha cerrado: {message}', { message: (error as Error)?.message ?? '' })));
          }
        } }, kt('Cerrar y ajustar'))));
  }

  function paintDone(): void {
    const closed = count()?.status === 'cerrado';
    replace(body, el('div', { class: 'stk-count-done', role: 'status' },
      icon('check', 22),
      el('p', null, el('strong', null, closed ? kt('Recuento cerrado y ajustado.') : kt('Recuento cerrado.')), ' ', closed ? '' : kt('Se ajusta al sincronizar.'))));
  }

  function paint(): void {
    // No repintar mientras se escribe en una línea (la fuente avisa de cada guardado).
    const active = document.activeElement;
    if (view === 'count' && active instanceof HTMLInputElement && body.contains(active) && active.closest('.stk-count-line')) {
      const all = targets();
      paintReviewState(all);
      // Solo la marca de «contado» de cada fila, sin tocar lo que se está escribiendo.
      const counted = new Set(all.filter((t) => t.line).map(keyOf));
      body.querySelectorAll<HTMLElement>('.stk-count-line').forEach((row) => {
        const done = counted.has(`${row.dataset.itemId}|${row.dataset.spaceId}|${row.dataset.lotId ?? ''}`);
        row.classList.toggle('done', done);
        const name = row.querySelector('.stk-count-name');
        if (done && name && !name.querySelector('.stk-count-check')) name.append(el('span', { class: 'stk-count-check', 'aria-label': kt('contado') }, icon('check', 14)));
      });
      return;
    }
    if (view === 'count') paintCount(); else if (view === 'review') paintReview(); else paintDone();
  }

  // --- Datos -------------------------------------------------------------------------------------------------
  // Al salir de una línea se guarda y la fuente avisa en el acto, cuando el foco aún no ha llegado a la siguiente
  // casilla: repintar entonces sustituiría la casilla recién tocada y se perdería lo que se escribe en ella. Se espera
  // un tick, y con el foco ya en otra línea solo se actualizan las marcas.
  let paintTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePaint(): void {
    if (paintTimer) return;
    paintTimer = setTimeout(() => { paintTimer = null; paint(); }, 0);
  }
  function setSnapshot(next: ItemSnapshot): void {
    snap = next;
    // Retomar el recuento abierto de este sitio (no en un «Recontar» de una fila, que es suyo).
    if (!countId && !options.itemIds?.length) {
      const open = (snap.counts ?? []).filter((c) => c.status === 'abierto' && c.spaceId === (options.spaceId ?? null)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (open) countId = open.id;
    }
    if (count()?.status === 'cerrado' && view === 'count') view = 'done';
    schedulePaint();
  }
  const offSource = options.source.subscribe?.(setSnapshot);
  const offSpaces = options.spaces && !Array.isArray(options.spaces) ? options.spaces.subscribe((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paint(); }) : null;
  if (options.spaces && !Array.isArray(options.spaces)) void Promise.resolve(options.spaces.list()).then((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paint(); });
  void Promise.resolve(options.source.list()).then(setSnapshot);
  paint();

  return {
    element,
    destroy() { for (const t of timers.values()) clearTimeout(t); if (paintTimer) clearTimeout(paintTimer); offSource?.(); offSpaces?.(); element.remove(); },
  };
}
