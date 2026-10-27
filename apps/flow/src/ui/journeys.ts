import type { SyncClient } from '@ikisai/sync-client';
import { createStepForm, el, openSheet, replace, StepFormInvalid, toast, type StepQuestion } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, errorCode, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { busyButton } from './sheets-common.ts';
import type { ViewMount } from './shell.ts';

/**
 * Recorridos (0919; por tramos desde la 0939, flow-14). Un recorrido es una lista de tramos, y se hace de uno en uno:
 * - `capability`: preguntas sobre los campos del `input` de una capacidad del catálogo; en «ejecutar», al acabar el tramo
 *   se invoca con los permisos reales de la persona (flow-api → API de la app dueña, recibo en el núcleo). Si falla, el tramo
 *   queda en error y «Reintentar» repite solo ese tramo (mismo requestId `flow-<ejecución>-s<N>`).
 * - `record`: solo registra respuestas en Flow (texto, número, sí/no, opción).
 * - `handoff`: «ahora ve a <app>»: el enlace a esa app y «Hecho» cuando lo has hecho allí.
 * Lo fijo y lo que viene de un tramo anterior lo pone el servidor al empezar el tramo; aquí solo se pregunta el resto.
 * - Aprender: todas las preguntas con su explicación; nada se registra fuera (los tramos quedan practicados).
 * - Ejecutar: solo lo esencial, y de verdad.
 */
interface Definition { id: string; key: string; name: string; description: string | null; deleted_at: string | null }
interface Version { id: string; definition_id: string; version: number; status: string; capability: string | null; deleted_at: string | null }
interface Stage { id: string; version_id: string; position: number; kind: 'capability' | 'record' | 'handoff'; capability: string | null; title: string; explain: string | null;
  target_app: string | null; target_anchor: string | null; deleted_at: string | null }
interface Step { id: string; version_id: string; stage_id: string; position: number; key: string; title: string; explain: string | null; essential: boolean; anchor: string | null;
  input_type: 'text' | 'number' | 'boolean' | 'choice' | 'photo' | null; options: Array<string | { value: string; label: string }> | null; mode: 'ask' | 'fixed' | 'from'; deleted_at: string | null }
interface Capability { id: string; title: string; allowed: boolean; input?: Record<string, any> }
interface BookingEvent { event_id: string; name: string; starts_on: string }
interface Journey { def: Definition; version: Version; stages: Array<{ stage: Stage; steps: Step[] }> }

/** Un recorrido por la versión (también un borrador, para «Probar» desde el editor). */
export async function loadJourneyVersion(client: SyncClient, versionId: string): Promise<Journey | null> {
  const [defs, versions, stages, steps] = await Promise.all([client.list(TABLES.definitions), client.list(TABLES.definitionVersions),
    client.list(TABLES.definitionStages), client.list(TABLES.definitionSteps)]);
  const live = <T extends { deleted_at: string | null }>(rows: unknown[]) => (rows as T[]).filter((r) => !r.deleted_at);
  const version = live<Version>(versions).find((v) => v.id === versionId);
  const def = version ? live<Definition>(defs).find((d) => d.id === version.definition_id) : undefined;
  if (!version || !def) return null;
  const allSteps = live<Step>(steps);
  const own = live<Stage>(stages).filter((s) => s.version_id === version.id).sort((a, b) => a.position - b.position)
    .map((stage) => ({ stage, steps: allSteps.filter((s) => s.stage_id === stage.id).sort((a, b) => a.position - b.position) }));
  return own.length ? { def, version, stages: own } : null;
}

