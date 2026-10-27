import type { SyncClient } from '@ikisai/sync-client';
import { createStepForm, el, openSheet, replace, StepFormInvalid, toast, type StepQuestion } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, errorCode, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { busyButton } from './sheets-common.ts';
import type { ViewMount } from './shell.ts';

/**
 * Recorridos (0919; visión V0.2). Cada recorrido invoca una capacidad del catálogo del núcleo con los permisos reales de
 * la persona; sus pasos son preguntas sobre los campos de entrada de esa capacidad.
 * - Aprender: todas las preguntas con su explicación, en borrador; al final, revisión con Registrar · Corregir · Descartar.
 *   «Registrar» en aprender NO escribe nada fuera: queda practicado.
 * - Ejecutar: solo lo esencial; «Registrar» invoca la capacidad (flow-api → API de la app dueña con el token de la persona,
 *   recibo en el núcleo) y anota el resultado.
 * La guía solo señala anclajes de pantalla; nunca finge un borrador sobre una pantalla que guarda sola.
 */
interface Definition { id: string; key: string; name: string; description: string | null; deleted_at: string | null }
interface Version { id: string; definition_id: string; version: number; status: string; capability: string; deleted_at: string | null }
interface Step { id: string; version_id: string; position: number; key: string; title: string; explain: string | null; essential: boolean; anchor: string | null; deleted_at: string | null }
interface Capability { id: string; title: string; allowed: boolean; input?: Record<string, any> }
interface BookingEvent { event_id: string; name: string; starts_on: string }

async function loadJourneys(client: SyncClient): Promise<Array<{ def: Definition; version: Version; steps: Step[] }>> {
  const [defs, versions, steps] = await Promise.all([client.list(TABLES.definitions), client.list(TABLES.definitionVersions), client.list(TABLES.definitionSteps)]);
  const live = <T extends { deleted_at: string | null }>(rows: unknown[]) => (rows as T[]).filter((r) => !r.deleted_at);
  return live<Definition>(defs).map((def) => {
    const version = live<Version>(versions).filter((v) => v.definition_id === def.id && v.status === 'published').sort((a, b) => b.version - a.version)[0];
    return version ? { def, version, steps: live<Step>(steps).filter((s) => s.version_id === version.id).sort((a, b) => a.position - b.position) } : null;
  }).filter((x): x is { def: Definition; version: Version; steps: Step[] } => !!x).sort((a, b) => a.def.name.localeCompare(b.def.name, 'es'));
}

export const mountJourneys: ViewMount = ({ main, client }) => {
  const list = el('div', { class: 'flows', role: 'list', 'aria-label': 'Recorridos' });
  main.append(el('h1', { class: 'col-title' }, 'Recorridos'),
    el('p', { class: 'muted small' }, '«Aprender» es un ensayo: no registra nada. «Ejecutar» lo hace de verdad, con tu cuenta.'), list);
  void loadJourneys(client).then((items) => {
    if (!items.length) { replace(list, el('p', { class: 'muted' }, 'Aún no hay recorridos.')); return; }
    replace(list, ...items.map((j) => el('div', { class: 'qcard journey-card', role: 'listitem', 'data-feedback-id': `flow.recorridos.${j.def.key}`, 'data-feedback-label': j.def.name },
      el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }, j.def.name), el('small', { class: 'qcard-sub muted' }, j.def.description ?? '')),
      el('div', { class: 'flow-actions' },
        el('button', { type: 'button', class: 'secondary', onclick: () => void runJourney(client, j, 'learn') }, 'Aprender'),
        el('button', { type: 'button', class: 'primary', onclick: () => void runJourney(client, j, 'run') }, 'Ejecutar')))));
  });
  return () => undefined;
};

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const propOf = (schema: Record<string, any> | undefined, path: string): Record<string, any> | undefined =>
  path.split('.').reduce<Record<string, any> | undefined>((s, k) => s?.properties?.[k], schema);
function setPath(target: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = target;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {});
  o[keys.at(-1)!] = value;
}

