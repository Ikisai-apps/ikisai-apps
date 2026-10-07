import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import { compressImage, confirmDialog, el, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  CLOSED_REQUIREMENT_STATUSES, DOCUMENT_KINDS, DOCUMENT_KIND_LABELS, FREQUENCIES, FREQUENCY_LABELS, IMPACTS, IMPACT_LABELS,
  KEY_DOCUMENT_STATUSES, KEY_DOCUMENT_STATUS_LABELS, RECORD_TYPE_LABELS, REQUIREMENT_STATUSES, REQUIREMENT_STATUS_LABELS,
  REQUIREMENT_TYPES, REQUIREMENT_TYPE_LABELS, RISKS, RISK_LABELS, canSeeReserved, dueItems, dueState, nextExpiry, todayInMadrid,
  validateOperations, type DueItem,
} from '@ikisai/domain-central';
import { guard } from '../app/guard.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

type Base = { id: string; revision: number; updated_at: string; deleted_at: string | null; code?: string };
type Requirement = Mirror<Base & Record<string, unknown> & { name: string; requirement_type: string; status: string; risk: string; frequency: string; notice_days: number; expires_on: string | null }>;
type KeyDocument = Mirror<Base & Record<string, unknown> & { name: string; document_type: string; status: string; requirement_id: string | null; expires_on: string | null; file_id: unknown }>;
type TaskLink = Mirror<Base & { requirement_id: string; target_id: string; target_label: string | null; due_on: string | null; external_ref: string }>;
interface TaskStatus { id: string; title?: string; done?: boolean; deleted?: boolean; pending?: boolean; visible?: boolean; request?: string }

export type ComplianceTab = 'vencimientos' | 'requisitos' | 'documentos';
const TABS: Array<{ id: ComplianceTab; label: string; hash: string }> = [
  { id: 'vencimientos', label: 'Vencimientos', hash: '#/cumplimiento' },
  { id: 'requisitos', label: 'Obligaciones', hash: '#/cumplimiento/requisitos' },
  { id: 'documentos', label: 'Documentos', hash: '#/cumplimiento/documentos' },
];
const FILE_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const text = (v: string) => v.trim() || null;
const date = (v: string) => v || null;
const day = (d: unknown) => (typeof d === 'string' && d ? d.split('-').reverse().join('/') : '—');
const label = (map: Record<string, string>, v: unknown) => map[String(v)] ?? String(v ?? '');

function options(values: readonly string[], labels: Record<string, string>, selected: unknown, empty?: string): HTMLElement[] {
  return [
    ...(empty !== undefined ? [el('option', { value: '', selected: !selected }, empty)] : []),
    ...values.map((v) => el('option', { value: v, selected: selected === v }, labels[v] ?? v)),
  ];
}

async function loadAll(client: SyncClient) {
  const reserved = canSeeReserved(client.bootstrap()?.membership);
  const [requirements, documents, links, people, records] = await Promise.all([
    client.list(T.requirements, { includeDeleted: true }), client.list(T.keyDocuments, { includeDeleted: true }), client.list(T.requirementTasks),
    client.list(T.people), reserved ? client.list(T.personRecords) : Promise.resolve([]),
  ]);
  return {
    requirements: requirements as unknown as Requirement[], documents: documents as unknown as KeyDocument[], links: links as unknown as TaskLink[],
    people: people as unknown as Array<{ id: string; display_name: string; active: boolean }>, records: records as unknown as Array<Record<string, unknown>>,
  };
}
type Data = Awaited<ReturnType<typeof loadAll>>;

export function computeDue(data: Data, today = todayInMadrid()): DueItem[] {
  return dueItems({
    requirements: data.requirements, keyDocuments: data.documents, personRecords: data.records,
    peopleNames: new Map(data.people.map((p) => [p.id, p.display_name])), recordLabel: (r) => RECORD_TYPE_LABELS[String(r.record_type)] ?? String(r.record_type),
  }, today);
}

async function commitSafely(client: SyncClient, operations: RowOperation[], ok: string, current?: (t: string, id: string) => Record<string, unknown> | undefined): Promise<boolean> {
  const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' }, current);
  if (issue) { toast(issue.message); return false; }
  try {
    await client.commit(operations);
    toast(!navigator.onLine ? `${ok} Se sincronizará cuando haya red.` : ok);
    return true;
  } catch (error) {
    toast(describeError(error));
    return false;
  }
}

function stateChip(expires: string | null, notice: number, closed: boolean, today: string): HTMLElement | null {
  const s = dueState(expires, today, notice, closed);
  return s === 'al_dia' ? null : el('span', { class: s === 'vencido' ? 'chip alert' : 'chip warn' }, s === 'vencido' ? 'Vencido' : 'Vence pronto');
}

