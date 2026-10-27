import type { SyncClient } from '@ikisai/sync-client';
import { el, replace, toast } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { busyButton } from './sheets-common.ts';
import { loadJourneyVersion, runJourney } from './journeys.ts';
import type { ViewMount } from './shell.ts';

/**
 * Editor de recorridos (flow-14, 0939; owner). `#/recorridos/nuevo` y `#/recorridos/<clave>/editar`.
 * - Nombre y una lista de tramos: capacidad del catálogo (sus campos, cada uno «preguntar / fijo / desde un tramo
 *   anterior»), registro (preguntas con tipo) o ir a otra app (app y pantalla).
 * - «Guardar borrador» escribe la versión en borrador; «Probar» la ensaya (nada se registra); «Publicar» la valida en el servidor (`publish_version`) y la deja
 *   inmutable. Editar algo publicado crea un borrador nuevo (versión siguiente) con sus tramos y pasos copiados.
 * - Todo texto que ve la persona es dato; la clave técnica del campo solo se enseña aquí.
 */
type Kind = 'capability' | 'record' | 'handoff';
type InputType = 'text' | 'number' | 'boolean' | 'choice' | 'photo';
interface EStep { key: string; title: string; explain: string; essential: boolean; mode: 'ask' | 'fixed' | 'from'; fixed: string; from: string; type: InputType; options: string }
interface EStage { kind: Kind; capability: string; title: string; explain: string; app: string; anchor: string; steps: EStep[] }
interface Capability { id: string; title: string; allowed: boolean; input?: { properties?: Record<string, any>; required?: string[] } }
type Row = Record<string, any> & { id: string; revision: number; deleted_at: string | null };

const APPS: Array<[string, string]> = [['invoices', 'Finance'], ['tasks', 'Tasks'], ['booking', 'Booking'], ['food', 'Food'], ['central', 'Central'], ['guests', 'Guests'], ['organizers', 'Organizers']];
const TYPES: Array<[InputType, string]> = [['text', 'Texto'], ['number', 'Número'], ['boolean', 'Sí / No'], ['choice', 'Opción'], ['photo', 'Foto']];
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([0-9])/, 'p_$1').slice(0, 40) || 'paso';

/** Campos de un `input` de capacidad, hasta dos niveles («supplier.name»). */
function inputFields(input: Capability['input']): Array<{ key: string; type?: string; required: boolean }> {
  const out: Array<{ key: string; type?: string; required: boolean }> = [];
  for (const [k, p] of Object.entries(input?.properties ?? {})) {
    if (k === 'requestId') continue;
    if (p?.type === 'object' && p.properties) for (const [k2, p2] of Object.entries(p.properties as Record<string, any>)) out.push({ key: `${k}.${k2}`, type: p2?.type, required: (p.required ?? []).includes(k2) });
    else out.push({ key: k, type: p?.type, required: (input?.required ?? []).includes(k) });
  }
  return out;
}

