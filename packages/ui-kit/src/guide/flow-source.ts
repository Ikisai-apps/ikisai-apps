/**
 * Guiado, tanda 3: la ejecución se lee de Flow. Contrato acordado con Core el 27-10; lo implementa Flow, y aquí se ajusta en
 * un solo sitio si cambia. Son dos capacidades del catálogo del núcleo que cada app invoca con su propia Edge y con el
 * token de la persona (`POST capabilities/<id>/invoke`, con recibo):
 * - `flow.guide_read` `{ execution_id, app }` → `{ id, title, mode, steps: [{ id, title, explain, anchor, route, confirm,
 *   done, essential }] }`. Solo los pasos de esa app, y solo para quien hace la ejecución. `done` lo calcula Flow reconsultando
 *   al sistema dueño.
 * - `flow.guide_confirm` `{ requestId, execution_id, step_id, how, pending }` → `{ ok }`. Es idempotente por `requestId`.
 *   **Nunca lleva valores de campo**: `save` sale del aviso de guardado de `createSaveState` (0.66), no de leer el campo.
 * Lo que llega se valida: ids e anclajes con su formato, rutas solo internas (`#/…` o `/…`) y textos acotados.
 */
import { ANCHOR_ID } from './anchors.ts';
import type { GuideConfirm, GuideRun, GuideStep } from './guide.ts';

/** Lo que hace falta del cliente de sincronización (`SyncClient.api`). */
export interface GuideApiClient {
  api<T = unknown>(path: string, init?: { method?: string; json?: unknown }): Promise<T>;
}

export interface GuideSource {
  load(run: string): Promise<GuideRun>;
  confirm(run: string, step: GuideStep, info: { how: GuideConfirm; pending: boolean }): Promise<unknown>;
  /** Un paso no esencial se saltó: se confirma como `skip`. */
  skip?(run: string, step: GuideStep): Promise<unknown>;
}

const CONFIRMS = new Set<GuideConfirm>(['save', 'event', 'manual', 'none']);
const STEP_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Ruta interna de la app: `#/…` o `/…` (nunca `//otro.sitio`, ni `javascript:`). */
export function safeRoute(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const r = v.trim();
  return /^#\/[^\s]*$/.test(r) || /^\/(?!\/)[^\s]*$/.test(r) ? r.slice(0, 300) : null;
}

/** Valida lo que devuelve `flow.guide_read`; lanza si no es una ejecución. */
export function sanitizeGuideRun(raw: unknown): GuideRun {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.steps)) throw new Error('guide_read: sin pasos');
  const seen = new Set<string>();
  const steps: GuideStep[] = [];
  for (const s of r.steps.slice(0, 60) as Record<string, unknown>[]) {
    if (!s || typeof s.id !== 'string' || !STEP_ID.test(s.id) || seen.has(s.id)) continue;
    const title = text(s.title, 140);
    if (!title) continue;
    seen.add(s.id);
    const anchor = typeof s.anchor === 'string' && ANCHOR_ID.test(s.anchor) ? s.anchor : null;
    steps.push({
      id: s.id, title, explain: text(s.explain, 600), anchor, route: safeRoute(s.route),
      confirm: CONFIRMS.has(s.confirm as GuideConfirm) ? s.confirm as GuideConfirm : undefined,
      done: s.done === true, essential: s.essential !== false,
    });
  }
  return { id: typeof r.id === 'string' ? r.id.slice(0, 64) : '', title: text(r.title, 140) ?? '', mode: r.mode === 'learn' ? 'learn' : 'run', steps };
}

/** Fuente de la guía con las capacidades de Flow, a través del cliente de la app. */
export function flowGuideSource(client: GuideApiClient, options: { app: string | null }): GuideSource {
  const invoke = <T>(id: string, json: Record<string, unknown>) => client.api<{ result: T }>(`/capabilities/${id}/invoke`, { method: 'POST', json }).then((o) => o.result);
  const confirm = (run: string, step: GuideStep, how: GuideConfirm | 'skip', pending: boolean) =>
    invoke('flow.guide_confirm', { requestId: `guide:${run}:${step.id}:${how}`, execution_id: run, step_id: step.id, how, pending });
  return {
    load: async (run) => sanitizeGuideRun(await invoke('flow.guide_read', { execution_id: run, app: options.app })),
    confirm: (run, step, info) => confirm(run, step, info.how, info.pending),
    skip: (run, step) => confirm(run, step, 'skip', false),
  };
}
