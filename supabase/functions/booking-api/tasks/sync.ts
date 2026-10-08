/**
 * Ikisai Booking · proyecto del retiro en Tasks y una tarea por extra contratado (B13; formato en docs/tasks/API.md §23).
 * El tick calcula qué falta (`booking.tasks_due`), llama a las rutas de worker de Tasks con la cuenta de servicio de Booking
 * y anota lo hecho. Idempotente: el proyecto por `RES<código>` (la misma llamada renombra, archiva o desarchiva) y cada extra
 * por `RES<código>-EXTRA-<línea>`. Sin datos de contacto.
 */
export type TasksPost = (path: string, body: Record<string, unknown>) => Promise<{ status: number; data: any }>;

/**
 * Base de las rutas de worker de Tasks: su Edge directa (`<supabase>/functions/v1/tasks-api/api/v1/worker`), como el
 * feedback del kit. Nunca el dominio de Pages: su proxy solo reenvía unas cabeceras y pierde `X-Ikisai-Worker-Key`
 * (Tasks respondía 401). `TASKS_WORKER_BASE_URL` queda solo como sustitución explícita (p. ej. el slug -qa).
 */
export function tasksWorkerBase(env: (name: string) => string | undefined, supabaseBase?: string): string | undefined {
  const explicit = env('TASKS_WORKER_BASE_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  const base = supabaseBase ?? env('SUPABASE_URL');
  return base ? `${base.replace(/\/$/, '')}/functions/v1/tasks-api/api/v1/worker` : undefined;
}

/** Poster real: rutas de worker de Tasks con la clave de sistema. Sin clave o sin base, no hay integración. */
export function createTasksPost(env: (name: string) => string | undefined, fetchImpl: typeof fetch = fetch, supabaseBase?: string): TasksPost | undefined {
  const key = env('IKISAI_WORKER_KEY');
  const base = tasksWorkerBase(env, supabaseBase);
  if (!key || !base) return undefined;
  return async (path, body) => {
    const res = await fetchImpl(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ikisai-worker-key': key }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

const BOOKING_URL = 'https://booking.ikisai.com';
const ref = (code: string) => `RES${code.replace(/[^A-Za-z0-9_.:-]/g, '')}`;

export async function tasksTick(deps: {
  invoke: (name: string, args: Record<string, unknown>) => Promise<any>;
  post?: TasksPost;
}): Promise<{ projects: number; extras: number; waiting: number }> {
  if (!deps.post) return { projects: 0, extras: 0, waiting: 0 };
  const due = (await deps.invoke('booking.tasks_due', {})) as {
    projects: Array<{ reservation_id: string; code: string; title: string; start_date: string; state: 'confirmed' | 'cancelled' }>;
    extras: Array<{ proposal_line_id: string; reservation_id: string; code: string; start_date: string; description: string; quantity: number | string; line_position: number | string }>;
  };
  let projects = 0; let extras = 0; let waiting = 0;
  for (const p of due.projects) {
    let res;
    try {
      res = await deps.post('requests/project', {
        source: 'booking', kind: 'booking.retreat_project', external_ref: ref(p.code), date: String(p.start_date).slice(0, 10),
        title: p.title.slice(0, 120), state: p.state, note: `Retiro ${p.code} en Booking: ${BOOKING_URL}/#/reservas/${p.reservation_id}`,
      });
    } catch { waiting++; continue; }
    const status = res.data?.status as string | undefined;
    // sin ruta (la propietaria aún no ha elegido el área) o error: se reintenta en el siguiente tick
    if (res.status >= 400 || !status || status === 'no_route') { waiting++; continue; }
    await deps.invoke('booking.tasks_project_mark', { reservation_id: p.reservation_id, project_id: res.data?.projectId ?? null,
      date: String(p.start_date).slice(0, 10), title: p.title, state: p.state, status });
    projects++;
  }
  for (const e of due.extras) {
    const qty = Number(e.quantity);
    let res;
    try {
      res = await deps.post('requests/task', {
        source: 'booking', kind: 'booking.retreat_extra', external_ref: `${ref(e.code)}-EXTRA-${e.proposal_line_id.slice(0, 8)}`, project_ref: ref(e.code),
        title: `${e.description}${qty && qty !== 1 ? ` × ${qty}` : ''}`.slice(0, 120), due: String(e.start_date).slice(0, 10),
        external_url: `${BOOKING_URL}/#/reservas/${e.reservation_id}`,
      });
    } catch { waiting++; continue; }
    // 409 PROJECT_NOT_READY: primero el proyecto; se reintenta en el siguiente tick
    if (res.status >= 400) { waiting++; continue; }
    await deps.invoke('booking.tasks_extra_mark', { proposal_line_id: e.proposal_line_id, task_id: res.data?.taskId ?? null });
    extras++;
  }
  return { projects, extras, waiting };
}