async function loadJourneys(client: SyncClient): Promise<Journey[]> {
  const [defs, versions, stages, steps] = await Promise.all([client.list(TABLES.definitions), client.list(TABLES.definitionVersions),
    client.list(TABLES.definitionStages), client.list(TABLES.definitionSteps)]);
  const live = <T extends { deleted_at: string | null }>(rows: unknown[]) => (rows as T[]).filter((r) => !r.deleted_at);
  const allSteps = live<Step>(steps);
  return live<Definition>(defs).map((def) => {
    const version = live<Version>(versions).filter((v) => v.definition_id === def.id && v.status === 'published').sort((a, b) => b.version - a.version)[0];
    if (!version) return null;
    const own = live<Stage>(stages).filter((s) => s.version_id === version.id).sort((a, b) => a.position - b.position)
      .map((stage) => ({ stage, steps: allSteps.filter((s) => s.stage_id === stage.id).sort((a, b) => a.position - b.position) }));
    return own.length ? { def, version, stages: own } : null;
  }).filter((x): x is Journey => !!x).sort((a, b) => a.def.name.localeCompare(b.def.name, 'es'));
}

export const mountJourneys: ViewMount = ({ main, client, navigate }) => {
  const list = el('div', { class: 'flows', role: 'list', 'aria-label': 'Recorridos' });
  const isOwner = client.bootstrap()?.membership.role === 'owner';
  main.append(el('h1', { class: 'col-title' }, 'Recorridos'),
    el('p', { class: 'muted small' }, '«Aprender» es un ensayo: no registra nada. «Ejecutar» lo hace de verdad, con tu cuenta.'),
    ...(isOwner ? [el('p', null, el('button', { type: 'button', class: 'secondary', onclick: () => navigate('#/recorridos/nuevo') }, 'Nuevo recorrido'))] : []), list);
  void loadJourneys(client).then((items) => {
    if (!items.length) { replace(list, el('p', { class: 'muted' }, 'Aún no hay recorridos.')); return; }
    replace(list, ...items.map((j) => el('div', { class: 'qcard journey-card', role: 'listitem', 'data-feedback-id': `flow.recorridos.${j.def.key}`, 'data-feedback-label': j.def.name },
      el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }, j.def.name),
        el('small', { class: 'qcard-sub muted' }, [j.def.description, j.stages.length > 1 ? `${j.stages.length} tramos` : ''].filter(Boolean).join(' · '))),
      el('div', { class: 'flow-actions' },
        el('button', { type: 'button', class: 'secondary', onclick: () => void runJourney(client, j, 'learn') }, 'Aprender'),
        el('button', { type: 'button', class: 'primary', onclick: () => void runJourney(client, j, 'run') }, 'Ejecutar'),
        isOwner ? el('button', { type: 'button', class: 'ghost', onclick: () => navigate(`#/recorridos/${j.def.key}/editar`) }, 'Editar') : null))));
  });
  return () => undefined;
};

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const propOf = (schema: Record<string, any> | undefined, path: string): Record<string, any> | undefined =>
  path.split('.').reduce<Record<string, any> | undefined>((s, k) => s?.properties?.[k], schema);
const getPath = (obj: Record<string, any>, path: string): unknown => path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(target: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = target;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
  o[keys.at(-1)!] = value;
}
/** La web de cada app (`invoices` es Finance). El enlace profundo con el campo señalado llegará con el inventario del núcleo. */
const appUrl = (app: string) => `https://${app === 'invoices' ? 'finance' : app}.ikisai.com/`;
const APP_NAMES: Record<string, string> = { invoices: 'Finance', tasks: 'Tasks', booking: 'Booking', food: 'Food', central: 'Central', guests: 'Guests', organizers: 'Organizers', flow: 'Flow' };
const appName = (app: string) => APP_NAMES[app] ?? app;