function tabsNav(tab: ComplianceTab): HTMLElement {
  return el('nav', { class: 'segmented', 'aria-label': 'Secciones de cumplimiento' },
    ...TABS.map((t) => el('a', { href: t.hash, id: `ctab-${t.id}`, class: t.id === tab ? 'active' : '', 'aria-current': t.id === tab ? 'page' : null }, t.label)));
}

// ---------------------------------------------------------------------------
// Listas: vencimientos, obligaciones y documentos
// ---------------------------------------------------------------------------
export function mountCompliance(tab: ComplianceTab): ViewMount {
  return (ctx) => {
    const { main, client, navigate } = ctx;
    const canEdit = client.bootstrap()?.membership.role !== 'reader';
    let data: Data | null = null;
    let typeFilter = '';
    const host = el('div', { id: `compliance-${tab}` });
    const fab = canEdit && tab === 'requisitos' ? el('button', { class: 'fab', type: 'button', id: 'newRequirement', onclick: () => openRequirementEditor(ctx.client, null, data, (id) => navigate(`#/cumplimiento/${id}`)) }, icon('plus'), 'Nueva obligación')
      : canEdit && tab === 'documentos' ? el('button', { class: 'fab', type: 'button', id: 'newDocument', onclick: () => openDocumentEditor(ctx.client, null, data, null) }, icon('plus'), 'Nuevo documento') : null;
    replace(main,
      el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Cumplimiento'), el('p', null, 'Obligaciones legales, seguros, licencias y revisiones, con sus vencimientos.'))),
      tabsNav(tab), host, fab);

    function paint(): void {
      if (!data) return;
      const today = todayInMadrid();
      if (tab === 'vencimientos') {
        const items = computeDue(data, today);
        replace(host, items.length ? el('ul', { class: 'accounts', id: 'dueList' }, ...items.map((i) => el('li', null,
          el('button', { class: 'personrow', type: 'button', 'data-due': i.id, onclick: () => {
            if (i.source === 'requirement') navigate(`#/cumplimiento/${i.id}`);
            else if (i.source === 'person_record') navigate(`#/personas/${i.parentId}`);
            else if (i.parentId) navigate(`#/cumplimiento/${i.parentId}`);
            else openDocumentEditor(client, data!.documents.find((d) => d.id === i.id) ?? null, data, null);
          } },
            el('span', { class: 'accountname' }, i.title),
            el('span', { class: 'muted accountmeta' }, [i.code, i.source === 'requirement' ? 'Obligación' : i.source === 'key_document' ? 'Documento' : 'Persona',
              i.state === 'vencido' ? `venció el ${day(i.dueOn)}` : `vence el ${day(i.dueOn)} (${i.daysLeft === 0 ? 'hoy' : `en ${i.daysLeft} días`})`].filter(Boolean).join(' · ')),
            el('span', { class: 'chips' }, el('span', { class: i.state === 'vencido' ? 'chip alert' : 'chip warn' }, i.state === 'vencido' ? 'Vencido' : 'Vence pronto'),
              i.risk === 'critico' || i.risk === 'alto' ? el('span', { class: 'chip' }, `Riesgo ${label(RISK_LABELS, i.risk).toLowerCase()}`) : null,
              i.blocksOperation ? el('span', { class: 'chip alert' }, 'Bloquea la operación') : null)))))
          : el('div', { class: 'empty' }, el('strong', null, 'Nada vencido ni por vencer'), 'Aquí aparecen las obligaciones, los documentos y la documentación de personas que vencen.'));
        return;
      }
      if (tab === 'requisitos') {
        const alive = data.requirements.filter((r) => !r.deleted_at && (!typeFilter || r.requirement_type === typeFilter))
          .sort((a, b) => String(a.expires_on ?? '9999').localeCompare(String(b.expires_on ?? '9999')) || a.name.localeCompare(b.name, 'es'));
        const filter = el('select', { id: 'reqType', 'aria-label': 'Tipo', onchange: (e: Event) => { typeFilter = (e.target as HTMLSelectElement).value; paint(); } },
          ...options(REQUIREMENT_TYPES, REQUIREMENT_TYPE_LABELS, typeFilter, 'Todos los tipos'));
        replace(host, el('div', { class: 'toolbar' }, filter), alive.length ? el('ul', { class: 'accounts', id: 'requirementList' }, ...alive.map((r) => el('li', null,
          el('button', { class: 'personrow', type: 'button', 'data-requirement': r.id, onclick: () => navigate(`#/cumplimiento/${r.id}`) },
            el('span', { class: 'accountname' }, r.name),
            el('span', { class: 'muted accountmeta' }, [r.code, label(REQUIREMENT_TYPE_LABELS, r.requirement_type), label(REQUIREMENT_STATUS_LABELS, r.status), r.expires_on ? `vence el ${day(r.expires_on)}` : ''].filter(Boolean).join(' · ')),
            el('span', { class: 'chips' }, stateChip(r.expires_on, r.notice_days, CLOSED_REQUIREMENT_STATUSES.includes(r.status), today),
              r.blocks_operation ? el('span', { class: 'chip alert' }, 'Bloquea la operación') : null,
              r._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null)))))
          : el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay obligaciones'), canEdit ? 'Apunta seguros, licencias, revisiones técnicas o compromisos de la concesión.' : ''));
        return;
      }
      const docs = data.documents.filter((d) => !d.deleted_at).sort((a, b) => a.name.localeCompare(b.name, 'es'));
      const reqName = (id: string | null) => data!.requirements.find((r) => r.id === id)?.name ?? '';
      replace(host, docs.length ? el('ul', { class: 'accounts', id: 'documentList' }, ...docs.map((d) => el('li', null,
        el('button', { class: 'personrow', type: 'button', 'data-document': d.id, onclick: () => openDocumentEditor(client, d, data, null) },
          el('span', { class: 'accountname' }, d.name),
          el('span', { class: 'muted accountmeta' }, [d.code, label(DOCUMENT_KIND_LABELS, d.document_type), label(KEY_DOCUMENT_STATUS_LABELS, d.status), reqName(d.requirement_id), d.expires_on ? `caduca el ${day(d.expires_on)}` : ''].filter(Boolean).join(' · ')),
          el('span', { class: 'chips' }, stateChip(d.expires_on, 30, d.status === 'sustituido', today), d.file_id ? el('span', { class: 'chip' }, icon('attach', 12), 'Archivo') : null)))))
        : el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay documentos clave'), 'Contratos, pólizas, licencias, actas…'));
    }

    async function load(): Promise<void> { data = await loadAll(client); paint(); }
    void load();
    const offs = [T.requirements, T.keyDocuments, T.requirementTasks, T.personRecords].map((t) => client.onTable(t, () => void load()));
    return () => offs.forEach((off) => off());
  };
}

// ---------------------------------------------------------------------------
// Editores
// ---------------------------------------------------------------------------
function personSelect(id: string, data: Data | null, selected: unknown): HTMLSelectElement {
  const people = (data?.people ?? []).filter((p) => p.active || p.id === selected).sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));
  return el('select', { id }, el('option', { value: '', selected: !selected }, 'Sin responsable'),
    ...people.map((p) => el('option', { value: p.id, selected: p.id === selected }, p.display_name))) as HTMLSelectElement;
}

