import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, el, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  DECISION_SCOPES, DECISION_SCOPE_LABELS, DECISION_STATUSES, DECISION_STATUS_LABELS, filterDecisions, todayInMadrid, validateOperations,
} from '@ikisai/domain-central';
import { guard } from '../app/guard.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

type Decision = Mirror<{
  id: string; revision: number; deleted_at: string | null; code: string | null; decided_on: string; name: string; summary: string;
  technical: string | null; responsible_person_id: string | null; status: string; superseded_by: string | null; scopes: string[];
  link_url: string | null; link_label: string | null;
}>;

const day = (d: string) => d.split('-').reverse().join('/');
const text = (v: string) => v.trim() || null;

/**
 * Registro de decisiones (C01; API.md §2.10). Cada decisión en tres niveles plegables (decisión del usuario, ronda 9):
 * nombre en lenguaje llano → descripción llana → explicación técnica. Owner y editor escriben; todos leen.
 */
export const mountDecisions: ViewMount = ({ main, client }) => {
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  let rows: Decision[] = [];
  let people = new Map<string, string>();
  let query = '';
  let scope = '';
  let status = '';
  const open = new Set<string>();
  const host = el('div', { id: 'decisionList' });
  const search = el('input', { type: 'search', id: 'decisionSearch', placeholder: 'Buscar en las decisiones', 'aria-label': 'Buscar decisión',
    oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; paint(); } });
  const scopeFilter = el('select', { id: 'decisionScope', 'aria-label': 'App o área', onchange: (e: Event) => { scope = (e.target as HTMLSelectElement).value; paint(); } },
    el('option', { value: '' }, 'Todas las apps'), ...DECISION_SCOPES.map((s) => el('option', { value: s }, DECISION_SCOPE_LABELS[s] ?? s)));
  const statusFilter = el('select', { id: 'decisionStatus', 'aria-label': 'Estado', onchange: (e: Event) => { status = (e.target as HTMLSelectElement).value; paint(); } },
    el('option', { value: '' }, 'Todos los estados'), ...DECISION_STATUSES.map((s) => el('option', { value: s }, DECISION_STATUS_LABELS[s])));
  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Decisiones'), el('p', null, 'Lo que se ha decidido, por qué y cómo se aplica.'))),
    el('div', { class: 'toolbar' }, search, scopeFilter, statusFilter),
    host,
    canEdit ? el('button', { class: 'fab', type: 'button', id: 'newDecision', onclick: () => openEditor(null) }, icon('plus'), 'Nueva decisión') : null);

  function item(d: Decision): HTMLElement {
    const replacement = d.superseded_by ? rows.find((r) => r.id === d.superseded_by) : null;
    const details = el('details', { class: 'decision', 'data-decision': d.id, open: open.has(d.id) },
      // Nivel 1: el nombre, en lenguaje llano.
      el('summary', { class: 'decisionname' },
        el('span', null, d.name),
        el('span', { class: 'chips' },
          el('span', { class: 'muted small' }, `${d.code ?? ''} · ${day(d.decided_on)}`),
          d.status !== 'vigente' ? el('span', { class: d.status === 'revocada' ? 'chip alert' : 'chip' }, DECISION_STATUS_LABELS[d.status as keyof typeof DECISION_STATUS_LABELS] ?? d.status) : null,
          ...(d.scopes ?? []).map((s) => el('span', { class: 'chip' }, DECISION_SCOPE_LABELS[s] ?? s)),
          d._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null)),
      // Nivel 2: qué se decidió y por qué.
      el('div', { class: 'decisionbody' },
        el('p', { class: 'pre' }, d.summary),
        replacement ? el('p', { class: 'muted small' }, 'Sustituida por ', el('a', { href: '#/decisiones', onclick: (e: Event) => { e.preventDefault(); focusOn(replacement.id); } }, `${replacement.code ?? ''} ${replacement.name}`)) : null,
        // Nivel 3: la explicación técnica, plegada.
        d.technical ? el('details', { class: 'technical' }, el('summary', null, 'Explicación técnica'), el('p', { class: 'pre' }, d.technical)) : null,
        el('div', { class: 'muted small' }, [
          d.responsible_person_id ? `Responsable: ${people.get(d.responsible_person_id) ?? '—'}` : '',
        ].filter(Boolean).join(' · ')),
        d.link_url ? el('a', { href: d.link_url, target: '_blank', rel: 'noopener', class: 'small' }, icon('attach', 14), ' ', d.link_label ?? d.link_url) : null,
        canEdit ? el('button', { class: 'linkbtn', type: 'button', onclick: () => openEditor(d) }, icon('edit', 16), 'Editar') : null));
    details.addEventListener('toggle', () => { if (details.open) open.add(d.id); else open.delete(d.id); });
    return details;
  }

  function focusOn(id: string): void {
    query = ''; scope = ''; status = '';
    (search as HTMLInputElement).value = ''; (scopeFilter as HTMLSelectElement).value = ''; (statusFilter as HTMLSelectElement).value = '';
    open.add(id);
    paint();
    host.querySelector(`[data-decision="${id}"]`)?.scrollIntoView({ block: 'start' });
  }

  function paint(): void {
    const shown = filterDecisions(rows, query, scope, status);
    replace(host, shown.length ? el('div', { class: 'decisions' }, ...shown.map(item))
      : el('div', { class: 'empty' }, el('strong', null, rows.some((r) => !r.deleted_at) ? 'Ninguna decisión coincide' : 'Todavía no hay decisiones'),
        rows.length ? 'Cambia la búsqueda o los filtros.' : canEdit ? 'Apunta lo que se decide, para que cualquiera lo entienda después.' : ''));
  }

  function openEditor(d: Decision | null): void {
    let sheet: Sheet | null = null;
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
    const date = el('input', { id: 'dc-date', type: 'date', value: d?.decided_on ?? todayInMadrid() }) as HTMLInputElement;
    const name = el('input', { id: 'dc-name', type: 'text', maxlength: '160', value: d?.name ?? '' }) as HTMLInputElement;
    const summary = el('textarea', { id: 'dc-summary', rows: '4', maxlength: '2000' }) as HTMLTextAreaElement;
    summary.value = d?.summary ?? '';
    const technical = el('textarea', { id: 'dc-technical', rows: '5', maxlength: '8000' }) as HTMLTextAreaElement;
    technical.value = d?.technical ?? '';
    const statusSel = el('select', { id: 'dc-status' }, ...DECISION_STATUSES.map((s) => el('option', { value: s, selected: (d?.status ?? 'vigente') === s }, DECISION_STATUS_LABELS[s]))) as HTMLSelectElement;
    const others = rows.filter((r) => !r.deleted_at && r.id !== d?.id).sort((a, b) => b.decided_on.localeCompare(a.decided_on));
    const supersededBy = el('select', { id: 'dc-superseded' }, el('option', { value: '' }, 'Elige la decisión nueva'),
      ...others.map((r) => el('option', { value: r.id, selected: d?.superseded_by === r.id }, `${r.code ?? ''} ${r.name}`))) as HTMLSelectElement;
    const supersededField = el('label', { class: 'field' }, el('span', null, 'Sustituida por'), supersededBy);
    const responsible = el('select', { id: 'dc-responsible' }, el('option', { value: '' }, 'Sin responsable'),
      ...[...people].sort((a, b) => a[1].localeCompare(b[1], 'es')).map(([id, n]) => el('option', { value: id, selected: d?.responsible_person_id === id }, n))) as HTMLSelectElement;
    const scopeBoxes = DECISION_SCOPES.map((s) => el('input', { type: 'checkbox', value: s, checked: (d?.scopes ?? []).includes(s) }) as HTMLInputElement);
    const linkUrl = el('input', { id: 'dc-link', type: 'url', maxlength: '500', placeholder: 'https://…', value: d?.link_url ?? '' }) as HTMLInputElement;
    const linkLabel = el('input', { id: 'dc-link-label', type: 'text', maxlength: '120', placeholder: 'PR #123, documento, tarea…', value: d?.link_label ?? '' }) as HTMLInputElement;
    const sync = () => { supersededField.hidden = statusSel.value !== 'sustituida'; };
    sync();
    statusSel.addEventListener('change', sync);

    const values = (): Record<string, unknown> => ({
      decided_on: date.value, name: name.value.trim(), summary: summary.value.trim(), technical: text(technical.value), status: statusSel.value,
      superseded_by: statusSel.value === 'sustituida' ? supersededBy.value || null : null, responsible_person_id: responsible.value || null,
      scopes: scopeBoxes.filter((b) => b.checked).map((b) => b.value), link_url: text(linkUrl.value), link_label: text(linkLabel.value),
    });
    const changed = () => (d ? Object.fromEntries(Object.entries(values()).filter(([k, v]) => JSON.stringify(d[k] ?? null) !== JSON.stringify(v ?? null))) : values());
    const refresh = () => { const dirty = Object.keys(changed()).length > 0; guard.dirtyEditor = d ? dirty : name.value.trim() !== ''; sheet?.setFootHidden(d !== null && !dirty); };
    const save = el('button', { class: 'primary', type: 'submit', id: 'saveDecision', form: 'decisionForm' }, 'Guardar') as HTMLButtonElement;
    const form = el('form', { novalidate: true, id: 'decisionForm', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
      event.preventDefault();
      error.textContent = '';
      const id = d?.id ?? crypto.randomUUID();
      const operations: RowOperation[] = d
        ? [{ op: 'update', table: T.decisions, id, expectedRevision: d.revision, fields: changed() }]
        : [{ op: 'insert', table: T.decisions, id, fields: values() }];
      const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' }, () => d ?? undefined);
      if (issue) { error.textContent = issue.message; error.scrollIntoView({ block: 'nearest' }); return; }
      save.disabled = true;
      try {
        await client.commit(operations);
        toast(!navigator.onLine ? 'Decisión guardada en este dispositivo. Se sincronizará cuando haya red.' : 'Decisión guardada.');
        guard.dirtyEditor = false;
        open.add(id);
        await sheet?.close(true);
      } catch (e) { error.textContent = describeError(e); } finally { save.disabled = false; }
    } },
    el('label', { class: 'field' }, el('span', null, 'Nombre'), name, el('span', { class: 'muted small' }, 'En lenguaje llano: que lo entienda cualquiera sin contexto técnico.')),
    el('label', { class: 'field' }, el('span', null, 'Qué se decidió y por qué'), summary, el('span', { class: 'muted small' }, 'También en lenguaje llano, en pocas frases.')),
    el('label', { class: 'field' }, el('span', null, 'Explicación técnica (opcional)'), technical, el('span', { class: 'muted small' }, 'Cómo se aplica, qué apps o tablas toca, alternativas descartadas.')),
    el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Fecha'), date), el('label', { class: 'field' }, el('span', null, 'Estado'), statusSel)),
    supersededField,
    el('label', { class: 'field' }, el('span', null, 'Responsable'), responsible),
    el('fieldset', { class: 'field scopes' }, el('legend', null, 'Apps o áreas afectadas'),
      ...scopeBoxes.map((b) => el('label', { class: 'check' }, b, el('span', null, DECISION_SCOPE_LABELS[b.value] ?? b.value)))),
    el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Enlace'), linkUrl), el('label', { class: 'field' }, el('span', null, 'Texto del enlace'), linkLabel)),
    error,
    d ? el('div', { class: 'zone' }, el('button', { class: 'danger', type: 'button', id: 'deleteDecision', onclick: async () => {
      if (!(await confirmDialog({ title: '¿Enviar la decisión a la papelera?', text: 'Si ya no vale, mejor márcala revocada o sustituida: así queda el rastro.', confirmLabel: 'Enviar a papelera', danger: true }))) return;
      try { await client.commit([{ op: 'delete', table: T.decisions, id: d.id, expectedRevision: d.revision }]); guard.dirtyEditor = false; await sheet?.close(true); toast('Decisión enviada a la papelera.'); }
      catch (e) { error.textContent = describeError(e); }
    } }, icon('trash', 18), 'Enviar a papelera')) : null);
    sheet = openSheet({
      title: d ? 'Editar decisión' : 'Nueva decisión', meta: d?.code ?? undefined, body: form,
      foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, d ? 'Cerrar' : 'Cancelar'), save],
      footHidden: d !== null, initialFocus: name,
      beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
      onClose: () => { guard.dirtyEditor = false; sheet = null; },
    });
  }

  async function load(): Promise<void> {
    rows = (await client.list(T.decisions, { includeDeleted: true })) as unknown as Decision[];
    people = new Map((await client.list(T.people)).map((p) => [p.id, String(p.display_name ?? '')]));
    paint();
  }
  void load();
  const offs = [client.onTable(T.decisions, () => void load()), client.onTable(T.people, () => void load())];
  return () => offs.forEach((off) => off());
};