export function mountJourneyEditor(key: string | null): ViewMount {
  return ({ main, client, navigate }) => {
    if (client.bootstrap()?.membership.role !== 'owner') { replace(main, el('p', { class: 'muted' }, 'Los recorridos los edita el encargado.')); return () => undefined; }
    const host = el('div', { class: 'journey-editor', 'data-feedback-id': 'flow.recorridos.editor', 'data-feedback-label': 'Editor de recorridos' });
    replace(main, el('h1', { class: 'col-title' }, key ? 'Editar recorrido' : 'Nuevo recorrido'), host);
    let name = ''; let description = ''; let stages: EStage[] = []; let caps: Capability[] = [];
    let defId: string | null = null; let draft: Row | null = null; let published: Row | null = null; let nextVersion = 1;

    async function load(): Promise<void> {
      try { caps = (await client.api<{ items: Capability[] }>('/capabilities')).items.filter((c) => c.allowed); } catch { caps = []; }
      if (!key) { paint(); return; }
      const [defs, versions, allStages, allSteps] = (await Promise.all([client.list(TABLES.definitions), client.list(TABLES.definitionVersions),
        client.list(TABLES.definitionStages), client.list(TABLES.definitionSteps)])) as unknown as Row[][];
      const def = defs!.find((d) => d.key === key && !d.deleted_at);
      if (!def) { replace(host, el('p', { class: 'muted' }, 'Ese recorrido no existe.')); return; }
      defId = def.id; name = def.name; description = def.description ?? '';
      const mine = versions!.filter((v) => v.definition_id === def.id && !v.deleted_at).sort((a, b) => b.version - a.version);
      draft = mine.find((v) => v.status === 'draft') ?? null;
      published = mine.find((v) => v.status === 'published') ?? null;
      nextVersion = (mine[0]?.version ?? 0) + 1;
      const source = draft ?? published;
      if (source) {
        stages = allStages!.filter((s) => s.version_id === source.id && !s.deleted_at).sort((a, b) => a.position - b.position).map((s) => ({
          kind: s.kind, capability: s.capability ?? '', title: s.title, explain: s.explain ?? '', app: s.target_app ?? 'tasks', anchor: s.target_anchor ?? '',
          steps: allSteps!.filter((p) => p.stage_id === s.id && !p.deleted_at).sort((a, b) => a.position - b.position).map((p) => ({
            key: p.key, title: p.title, explain: p.explain ?? '', essential: p.essential, mode: p.mode ?? 'ask',
            fixed: p.fixed_value == null ? '' : typeof p.fixed_value === 'string' ? p.fixed_value : JSON.stringify(p.fixed_value), from: p.default_from ?? '',
            type: p.input_type ?? 'text', options: Array.isArray(p.options) ? p.options.map((o: any) => (typeof o === 'string' ? o : o.label)).join(', ') : '' })),
        }));
      }
      paint();
    }

    const input = (value: string, onInput: (v: string) => void, attrs: Record<string, string> = {}) =>
      el('input', { type: 'text', value, ...attrs, oninput: (e: Event) => onInput((e.target as HTMLInputElement).value) });
    const select = (value: string, options: Array<[string, string]>, onChange: (v: string) => void, label: string) =>
      el('select', { 'aria-label': label, onchange: (e: Event) => { onChange((e.target as HTMLSelectElement).value); paint(); } },
        ...options.map(([v, l]) => el('option', { value: v, selected: v === value }, l)));

    function stepRow(stage: EStage, si: number, step: EStep, pi: number): HTMLElement {
      const earlier = stages.slice(0, si);
      return el('div', { class: 'editor-step' },
        el('div', { class: 'editor-head' },
          el('label', null, 'Pregunta', input(step.title, (v) => { step.title = v; if (stage.kind === 'record' && !step.key) step.key = slug(v); })),
          el('small', { class: 'muted' }, `campo: ${step.key || '—'}`),
          el('label', { class: 'editor-option' }, el('input', { type: 'checkbox', checked: step.essential, onchange: (e: Event) => { step.essential = (e.target as HTMLInputElement).checked; } }), el('span', null, 'Esencial'))),
        el('label', null, 'Explicación', input(step.explain, (v) => { step.explain = v; })),
        stage.kind === 'record' ? el('div', { class: 'editor-head' },
          el('label', null, 'Tipo', select(step.type, TYPES, (v) => { step.type = v as InputType; }, 'Tipo')),
          step.type === 'choice' ? el('label', null, 'Opciones (separadas por comas)', input(step.options, (v) => { step.options = v; })) : null) : null,
        el('div', { class: 'editor-head' },
          el('label', null, 'Cómo se rellena', select(step.mode, [['ask', 'Preguntar'], ['fixed', 'Valor fijo'], ...(earlier.length ? [['from', 'Desde un tramo anterior'] as [string, string]] : [])],
            (v) => { step.mode = v as EStep['mode']; }, 'Cómo se rellena')),
          step.mode === 'fixed' ? el('label', null, 'Valor', input(step.fixed, (v) => { step.fixed = v; })) : null,
          step.mode === 'from' ? el('label', null, 'De dónde (p. ej. stages[1].result.invoice_id)', input(step.from, (v) => { step.from = v; }, { placeholder: 'stages[1].result.invoice_id' })) : null),
        stage.kind === 'record' ? el('button', { type: 'button', class: 'ghost small', onclick: () => { stage.steps.splice(pi, 1); paint(); } }, 'Quitar pregunta') : null);
    }

    function stageCard(stage: EStage, si: number): HTMLElement {
      const loadFields = () => {
        const cap = caps.find((c) => c.id === stage.capability);
        const known = new Map(stage.steps.map((s) => [s.key, s]));
        stage.steps = inputFields(cap?.input).map((f) => known.get(f.key) ?? { key: f.key, title: f.key, explain: '', essential: f.required, mode: 'ask', fixed: '', from: '', type: f.type === 'number' ? 'number' : 'text', options: '' });
        if (!stage.title && cap) stage.title = cap.title;
        paint();
      };
      return el('section', { class: 'card editor-stage' },
        el('div', { class: 'editor-head' },
          el('strong', null, `Tramo ${si + 1} · ${stage.kind === 'capability' ? 'capacidad' : stage.kind === 'record' ? 'registrar' : 'ir a otra app'}`),
          si > 0 ? el('button', { type: 'button', class: 'ghost small', onclick: () => { [stages[si - 1], stages[si]] = [stages[si]!, stages[si - 1]!]; paint(); } }, 'Subir') : null,
          el('button', { type: 'button', class: 'ghost small', onclick: () => { stages.splice(si, 1); paint(); } }, 'Quitar tramo')),
        el('label', null, 'Título del tramo', input(stage.title, (v) => { stage.title = v; })),
        el('label', null, 'Explicación', input(stage.explain, (v) => { stage.explain = v; })),
        stage.kind === 'capability' ? el('div', { class: 'editor-head' },
          el('label', null, 'Capacidad', select(stage.capability, [['', 'Elige…'], ...caps.map((c) => [c.id, c.title] as [string, string])], (v) => { stage.capability = v; }, 'Capacidad')),
          el('button', { type: 'button', class: 'secondary small', onclick: loadFields }, 'Cargar sus campos')) : null,
        stage.kind === 'handoff' ? el('div', { class: 'editor-head' },
          el('label', null, 'App', select(stage.app, APPS, (v) => { stage.app = v; }, 'App')),
          el('label', null, 'Pantalla o campo (opcional)', input(stage.anchor, (v) => { stage.anchor = v; }, { placeholder: 'tasks.compras.nueva' }))) : null,
        ...stage.steps.map((p, pi) => stepRow(stage, si, p, pi)),
        stage.kind === 'record' ? el('button', { type: 'button', class: 'secondary small', onclick: () => {
          stage.steps.push({ key: '', title: '', explain: '', essential: true, mode: 'ask', fixed: '', from: '', type: 'text', options: '' }); paint(); } }, 'Añadir pregunta') : null);
    }

    function paint(): void {
      replace(host,
        el('label', null, 'Nombre', input(name, (v) => { name = v; }, { maxlength: '80' })),
        el('label', null, 'Para qué sirve', input(description, (v) => { description = v; }, { maxlength: '300' })),
        published ? el('p', { class: 'muted small' }, draft ? 'Editas un borrador: lo publicado sigue igual hasta que publiques.' : `Al guardar se crea la versión ${nextVersion}; la publicada sigue igual hasta que publiques.`) : null,
        ...stages.map(stageCard),
        el('div', { class: 'flow-actions' },
          ...(['capability', 'record', 'handoff'] as Kind[]).map((k) => el('button', { type: 'button', class: 'secondary', onclick: () => {
            stages.push({ kind: k, capability: '', title: '', explain: '', app: 'tasks', anchor: '', steps: [] }); paint(); } },
          k === 'capability' ? 'Añadir tramo de capacidad' : k === 'record' ? 'Añadir tramo de registro' : 'Añadir «ir a otra app»'))),
        el('div', { class: 'flow-actions' },
          busyButton({ class: 'secondary' }, 'Guardar borrador', async () => { await save(); }),
          // Probar = ensayar el borrador tal como está (nada se registra fuera).
          busyButton({ class: 'secondary' }, 'Probar', async () => {
            const v = await save(); if (!v) return;
            const j = await loadJourneyVersion(client, v);
            if (!j) { toast('Guarda al menos un tramo para probarlo.'); return; }
            await runJourney(client, j, 'learn');
          }),
          busyButton({ class: 'primary' }, 'Publicar', async () => { const v = await save(); if (v) await publish(v); })));
    }

    /** Escribe el borrador (lo crea si hace falta) y devuelve su id. */
    async function save(): Promise<string | null> {
      if (!isOnline(client)) { toast('Guardar necesita conexión.'); return null; }
      if (!name.trim()) { toast('Pon un nombre.'); return null; }
      if (!stages.length) { toast('Añade al menos un tramo.'); return null; }
      const ops: any[] = [];
      if (!defId) {
        defId = crypto.randomUUID();
        ops.push({ op: 'insert', table: TABLES.definitions, id: defId, fields: { key: `${slug(name)}_${crypto.randomUUID().slice(0, 4)}`, name: name.trim(), description: description.trim() || null } });
      } else {
        const def = ((await client.list(TABLES.definitions)) as unknown as Row[]).find((d) => d.id === defId)!;
        ops.push({ op: 'update', table: TABLES.definitions, id: defId, expectedRevision: def.revision, fields: { name: name.trim(), description: description.trim() || null } });
      }
      let versionId = draft?.id ?? null;
      if (!versionId) {
        versionId = crypto.randomUUID();
        ops.push({ op: 'insert', table: TABLES.definitionVersions, id: versionId, fields: { definition_id: defId, version: nextVersion, status: 'draft' } });
      } else {
        // Se rehace el borrador: fuera sus tramos y pasos de antes.
        const [oldStages, oldSteps] = (await Promise.all([client.list(TABLES.definitionStages), client.list(TABLES.definitionSteps)])) as unknown as Row[][];
        const now = new Date().toISOString();
        for (const p of oldSteps!.filter((x) => x.version_id === versionId && !x.deleted_at)) ops.push({ op: 'update', table: TABLES.definitionSteps, id: p.id, expectedRevision: p.revision, fields: { deleted_at: now } });
        for (const s of oldStages!.filter((x) => x.version_id === versionId && !x.deleted_at)) ops.push({ op: 'update', table: TABLES.definitionStages, id: s.id, expectedRevision: s.revision, fields: { deleted_at: now } });
      }
      stages.forEach((st, si) => {
        const stageId = crypto.randomUUID();
        ops.push({ op: 'insert', table: TABLES.definitionStages, id: stageId, fields: { version_id: versionId, position: si + 1, kind: st.kind,
          capability: st.kind === 'capability' ? st.capability || null : null, title: st.title.trim() || `Tramo ${si + 1}`, explain: st.explain.trim() || null,
          target_app: st.kind === 'handoff' ? st.app : null, target_anchor: st.kind === 'handoff' ? st.anchor.trim() || null : null } });
        // «Ir a otra app» con pantalla: un paso con ese anclaje, para que la confirmación de la app destino cierre el tramo.
        if (st.kind === 'handoff' && st.anchor.trim()) {
          ops.push({ op: 'insert', table: TABLES.definitionSteps, id: crypto.randomUUID(), fields: { version_id: versionId, stage_id: stageId, position: 1,
            key: 'confirmacion', title: st.title.trim() || 'Hecho en la otra app', explain: null, essential: true, mode: 'ask', anchor: st.anchor.trim() } });
          return;
        }
        st.steps.forEach((p, pi) => {
          const fixed = p.mode === 'fixed' ? (p.type === 'number' && p.fixed !== '' && Number.isFinite(Number(p.fixed)) ? Number(p.fixed) : p.fixed) : null;
          ops.push({ op: 'insert', table: TABLES.definitionSteps, id: crypto.randomUUID(), fields: { version_id: versionId, stage_id: stageId, position: pi + 1,
            key: p.key || slug(p.title), title: p.title.trim() || p.key, explain: p.explain.trim() || null, essential: p.essential, mode: p.mode,
            fixed_value: fixed, default_from: p.mode === 'from' ? p.from.trim() : null,
            input_type: st.kind === 'record' ? p.type : null,
            options: st.kind === 'record' && p.type === 'choice' ? p.options.split(',').map((o) => o.trim()).filter(Boolean) : null } });
        });
      });
      try { await client.commit(ops); await client.sync(); }
      catch (error) { toast(describeError(error)); return null; }
      toast('Borrador guardado.');
      await load();
      return versionId;
    }

    async function publish(versionId: string): Promise<void> {
      try { await callProcedure(client, PROCEDURES.publishVersion, { version_id: versionId }); }
      catch (error) { toast(describeError(error)); return; }
      toast('Publicado.');
      await client.sync();
      navigate('#/recorridos');
    }

    void load();
    return () => undefined;
  };
}