function sheetEditor(opts: {
  title: string; meta?: string; existing: boolean; form: HTMLFormElement; save: HTMLButtonElement; focus: HTMLElement; onSheet: (s: Sheet) => void;
}): void {
  const sheet = openSheet({
    title: opts.title, meta: opts.meta, body: opts.form,
    foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, opts.existing ? 'Cerrar' : 'Cancelar'), opts.save],
    footHidden: opts.existing, initialFocus: opts.focus,
    beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
    onClose: () => { guard.dirtyEditor = false; },
  });
  opts.onSheet(sheet);
}

function openRequirementEditor(client: SyncClient, req: Requirement | null, data: Data | null, onCreated?: (id: string) => void): void {
  let sheet: Sheet | null = null;
  const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
  const input = (id: string, value: unknown, attrs: Record<string, string> = {}) => el('input', { id, type: 'text', value: value == null ? '' : String(value), ...attrs }) as HTMLInputElement;
  const area = (id: string, value: unknown, max: string) => { const t = el('textarea', { id, rows: '2', maxlength: max }) as HTMLTextAreaElement; t.value = value == null ? '' : String(value); return t; };
  const name = input('q-name', req?.name, { maxlength: '160' });
  const type = el('select', { id: 'q-type' }, ...options(REQUIREMENT_TYPES, REQUIREMENT_TYPE_LABELS, req?.requirement_type ?? 'seguro')) as HTMLSelectElement;
  const status = el('select', { id: 'q-status' }, ...options(REQUIREMENT_STATUSES, REQUIREMENT_STATUS_LABELS, req?.status ?? 'pendiente')) as HTMLSelectElement;
  const authority = input('q-authority', req?.authority, { maxlength: '160' });
  const source = input('q-source', req?.source, { maxlength: '300', placeholder: 'Norma, pliego, contrato…' });
  const responsible = personSelect('q-responsible', data, req?.responsible_person_id);
  const reference = input('q-reference', req?.reference_date, { type: 'date' });
  const expires = input('q-expires', req?.expires_on, { type: 'date' });
  const frequency = el('select', { id: 'q-frequency' }, ...options(FREQUENCIES, FREQUENCY_LABELS, req?.frequency ?? 'unica')) as HTMLSelectElement;
  const months = input('q-months', req?.frequency_months, { type: 'number', min: '1', max: '120', inputmode: 'numeric' });
  const monthsField = el('label', { class: 'field' }, el('span', null, 'Cada cuántos meses'), months);
  const notice = input('q-notice', req?.notice_days ?? 30, { type: 'number', min: '0', max: '365', inputmode: 'numeric' });
  const risk = el('select', { id: 'q-risk' }, ...options(RISKS, RISK_LABELS, req?.risk ?? 'medio')) as HTMLSelectElement;
  const impact = el('select', { id: 'q-impact' }, ...options(IMPACTS, IMPACT_LABELS, req?.impact, 'Sin indicar')) as HTMLSelectElement;
  const blocks = el('input', { type: 'checkbox', id: 'q-blocks', checked: req?.blocks_operation === true }) as HTMLInputElement;
  const cost = el('input', { type: 'checkbox', id: 'q-cost', checked: req?.generates_cost === true }) as HTMLInputElement;
  const nextAction = input('q-next', req?.next_action, { maxlength: '300' });
  const nextOn = input('q-next-on', req?.next_action_on, { type: 'date' });
  const description = area('q-description', req?.description, '2000');
  const notes = area('q-notes', req?.notes, '1000');
  const syncMonths = () => { monthsField.hidden = frequency.value !== 'otra'; };
  syncMonths();
  frequency.addEventListener('change', syncMonths);

  const values = (): Record<string, unknown> => ({
    name: name.value.trim(), requirement_type: type.value, status: status.value, authority: text(authority.value), source: text(source.value),
    responsible_person_id: responsible.value || null, reference_date: date(reference.value), expires_on: date(expires.value), frequency: frequency.value,
    frequency_months: frequency.value === 'otra' && months.value ? Number(months.value) : null, notice_days: notice.value === '' ? 30 : Number(notice.value),
    risk: risk.value, impact: impact.value || null, blocks_operation: blocks.checked, generates_cost: cost.checked,
    next_action: text(nextAction.value), next_action_on: date(nextOn.value), description: text(description.value), notes: text(notes.value),
  });
  const changed = () => (req ? Object.fromEntries(Object.entries(values()).filter(([k, v]) => (req[k] ?? null) !== (v ?? null))) : values());
  const refresh = () => { const dirty = Object.keys(changed()).length > 0; guard.dirtyEditor = req ? dirty : name.value.trim() !== ''; sheet?.setFootHidden(req !== null && !dirty); };
  const save = el('button', { class: 'primary', type: 'submit', id: 'saveRequirement', form: 'requirementForm' }, 'Guardar') as HTMLButtonElement;
  const form = el('form', { novalidate: true, id: 'requirementForm', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
    event.preventDefault();
    error.textContent = '';
    if (!name.value.trim()) { error.textContent = 'El nombre es obligatorio.'; name.focus(); return; }
    const id = req?.id ?? crypto.randomUUID();
    const operations: RowOperation[] = req
      ? [{ op: 'update', table: T.requirements, id, expectedRevision: req.revision, fields: changed() }]
      : [{ op: 'insert', table: T.requirements, id, fields: values() }];
    const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' }, () => req ?? undefined);
    if (issue) { error.textContent = issue.message; error.scrollIntoView({ block: 'nearest' }); return; }
    save.disabled = true;
    const ok = await commitSafely(client, operations, req ? 'Obligación guardada.' : 'Obligación creada.');
    save.disabled = false;
    if (!ok) return;
    guard.dirtyEditor = false;
    await sheet?.close(true);
    if (!req) onCreated?.(id);
  } },
  el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Tipo'), type), el('label', { class: 'field' }, el('span', null, 'Estado'), status)),
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Vence'), expires), el('label', { class: 'field' }, el('span', null, 'Avisar con (días)'), notice)),
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Frecuencia'), frequency), el('label', { class: 'field' }, el('span', null, 'Fecha de referencia'), reference)),
  monthsField,
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Riesgo'), risk), el('label', { class: 'field' }, el('span', null, 'Impacto'), impact)),
  el('label', { class: 'check' }, blocks, el('span', null, 'Bloquea la operación si no se cumple')),
  el('label', { class: 'check' }, cost, el('span', null, 'Genera coste (el importe se lleva en Finance)')),
  el('label', { class: 'field' }, el('span', null, 'Responsable'), responsible),
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Organismo'), authority), el('label', { class: 'field' }, el('span', null, 'Origen'), source)),
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Siguiente acción'), nextAction), el('label', { class: 'field' }, el('span', null, 'Para el'), nextOn)),
  el('label', { class: 'field' }, el('span', null, 'Descripción'), description),
  el('label', { class: 'field' }, el('span', null, 'Notas'), notes),
  error) as HTMLFormElement;
  sheetEditor({ title: req ? 'Editar obligación' : 'Nueva obligación', meta: req?.code, existing: req !== null, form, save, focus: name, onSheet: (s) => { sheet = s; } });
}