export async function runJourney(client: SyncClient, j: Journey, mode: 'learn' | 'run', practiceOf: string | null = null): Promise<void> {
  if (!isOnline(client)) { toast('Los recorridos necesitan conexión.'); return; }
  let caps: Capability[] = [];
  try { caps = (await client.api<{ items: Capability[] }>('/capabilities')).items; } catch { caps = []; }
  const capOf = (id: string | null) => caps.find((c) => c.id === id);
  if (mode === 'run') {
    const missing = j.stages.find(({ stage }) => stage.kind === 'capability' && !capOf(stage.capability)?.allowed);
    if (missing) { toast(`Tu cuenta no puede hacer «${missing.stage.title}» en ${appName((missing.stage.capability ?? '').split('.')[0]!)}: pide acceso a Dirección.`); return; }
  }
  let events: BookingEvent[] = [];
  if (j.stages.some(({ steps }) => steps.some((s) => s.key === 'target'))) {
    try { events = ((await client.api<{ rows: BookingEvent[] }>('/read/booking.event_projection?limit=200')).rows ?? []).sort((a, b) => a.starts_on.localeCompare(b.starts_on)); } catch { events = []; }
  }
  const executionId = crypto.randomUUID();
  try { await callProcedure(client, PROCEDURES.startExecution, { execution_id: executionId, version_id: j.version.id, mode, ...(practiceOf ? { practice_of: practiceOf } : {}) }); }
  catch (error) { toast(describeError(error)); return; }

  const host = el('div', { class: 'journey' });
  const progress = el('p', { class: 'muted small journey-progress', role: 'status' });
  const sheet = openSheet({ title: `${j.def.name} · ${mode === 'learn' ? 'aprender' : 'ejecutar'}`,
    meta: mode === 'learn' ? 'Ensayo: no se registra nada.' : 'Se registrará de verdad, con tu cuenta.', body: el('div', null, progress, host) });

  async function startStage(index: number): Promise<void> {
    const entry = j.stages[index];
    if (!entry) {
      if (mode === 'run' || j.version.status !== 'published') { toast(mode === 'learn' ? 'Ensayo terminado.' : 'Recorrido terminado.'); sheet.close(); return; }
      // Tras un ensayo: hacerlo de verdad, con lo ya respondido como punto de partida (D2: ejecución real enlazada a la práctica).
      replace(progress, 'Ensayo terminado');
      replace(host, el('div', { class: 'journey-done' },
        el('p', null, 'No se ha registrado nada. ¿Lo haces ahora de verdad? Empezarás con lo que has respondido y podrás corregirlo.'),
        el('div', { class: 'flow-actions' },
          el('button', { type: 'button', class: 'ghost', onclick: () => sheet.close() }, 'Ahora no'),
          busyButton({ class: 'primary' }, 'Hacerlo de verdad', async () => { sheet.close(); await runJourney(client, j, 'run', executionId); }))));
      return;
    }
    const { stage } = entry;
    replace(progress, j.stages.length > 1 ? `Tramo ${index + 1} de ${j.stages.length} · ${stage.title}` : stage.title);
    let prefilled: Record<string, any> = {};
    try { prefilled = (await callProcedure<{ values: Record<string, any> }>(client, PROCEDURES.startStage, { execution_id: executionId, position: stage.position })).values ?? {}; }
    catch (error) { toast(describeError(error)); return; }
    if (stage.kind === 'handoff') { showHandoff(index); return; }
    showQuestions(index, prefilled);
  }

  function showHandoff(index: number): void {
    const { stage } = j.stages[index]!;
    const app = stage.target_app ?? 'flow';
    const back = encodeURIComponent(location.href);
    // `guia`: la ejecución, para que el Guiado del kit en la otra app lea sus pasos (`flow.guide_read`) y confirme.
    const url = `${appUrl(app)}?desde=flow&volver=${back}&titulo=Flow&guia=${executionId}${stage.target_anchor ? `&campo=${encodeURIComponent(stage.target_anchor)}` : ''}`;
    replace(host, el('div', { class: 'journey-handoff', 'data-feedback-id': `flow.recorrido.${j.def.key}.tramo${stage.position}` },
      el('h3', null, stage.title),
      stage.explain ? el('p', null, stage.explain) : null,
      el('p', null, el('a', { class: 'button primary', href: url, target: '_blank', rel: 'noopener' }, `Ir a ${appName(app)} ↗`)),
      el('p', { class: 'muted small' }, mode === 'learn' ? 'En el ensayo no hace falta ir: toca «Siguiente».' : 'Cuando lo hayas hecho allí, vuelve y toca «Hecho».'),
      el('div', { class: 'flow-actions' },
        busyButton({ class: 'ghost' }, 'Descartar', () => discard()),
        busyButton({ class: 'primary' }, mode === 'learn' ? 'Siguiente' : 'Hecho', async () => { await finishStage(index, mode === 'learn' ? 'practiced' : 'done'); }))));
  }

  function showQuestions(index: number, prefilled: Record<string, any>): void {
    const { stage, steps: all } = j.stages[index]!;
    const cap = capOf(stage.capability);
    const asked = all.filter((s) => s.mode === 'ask' && (mode === 'learn' || s.essential));
    const values: Record<string, any> = JSON.parse(JSON.stringify(prefilled));
    if (asked.some((s) => s.key === 'date') && getPath(values, 'date') == null) setPath(values, 'date', today());
    const toQuestion = (s: Step): StepQuestion => {
      const hint = mode === 'learn' ? [s.explain, s.anchor ? 'En la app dueña está en la pantalla señalada.' : ''].filter(Boolean).join(' ') : undefined;
      const current = getPath(values, s.key);
      const base = { id: s.key, question: s.title, hint, value: current == null || typeof current === 'object' ? null : String(current), field: { id: `flow.recorrido.${j.def.key}.${s.key.replace(/\./g, '_')}` } };
      if (s.key === 'target') return { ...base, kind: 'choice', options: [...events.map((e) => ({ value: JSON.stringify({ app: 'booking', kind: 'event', id: e.event_id }), label: e.name })),
        { value: JSON.stringify({ app: 'general', kind: 'unassigned' }), label: 'Gasto general (sin evento)' }] };
      if (s.key === 'vat_rate') return { ...base, kind: 'choice', options: [...['21', '10', '5', '4', '0'].map((v) => ({ value: v, label: `${v} %` })), { value: '', label: 'No lo sé' }] };
      if (s.input_type === 'boolean') return { ...base, kind: 'choice', options: [{ value: 'true', label: 'Sí' }, { value: 'false', label: 'No' }] };
      if (s.input_type === 'choice') return { ...base, kind: 'choice', options: (s.options ?? []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o)) };
      if (s.input_type === 'photo') return { ...base, kind: 'text', hint: [hint, 'De momento, descríbela: adjuntar la foto llegará pronto.'].filter(Boolean).join(' ') };
      const type = s.input_type ?? propOf(cap?.input, s.key)?.type;
      return { ...base, kind: 'text', inputType: s.key === 'date' ? 'date' : type === 'number' ? 'number' : 'text' };
    };
    const typed = (s: Step, v: string): unknown => {
      if (s.key === 'target') return JSON.parse(v);
      if (s.input_type === 'boolean') return v === 'true';
      const type = s.input_type ?? propOf(cap?.input, s.key)?.type;
      if (type === 'number' || s.key === 'total' || s.key === 'vat_rate') return v === '' ? null : Number(v.replace(',', '.'));
      return v;
    };

    const review = el('div', { class: 'journey-review', hidden: true });
    const form = createStepForm({
      label: stage.title, questions: asked.map(toQuestion), feedbackId: `flow.recorrido.${j.def.key}`,
      answered: () => false,
      onAnswer: async (q, value) => {
        const s = asked.find((x) => x.key === q.id)!;
        const v = Array.isArray(value) ? value.join(',') : value;
        if (q.id === 'total' && !(Number(v.replace(',', '.')) > 0)) throw new StepFormInvalid('Pon un importe mayor que cero.');
        if (s.input_type === 'number' && v !== '' && !Number.isFinite(Number(v.replace(',', '.')))) throw new StepFormInvalid('Pon un número.');
        const typedValue = typed(s, v);
        setPath(values, q.id, typedValue);
        await callProcedure(client, PROCEDURES.saveStageValues, { execution_id: executionId, position: stage.position, values: { [q.id]: typedValue } });
      },
      onDone: () => showReview(),
    });
    replace(host, form.element, review);
    if (!asked.length) { form.element.hidden = true; showReview(); }

    function label(s: Step): string {
      const v = getPath(values, s.key);
      if (s.key === 'target' && v && typeof v === 'object') { const t = v as { app: string; id?: string }; return t.app === 'booking' ? (events.find((e) => e.event_id === t.id)?.name ?? 'Evento') : 'Gasto general'; }
      if (typeof v === 'boolean') return v ? 'Sí' : 'No';
      return v == null || v === '' ? '—' : String(v);
    }

    function showReview(): void {
      review.hidden = false;
      const shown = all.filter((s) => s.mode !== 'ask' || asked.includes(s));
      const last = index === j.stages.length - 1;
      const go = async () => {
        if (mode === 'learn') await finishStage(index, 'practiced');
        else if (stage.kind === 'capability') await register(index, values);
        else await finishStage(index, 'done');
      };
      replace(review, el('h3', null, 'Revisión'),
        el('dl', { class: 'journey-values' }, ...shown.flatMap((s) => [el('dt', null, s.title), el('dd', null, label(s),
          s.mode === 'ask' ? el('button', { type: 'button', class: 'ghost small', onclick: () => { review.hidden = true; form.element.hidden = false; form.goTo(s.key); } }, 'Corregir')
            : el('small', { class: 'muted' }, s.mode === 'fixed' ? ' (fijo)' : ' (del tramo anterior)'))])),
        el('div', { class: 'flow-actions' },
          busyButton({ class: 'ghost' }, 'Descartar', () => discard()),
          busyButton({ class: 'primary' }, mode === 'learn' ? (last ? 'Terminar el ensayo' : 'Siguiente tramo')
            : stage.kind === 'capability' ? 'Registrar' : (last ? 'Terminar' : 'Siguiente tramo'), go)));
    }
  }

  async function finishStage(index: number, status: 'done' | 'error' | 'practiced', extra: Record<string, unknown> = {}): Promise<boolean> {
    const { stage } = j.stages[index]!;
    try { await callProcedure(client, PROCEDURES.finishStage, { execution_id: executionId, position: stage.position, status, ...extra }); }
    catch (error) { toast(describeError(error)); return false; }
    if (status !== 'error') await startStage(index + 1);
    return true;
  }

  async function register(index: number, values: Record<string, any>): Promise<void> {
    const { stage } = j.stages[index]!;
    const body = { ...values, requestId: `flow-${executionId}-s${stage.position}` };
    try {
      const out = await client.api<{ result: { summary?: string; [k: string]: unknown } }>(`/capabilities/${stage.capability}/invoke`, { method: 'POST', json: body });
      toast(out.result?.summary ? `Registrado: ${out.result.summary}` : 'Registrado.');
      await finishStage(index, 'done', { result: out.result ?? null });
    } catch (error) {
      toast(describeError(error));
      if (errorCode(error) === 'OFFLINE') return;
      if (!(await finishStage(index, 'error', { error: { code: errorCode(error) } }))) return;
      // El tramo queda en error: «Reintentar» lo vuelve a abrir con lo ya respondido (mismo requestId: no se duplica).
      replace(host, el('div', { class: 'journey-retry' },
        el('p', null, `«${stage.title}» no se ha podido registrar: ${describeError(error)}`),
        el('div', { class: 'flow-actions' },
          busyButton({ class: 'ghost' }, 'Descartar', () => discard()),
          busyButton({ class: 'primary' }, 'Reintentar', () => startStage(index)))));
    }
  }

  async function discard(): Promise<void> {
    try { await callProcedure(client, PROCEDURES.finishExecution, { execution_id: executionId, status: 'discarded' }); }
    catch (error) { toast(describeError(error)); return; }
    toast('Descartado.');
    sheet.close();
  }

  await startStage(0);
}