async function runJourney(client: SyncClient, j: { def: Definition; version: Version; steps: Step[] }, mode: 'learn' | 'run'): Promise<void> {
  if (!isOnline(client)) { toast('Los recorridos necesitan conexión.'); return; }
  let cap: Capability | undefined;
  try { cap = (await client.api<{ items: Capability[] }>('/capabilities')).items.find((c) => c.id === j.version.capability); } catch { cap = undefined; }
  if (mode === 'run' && !cap?.allowed) { toast(`Tu cuenta no puede hacer esto en ${j.version.capability.split('.')[0]}: pide acceso a Dirección.`); return; }
  let events: BookingEvent[] = [];
  if (j.steps.some((s) => s.key === 'target')) {
    try { events = ((await client.api<{ rows: BookingEvent[] }>('/read/booking.event_projection?limit=200')).rows ?? []).sort((a, b) => a.starts_on.localeCompare(b.starts_on)); } catch { events = []; }
  }
  const executionId = crypto.randomUUID();
  try { await callProcedure(client, PROCEDURES.startExecution, { execution_id: executionId, version_id: j.version.id, mode }); }
  catch (error) { toast(describeError(error)); return; }

  const steps = mode === 'run' ? j.steps.filter((s) => s.essential) : j.steps;
  const values: Record<string, string> = { ...(steps.some((s) => s.key === 'date') ? { date: today() } : {}) };
  const toQuestion = (s: Step): StepQuestion => {
    const hint = mode === 'learn' ? [s.explain, s.anchor ? 'En la app dueña está en la pantalla señalada.' : ''].filter(Boolean).join(' ') : undefined;
    const base = { id: s.key, question: s.title, hint, value: values[s.key] ?? null, field: { id: `flow.recorrido.${j.def.key}.${s.key.replace(/\./g, '_')}` } };
    if (s.key === 'target') return { ...base, kind: 'choice', options: [...events.map((e) => ({ value: JSON.stringify({ app: 'booking', kind: 'event', id: e.event_id }), label: e.name })),
      { value: JSON.stringify({ app: 'general', kind: 'unassigned' }), label: 'Gasto general (sin evento)' }] };
    if (s.key === 'vat_rate') return { ...base, kind: 'choice', options: [...['21', '10', '5', '4', '0'].map((v) => ({ value: v, label: `${v} %` })), { value: '', label: 'No lo sé' }] };
    const type = propOf(cap?.input, s.key)?.type;
    return { ...base, kind: 'text', inputType: s.key === 'date' ? 'date' : type === 'number' ? 'number' : 'text' };
  };

  const review = el('div', { class: 'journey-review', hidden: true });
  const host = el('div', { class: 'journey' });
  const sheet = openSheet({ title: `${j.def.name} · ${mode === 'learn' ? 'aprender' : 'ejecutar'}`, meta: mode === 'learn' ? 'Ensayo: no se registra nada.' : 'Se registrará de verdad, con tu cuenta.', body: el('div', null, host, review) });

  let form = createStepForm({
    label: j.def.name, questions: steps.map(toQuestion), feedbackId: `flow.recorrido.${j.def.key}`,
    answered: () => false,
    onAnswer: async (q, value) => {
      const v = Array.isArray(value) ? value.join(',') : value;
      if (q.id === 'total' && !(Number(v.replace(',', '.')) > 0)) throw new StepFormInvalid('Pon un importe mayor que cero.');
      values[q.id] = q.id === 'total' ? v.replace(',', '.') : v;
      await callProcedure(client, PROCEDURES.saveExecutionValues, { execution_id: executionId, values: { [q.id]: values[q.id] } });
    },
    onDone: () => showReview(),
  });
  host.append(form.element);

  function body(): Record<string, unknown> {
    const out: Record<string, unknown> = { requestId: `flow-${executionId}` };
    for (const s of j.steps) {
      const raw = values[s.key];
      if (raw == null || raw === '') continue;
      const type = propOf(cap?.input, s.key)?.type;
      const value = s.key === 'target' ? JSON.parse(raw) : (type === 'number' || s.key === 'total' || s.key === 'vat_rate') ? Number(raw) : raw;
      setPath(out, s.key, value);
    }
    return out;
  }

  function showReview(): void {
    review.hidden = false;
    const label = (s: Step) => {
      const raw = values[s.key];
      if (s.key === 'target' && raw) { const t = JSON.parse(raw); return t.app === 'booking' ? (events.find((e) => e.event_id === t.id)?.name ?? 'Evento') : 'Gasto general'; }
      return raw || '—';
    };
    replace(review, el('h3', null, 'Revisión'),
      el('dl', { class: 'journey-values' }, ...steps.flatMap((s) => [el('dt', null, s.title), el('dd', null, label(s),
        el('button', { type: 'button', class: 'ghost small', onclick: () => { review.hidden = true; form.goTo(s.key); } }, 'Corregir'))])),
      el('div', { class: 'flow-actions' },
        busyButton({ class: 'ghost' }, 'Descartar', () => finish('discarded')),
        busyButton({ class: 'primary' }, 'Registrar', () => (mode === 'learn' ? finish('practiced') : register()))));
  }

  async function finish(status: 'practiced' | 'discarded' | 'done' | 'error', result?: unknown): Promise<void> {
    try { await callProcedure(client, PROCEDURES.finishExecution, { execution_id: executionId, status, ...(result !== undefined ? { result } : {}) }); }
    catch (error) { toast(describeError(error)); return; }
    if (status === 'practiced') toast('Practicado. En «Ejecutar» se registraría de verdad.');
    if (status === 'discarded') toast('Descartado.');
    sheet.close();
  }

  async function register(): Promise<void> {
    try {
      const out = await client.api<{ result: { summary?: string; invoice_id?: string; replayed?: boolean } }>(`/capabilities/${j.version.capability}/invoke`, { method: 'POST', json: body() });
      toast(out.result?.summary ? `Registrado: ${out.result.summary}` : 'Registrado.');
      await finish('done', { invoice_id: out.result?.invoice_id ?? null, summary: out.result?.summary ?? null, replayed: out.result?.replayed ?? false });
    } catch (error) {
      toast(describeError(error));
      if (errorCode(error) !== 'OFFLINE') await finish('error', { code: errorCode(error) });
    }
  }
}