function openDocumentEditor(client: SyncClient, doc: KeyDocument | null, data: Data | null, requirementId: string | null): void {
  let sheet: Sheet | null = null;
  let staged: Blob | null = null;
  let stagedName = '';
  const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  const input = (id: string, value: unknown, attrs: Record<string, string> = {}) => el('input', { id, type: 'text', value: value == null ? '' : String(value), ...attrs }) as HTMLInputElement;
  const name = input('d-name', doc?.name, { maxlength: '160' });
  const kind = el('select', { id: 'd-kind' }, ...options(DOCUMENT_KINDS, DOCUMENT_KIND_LABELS, doc?.document_type ?? 'poliza')) as HTMLSelectElement;
  const status = el('select', { id: 'd-status' }, ...options(KEY_DOCUMENT_STATUSES, KEY_DOCUMENT_STATUS_LABELS, doc?.status ?? 'vigente')) as HTMLSelectElement;
  const requirements = (data?.requirements ?? []).filter((r) => !r.deleted_at);
  const reqSel = el('select', { id: 'd-requirement' }, el('option', { value: '' }, 'Sin obligación'),
    ...requirements.map((r) => el('option', { value: r.id, selected: (doc?.requirement_id ?? requirementId) === r.id }, `${r.code ?? ''} ${r.name}`.trim()))) as HTMLSelectElement;
  const docDate = input('d-date', doc?.document_date, { type: 'date' });
  const expires = input('d-expires', doc?.expires_on, { type: 'date' });
  const version = input('d-version', doc?.version, { maxlength: '40' });
  const signed = el('input', { type: 'checkbox', id: 'd-signed', checked: doc?.signed === true }) as HTMLInputElement;
  const url = input('d-url', doc?.external_url, { maxlength: '500', placeholder: 'https://…' });
  const responsible = personSelect('d-responsible', data, doc?.responsible_person_id);
  const fileInput = el('input', { id: 'd-file', type: 'file', accept: FILE_MIME.join(','), class: 'visually-hidden' }) as HTMLInputElement;
  const fileState = el('span', { class: 'muted small', id: 'd-file-state' }, doc?.file_id ? 'Tiene archivo adjunto.' : 'Sin archivo.');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!FILE_MIME.includes(file.type)) { error.textContent = 'El archivo debe ser PDF o una imagen.'; return; }
    try {
      staged = file.type === 'application/pdf' ? file : (await compressImage(file, { thumbSide: 0 })).full;
      stagedName = file.type === 'application/pdf' ? file.name : file.name.replace(/\.[^.]+$/, '') + (staged.type === 'image/webp' ? '.webp' : '.jpg');
      fileState.textContent = `Nuevo archivo: ${stagedName}`;
      refresh();
    } catch { error.textContent = 'No se pudo leer ese archivo.'; }
  });
  const values = (): Record<string, unknown> => ({
    name: name.value.trim(), document_type: kind.value, status: status.value, requirement_id: reqSel.value || null, document_date: date(docDate.value),
    expires_on: date(expires.value), version: text(version.value), signed: signed.checked, external_url: text(url.value), responsible_person_id: responsible.value || null,
  });
  const changed = () => (doc ? Object.fromEntries(Object.entries(values()).filter(([k, v]) => (doc[k] ?? null) !== (v ?? null))) : values());
  const refresh = () => { const dirty = Object.keys(changed()).length > 0 || staged !== null; guard.dirtyEditor = dirty; sheet?.setFootHidden(doc !== null && !dirty); };
  const save = el('button', { class: 'primary', type: 'submit', id: 'saveDocument', form: 'documentForm' }, 'Guardar') as HTMLButtonElement;
  const form = el('form', { novalidate: true, id: 'documentForm', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
    event.preventDefault();
    error.textContent = '';
    if (!name.value.trim()) { error.textContent = 'El nombre es obligatorio.'; return; }
    const id = doc?.id ?? crypto.randomUUID();
    const build = (fileRef: unknown): RowOperation[] => {
      const fields = { ...changed(), ...(staged ? { file_id: fileRef } : {}) };
      return doc ? [{ op: 'update', table: T.keyDocuments, id, expectedRevision: doc.revision, fields }] : [{ op: 'insert', table: T.keyDocuments, id, fields }];
    };
    const issue = validateOperations(build({ $blob: 'pendiente' }), client.bootstrap()?.membership ?? { role: 'reader' }, () => doc ?? undefined);
    if (issue) { error.textContent = issue.message; error.scrollIntoView({ block: 'nearest' }); return; }
    save.disabled = true;
    try {
      const fileRef = staged ? { $blob: await client.stageBlob(staged, { filename: stagedName, mime: staged.type }) } : null;
      if (await commitSafely(client, build(fileRef), doc ? 'Documento guardado.' : 'Documento creado.')) { guard.dirtyEditor = false; await sheet?.close(true); }
    } finally { save.disabled = false; }
  } },
  el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Tipo'), kind), el('label', { class: 'field' }, el('span', null, 'Estado'), status)),
  el('label', { class: 'field' }, el('span', null, 'Obligación que respalda'), reqSel),
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Fecha'), docDate), el('label', { class: 'field' }, el('span', null, 'Caduca'), expires)),
  el('div', { class: 'fieldrow' }, el('label', { class: 'field' }, el('span', null, 'Versión'), version), el('label', { class: 'field' }, el('span', null, 'Responsable'), responsible)),
  el('label', { class: 'check' }, signed, el('span', null, 'Firmado')),
  el('div', { class: 'field' }, el('span', null, 'Archivo'), fileState,
    doc && typeof doc.file_id === 'string' ? el('button', { class: 'linkbtn', type: 'button', onclick: async () => {
      try { window.open(await client.fileUrl(doc.file_id as string), '_blank', 'noopener'); } catch (e) { toast(describeError(e)); }
    } }, icon('attach', 16), 'Abrir archivo') : null,
    canEdit ? el('label', { class: 'ghost btnlike', for: 'd-file' }, icon('upload', 18), doc?.file_id ? 'Sustituir archivo' : 'Adjuntar PDF o foto') : null, fileInput),
  el('label', { class: 'field' }, el('span', null, 'Enlace (Drive u otro)'), url),
  error,
  doc && canEdit ? el('div', { class: 'zone' }, el('button', { class: 'danger', type: 'button', id: 'deleteDocument', onclick: async () => {
    if (!(await confirmDialog({ title: '¿Enviar el documento a la papelera?', confirmLabel: 'Enviar a papelera', danger: true }))) return;
    if (await commitSafely(client, [{ op: 'delete', table: T.keyDocuments, id: doc.id, expectedRevision: doc.revision }], 'Documento enviado a la papelera.')) { guard.dirtyEditor = false; await sheet?.close(true); }
  } }, icon('trash', 18), 'Enviar a papelera')) : null) as HTMLFormElement;
  if (!canEdit) for (const f of form.querySelectorAll('input,select,textarea')) (f as HTMLInputElement).disabled = true;
  sheetEditor({ title: doc ? doc.name : 'Nuevo documento', meta: doc?.code, existing: doc !== null, form, save, focus: name, onSheet: (s) => { sheet = s; } });
}

