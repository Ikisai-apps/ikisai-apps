/**
 * Histéresis de las métricas que la piden (`value.hysteresis`, pan v2, 0913): la cifra mostrada solo cambia si se mueve al
 * menos eso, o si quedaría por debajo de lo firme (`value.firm`). Así no baila con cada pedido; lo demás se ve tal cual.
 */
export interface MetricReading { unit_id: string; metric: string; value: { target: number } & Record<string, unknown> }

export function steadyMetrics<T extends MetricReading>(shown: Map<string, T>, next: Map<string, T>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [id, m] of next) {
    const h = Number(m.value.hysteresis);
    const prev = shown.get(id);
    if (!prev || !(h > 0)) { out.set(id, m); continue; }
    const firm = Number(m.value.firm ?? 0);
    const keep = Math.abs(m.value.target - prev.value.target) < h && prev.value.target >= firm;
    out.set(id, keep ? { ...m, value: { ...m.value, target: prev.value.target } } : m);
  }
  return out;
}
