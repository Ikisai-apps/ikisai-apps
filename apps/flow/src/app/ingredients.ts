import type { SyncClient } from '@ikisai/sync-client';
import { PROCEDURES } from '@ikisai/domain-flow';
import { callProcedure, errorCode } from './actions.ts';
import { loadProjects } from './data.ts';

/**
 * «Generar tareas de ingredientes» (owner; encargo de VG del 27-10, diseño aprobado por Core). Lee la previsión de Food
 * con la sesión de Flow (`food.carta_prep_totals_projection`: por ingrediente, cantidades a mesa y a nevera;
 * `food.carta_prep_projection`: lo que lleva cada línea de la carta) y se la pasa a `flow.generate_ingredient_tasks`, que
 * crea los puntos de existencias, las propuestas y las reglas de consumo. Idempotente por día.
 * Si Food aún no la publica, se dice («Falta la previsión en Food») y no falla.
 */
interface PrepTotal { component_key: string; name: string; unit: string; mesa: number | null; nevera: number | null; convertible: boolean }
interface PrepLine { line_id: string; component_key: string; name: string; unit: string; per_unit: number | null; convertible: boolean }

const madridToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

async function readView<T>(client: SyncClient, name: string, menuId: string): Promise<T[] | null> {
  try {
    const out = await client.api<{ rows: T[] }>(`/read/${name}?where[menu_id]=${encodeURIComponent(menuId)}&limit=2000`);
    return out.rows ?? [];
  } catch (error) {
    // Vista aún no publicada o no abierta a Flow.
    if (['INVALID_OPERATION', 'FORBIDDEN'].includes(errorCode(error))) return null;
    throw error;
  }
}

export async function generateIngredientTasks(client: SyncClient, projectId: string): Promise<{ message: string }> {
  const project = (await loadProjects(client)).find((p) => p.id === projectId);
  if (!project?.food_menu_id) return { message: 'Este flujo no está ligado a una carta de Food: actualiza la carta desde Food en Caja.' };
  const totals = await readView<PrepTotal>(client, 'food.carta_prep_totals_projection', project.food_menu_id);
  const lines = await readView<PrepLine>(client, 'food.carta_prep_projection', project.food_menu_id);
  if (totals === null || lines === null) return { message: 'Falta la previsión en Food: no se ha generado nada.' };
  if (!totals.length) return { message: 'La carta de Food no tiene previsión de ingredientes.' };
  const out = await callProcedure<{ created: number; updated: number; rules: number; skipped: Array<{ name: string }> }>(client, PROCEDURES.generateIngredientTasks, {
    project_id: projectId, day: madridToday(),
    totals: totals.map((t) => ({ component_key: t.component_key, name: t.name, unit: t.unit, mesa: t.mesa, nevera: t.nevera, convertible: t.convertible })),
    rules: lines.map((l) => ({ line_id: l.line_id, component_key: l.component_key, name: l.name, unit: l.unit, per_unit: l.per_unit, convertible: l.convertible })),
  });
  const skipped = out.skipped.length ? ` Sin cantidad (revisar en Food): ${out.skipped.map((s) => s.name).join(', ')}.` : '';
  return { message: `${out.created} propuestas nuevas, ${out.updated} actualizadas, ${out.rules} reglas de consumo.${skipped}` };
}