// ---------------------------------------------------------------------------
// Ficha de una obligación
// ---------------------------------------------------------------------------
export function mountRequirement(requirementId: string): ViewMount {
  return (ctx) => {
    const { main, client, navigate } = ctx;
    const canEdit = client.bootstrap()?.membership.role !== 'reader';
    let data: Data | null = null;
    let statuses = new Map<string, TaskStatus>();
    let statusNote = '';
    const host = el('div', { id: 'requirementView' });
    replace(main, el('a', { href: '#/cumplimiento/requisitos', class: 'backlink' }, '← Obligaciones'), host);
    const kv = (k: string, v: unknown) => (v === null || v === undefined || v === '' ? null : el('div', { class: 'kv' }, el('dt', null, k), el('dd', null, String(v))));

    function paint(): void {
      const req = data?.requirements.find((r) => r.id === requirementId);
      if (!data || !req) { replace(host, el('div', { class: 'empty' }, el('strong', null, 'No se encontró la obligación'), 'Puede que se haya borrado.')); return; }
      document.title = `${req.name} · Ikisai Central`;
      const today = todayInMadrid();
      const closed = CLOSED_REQUIREMENT_STATUSES.includes(req.status);
      const docs = data.documents.filter((d) => d.requirement_id === req.id && !d.deleted_at);
      const links = data.links.filter((l) => l.requirement_id === req.id && !l.deleted_at).sort((a, b) => String(b.due_on ?? '').localeCompare(String(a.due_on ?? '')));
      const person = data.people.find((p) => p.id === req.responsible_person_id);
      const block = (title: string, id: string, body: (HTMLElement | null)[], action?: HTMLElement | null) =>
        el('section', { class: 'card personblock', id }, el('div', { class: 'blockhead' }, el('h3', null, title), action ?? null), ...body);

      const taskRow = (l: TaskLink) => {
        const s = statuses.get(l.target_id);
        const state = !s ? (navigator.onLine ? 'Consultando…' : 'Sin conexión')
          : s.deleted ? 'Borrada en Tasks' : s.pending || s.request === 'pending' ? 'En Tasks, por clasificar'
            : s.request === 'dismissed' ? 'Descartada en Tasks' : s.visible === false ? 'En Tasks (no la ves)' : s.done ? 'Hecha' : 'Abierta en Tasks';
        return el('li', { class: 'recordrow', 'data-task': l.target_id },
          el('div', null, el('strong', null, l.target_label ?? 'Tarea'), el('div', { class: 'muted small' }, [l.due_on ? `para el ${day(l.due_on)}` : '', state].filter(Boolean).join(' · '))),
          s?.done ? el('span', { class: 'chip ok' }, icon('check', 12), 'Hecha') : null);
      };

      replace(host,
        el('div', { class: 'pagehead' }, el('div', null,
          el('h2', null, req.name),
          el('p', null, [req.code, label(REQUIREMENT_TYPE_LABELS, req.requirement_type), label(REQUIREMENT_STATUS_LABELS, req.status)].filter(Boolean).join(' · ')),
          el('span', { class: 'chips' }, stateChip(req.expires_on, req.notice_days, closed, today), req.blocks_operation ? el('span', { class: 'chip alert' }, 'Bloquea la operación') : null,
            el('span', { class: 'chip' }, `Riesgo ${label(RISK_LABELS, req.risk).toLowerCase()}`)))),
        block('Obligación', 'blockRequirement', [el('dl', { class: 'kvlist' },
          kv('Vence', req.expires_on ? day(req.expires_on) : 'Sin fecha'), kv('Avisar con', `${req.notice_days} días`),
          kv('Frecuencia', req.frequency === 'otra' ? `Cada ${req.frequency_months} meses` : label(FREQUENCY_LABELS, req.frequency)),
          kv('Referencia', req.reference_date ? day(req.reference_date) : null), kv('Responsable', person?.display_name),
          kv('Organismo', req.authority), kv('Origen', req.source), kv('Impacto', req.impact ? label(IMPACT_LABELS, req.impact) : null),
          kv('Genera coste', req.generates_cost ? 'Sí (en Finance)' : null),
          kv('Siguiente acción', [req.next_action, req.next_action_on ? `para el ${day(req.next_action_on)}` : ''].filter(Boolean).join(' · ')),
          kv('Descripción', req.description), kv('Notas', req.notes))],
        canEdit ? el('button', { class: 'linkbtn', type: 'button', id: 'editRequirement', onclick: () => openRequirementEditor(client, req, data) }, icon('edit', 16), 'Editar') : null),
        canEdit && !closed ? el('div', { class: 'zone' },
          el('button', { class: 'primary', type: 'button', id: 'markDone', onclick: () => openMarkDone(req) }, icon('check', 18), 'Marcar cumplido'),
          el('button', { class: 'ghost', type: 'button', id: 'askTask', onclick: () => openAskTask(req) }, icon('tasks', 18), 'Crear tarea en Tasks')) : null,
        block('Tareas en Tasks', 'blockTasks', [links.length ? el('ul', { class: 'records', id: 'taskList' }, ...links.map(taskRow)) : el('p', { class: 'muted' }, 'Ninguna tarea pedida.'),
          statusNote ? el('p', { class: 'muted small' }, statusNote) : null]),
        block('Documentos', 'blockDocuments', [docs.length ? el('ul', { class: 'records' }, ...docs.map((d) => el('li', { class: 'recordrow' },
          el('div', null, el('strong', null, d.name), el('div', { class: 'muted small' }, [d.code, label(DOCUMENT_KIND_LABELS, d.document_type), label(KEY_DOCUMENT_STATUS_LABELS, d.status), d.expires_on ? `caduca el ${day(d.expires_on)}` : ''].filter(Boolean).join(' · '))),
          el('button', { class: 'linkbtn', type: 'button', onclick: () => openDocumentEditor(client, d, data, req.id) }, 'Abrir')))) : el('p', { class: 'muted' }, 'Sin documentos.')],
        canEdit ? el('button', { class: 'linkbtn', type: 'button', id: 'addDocument', onclick: () => openDocumentEditor(client, null, data, req.id) }, icon('plus', 16), 'Añadir') : null),
        canEdit ? el('div', { class: 'zone' }, el('button', { class: 'danger', type: 'button', id: 'deleteRequirement', onclick: () => void deleteRequirement(req, docs.length + links.length) }, icon('trash', 18), 'Enviar a papelera')) : null,
      );
    }

    async function deleteRequirement(req: Requirement, children: number): Promise<void> {
      if (children) { toast('Tiene documentos o tareas enlazadas: ciérrala (estado «Cerrado») en lugar de borrarla.'); return; }
      if (!(await confirmDialog({ title: '¿Enviar la obligación a la papelera?', confirmLabel: 'Enviar a papelera', danger: true }))) return;
      if (await commitSafely(client, [{ op: 'delete', table: T.requirements, id: req.id, expectedRevision: req.revision }], 'Obligación enviada a la papelera.')) navigate('#/cumplimiento/requisitos');
    }

    function openMarkDone(req: Requirement): void {
      let sheet: Sheet | null = null;
      const today = todayInMadrid();
      const reference = el('input', { id: 'md-reference', type: 'date', value: today }) as HTMLInputElement;
      const proposed = nextExpiry(today, req.frequency, req.frequency_months as number | null);
      const expires = el('input', { id: 'md-expires', type: 'date', value: proposed ?? '' }) as HTMLInputElement;
      reference.addEventListener('change', () => { expires.value = nextExpiry(reference.value || today, req.frequency, req.frequency_months as number | null) ?? ''; });
      const save = el('button', { class: 'primary', type: 'button', id: 'confirmDone', onclick: async () => {
        const fields = { status: 'cumplido', reference_date: reference.value || today, expires_on: expires.value || null };
        if (await commitSafely(client, [{ op: 'update', table: T.requirements, id: req.id, expectedRevision: req.revision, fields }], 'Obligación marcada como cumplida.')) await sheet?.close(true);
      } }, 'Marcar cumplido');
      sheet = openSheet({ title: 'Marcar cumplido', meta: req.name,
        body: el('div', null,
          el('label', { class: 'field' }, el('span', null, 'Cumplido el'), reference),
          el('label', { class: 'field' }, el('span', null, proposed ? `Siguiente vencimiento (${label(FREQUENCY_LABELS, req.frequency).toLowerCase()})` : 'Siguiente vencimiento (opcional)'), expires),
          el('p', { class: 'muted small' }, 'Sube antes el documento que lo acredita (póliza, certificado, acta) en «Documentos».')),
        foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), save] });
    }

    function openAskTask(req: Requirement): void {
      if (!navigator.onLine) { toast('Pedir una tarea a Tasks necesita conexión.'); return; }
      let sheet: Sheet | null = null;
      const requestId = crypto.randomUUID();
      const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
      const title = el('input', { id: 'at-title', type: 'text', maxlength: '500', value: req.expires_on ? `${req.name} (vence el ${day(req.expires_on)})` : req.name }) as HTMLInputElement;
      const due = el('input', { id: 'at-due', type: 'date', value: String(req.next_action_on ?? req.expires_on ?? '') }) as HTMLInputElement;
      const note = el('textarea', { id: 'at-note', rows: '3', maxlength: '2000' }) as HTMLTextAreaElement;
      note.value = [req.next_action as string | null, req.code ? `Obligación ${req.code} en Central.` : ''].filter(Boolean).join('\n');
      const submit = el('button', { class: 'primary', type: 'button', id: 'askTaskSubmit', onclick: async () => {
        error.textContent = '';
        submit.disabled = true;
        try {
          const out = await client.api<{ routed: string | null; created: boolean; task: TaskStatus }>(`/requirements/${req.id}/task`, { method: 'POST', json: { requestId, title: title.value.trim(), due: due.value || null, note: note.value.trim() } });
          toast(out.routed === 'pending' ? 'Tarea pedida: en Tasks queda «Por clasificar».' : out.created ? 'Tarea creada en Tasks.' : 'La tarea ya existía en Tasks.');
          await sheet?.close(true);
          await client.sync().catch(() => {});
          await load();
        } catch (e) {
          error.textContent = describeError(e);
        } finally { submit.disabled = false; }
      } }, 'Pedir a Tasks') as HTMLButtonElement;
      sheet = openSheet({ title: 'Crear tarea en Tasks', meta: req.name,
        body: el('div', null,
          el('p', { class: 'muted small' }, 'Tasks decide a qué área va según sus reglas; si no hay regla, queda «Por clasificar».'),
          el('label', { class: 'field' }, el('span', null, 'Título'), title),
          el('label', { class: 'field' }, el('span', null, 'Para el'), due),
          el('label', { class: 'field' }, el('span', null, 'Nota'), note), error),
        foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), submit], initialFocus: title });
    }

    async function loadStatuses(): Promise<void> {
      const ids = (data?.links ?? []).filter((l) => l.requirement_id === requirementId && !l.deleted_at).map((l) => l.target_id);
      if (!ids.length || !navigator.onLine) return;
      try {
        const out = await client.api<{ items: TaskStatus[]; missing: string[] }>('/requirements/tasks-status', { method: 'POST', json: { ids } });
        statuses = new Map(out.items.map((i) => [i.id, i]));
        for (const id of out.missing ?? []) statuses.set(id, { id, visible: false });
        for (const id of ids) if (!statuses.has(id)) statuses.set(id, { id, visible: false });
        statusNote = '';
      } catch (e) {
        statusNote = `No se pudo consultar Tasks: ${describeError(e)}`;
      }
      paint();
    }

    async function load(): Promise<void> {
      data = await loadAll(client);
      paint();
      // Enlaces nuevos (pedidos ahora o llegados de otro dispositivo): su estado se consulta a Tasks.
      const unknown = data.links.some((l) => l.requirement_id === requirementId && !l.deleted_at && !statuses.has(l.target_id));
      if (unknown && !statusNote) await loadStatuses();
    }
    void load();
    const offs = [T.requirements, T.keyDocuments, T.requirementTasks].map((t) => client.onTable(t, () => void load()));
    return () => offs.forEach((off) => off());
  };
}
