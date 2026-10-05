import type { PendingConflict } from '@ikisai/sync-client';
import { el, formatDate, replace } from './dom.ts';
import { toast } from './toast.ts';
import { categoryLabel, describeError } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

const FIELD_LABELS: Record<string, string> = { name: 'Nombre', tax_id: 'NIF', default_category: 'Categoría', notes: 'Notas', deleted_at: 'Borrado' };
const SYSTEM = new Set(['id', 'revision', 'created_at', 'updated_at', 'updated_by', '_pending']);

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'default_category') return categoryLabel(value);
  if (field === 'deleted_at') return formatDate(String(value));
  return String(value);
}

/** Panel de conflictos: ambas versiones campo a campo y las tres decisiones del contrato §6.3. */
export const mountConflicts: ViewMount = ({ main, client, navigate }) => {
  const host = el('div');
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Conflictos'), el('p', null, 'Otra persona cambió lo mismo que tú. Nada se pierde hasta que decidas.'))),
    host,
  );

  async function resolve(conflict: PendingConflict, decision: Parameters<typeof client.resolveConflict>[1]): Promise<void> {
    try {
      await client.resolveConflict(conflict.requestId, decision);
      toast('Conflicto resuelto. Se enviará tu decisión al servidor.');
      await load();
      if ((await client.conflicts()).length === 0) navigate('#/proveedores');
    } catch (error) {
      toast(describeError(error));
    }
  }

  function card(conflict: PendingConflict): HTMLElement {
    const op = conflict.operation;
    const mine: Record<string, unknown> = op.op === 'update' ? op.fields : {};
    const changedByServer = Object.keys(conflict.current).filter((k) => !SYSTEM.has(k) && conflict.base && conflict.base[k] !== conflict.current[k]);
    const fields = Array.from(new Set([...Object.keys(mine), ...conflict.overlapping, ...changedByServer]));
    const picks = new Map<string, 'mine' | 'theirs'>();
    let merging = false;

    const rowName = String(conflict.current.name ?? conflict.base?.name ?? op.id);
    const title = op.op === 'delete' ? `Querías borrar «${rowName}»` : `«${rowName}»`;
    const article = el('article', { class: 'conflict', dataset: { requestId: conflict.requestId } });

    function pick(field: string, side: 'mine' | 'theirs'): HTMLElement {
      const input = el('input', { type: 'radio', name: `pick-${conflict.requestId}-${field}`, value: side, checked: (picks.get(field) ?? 'mine') === side, onchange: () => picks.set(field, side) });
      return el('label', { class: 'pick' }, input, side === 'mine' ? 'usar la mía' : 'usar esta');
    }

    function table(): HTMLElement {
      return el('table', null,
        el('thead', null, el('tr', null, el('th', null, 'Campo'), el('th', null, 'Tu versión'), el('th', null, 'Servidor'))),
        el('tbody', null, ...fields.map((field) => {
          const overlap = conflict.overlapping.includes(field);
          const myValue = field in mine ? mine[field] : op.op === 'delete' && field === 'deleted_at' ? 'borrar' : conflict.base?.[field];
          const editable = merging && field in mine;
          return el('tr', { class: overlap ? 'overlap' : '' },
            el('td', null, FIELD_LABELS[field] ?? field),
            el('td', null, show(field, myValue), editable ? el('div', null, pick(field, 'mine')) : null),
            el('td', null, show(field, conflict.current[field]), editable ? el('div', null, pick(field, 'theirs')) : null),
          );
        })),
      );
    }

    function choices(): HTMLElement {
      if (!merging) {
        return el('div', { class: 'choices' },
          el('button', { class: 'primary', type: 'button', onclick: () => void resolve(conflict, { choice: 'mine' }) }, 'Mantener la mía'),
          el('button', { class: 'ghost', type: 'button', onclick: () => void resolve(conflict, { choice: 'theirs' }) }, 'Tomar la del servidor'),
          op.op === 'update' ? el('button', { class: 'ghost', type: 'button', onclick: () => { merging = true; repaint(); } }, 'Combinar campo a campo') : null,
        );
      }
      return el('div', { class: 'choices' },
        el('button', { class: 'primary', type: 'button', onclick: () => {
          const merged: Record<string, unknown> = {};
          for (const field of Object.keys(mine)) if ((picks.get(field) ?? 'mine') === 'mine') merged[field] = mine[field];
          void resolve(conflict, { choice: 'merge', fields: merged });
        } }, 'Guardar combinación'),
        el('button', { class: 'ghost', type: 'button', onclick: () => { merging = false; repaint(); } }, 'Volver'),
      );
    }

    function repaint(): void {
      replace(article,
        el('h3', null, title),
        el('p', { style: 'color:var(--muted);font-size:13px' }, `Detectado ${formatDate(conflict.detectedAt)} · revisión del servidor ${conflict.current.revision}`),
        table(),
        choices(),
      );
    }
    repaint();
    return article;
  }

  async function load(): Promise<void> {
    const conflicts = await client.conflicts();
    replace(host, conflicts.length === 0
      ? el('div', { class: 'empty' }, el('strong', null, 'Sin conflictos'), 'Todo lo tuyo se ha podido aplicar sin pisar cambios de nadie.')
      : conflicts.map(card));
  }

  void load();
  const off = client.onStatus(() => void load());
  return () => off();
};
