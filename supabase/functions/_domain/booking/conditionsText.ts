/**
 * Ikisai Booking · marcadores del «Texto de las condiciones» (decisión del usuario, 8-10-2026): el texto no repite las
 * cifras de los campos, las nombra y se resuelven al pintar (documento de la propuesta, ficha y portal).
 *
 * `{{condiciones.<marcador>}}` pone el valor; `{{#condiciones.<marcador>}}…{{/condiciones.<marcador>}}` es un bloque que
 * desaparece si el campo está vacío (null, '' o 0), como en los textos de Central. Sin espacios dentro de las llaves. Un marcador desconocido se deja tal
 * cual y se devuelve en `unknown`. Nunca hay marcador para el plazo interno del saldo.
 * La misma resolución, en español, la hace `booking.conditions_text` en SQL para el portal (migración 0462).
 */

export type ConditionsLang = 'es' | 'en';

export type ConditionsTier = Record<string, unknown>;

export const CONDITIONS_MARKERS = [
  ['condiciones.senal_porcentaje', 'Señal (% del total)'],
  ['condiciones.senal_minima', 'Señal mínima (€)'],
  ['condiciones.senal_plazo', 'Plazo para pagar la señal (días)'],
  ['condiciones.senal_plazo_corto', 'Plazo con poca antelación (días)'],
  ['condiciones.poca_antelacion', 'Poca antelación: faltan menos de (días)'],
  ['condiciones.iva', 'Tipo de IVA (%)'],
  ['condiciones.minimo', 'Mínimo por retiro (€)'],
  ['condiciones.cancelacion', 'Lista de los tramos de cancelación'],
] as const;

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** 2500 → «2.500»; 2500.5 → «2.500,50» (en: «2,500.50»). Sin decimales si son cero. */
function formatNumber(n: number, lang: ConditionsLang, money: boolean): string {
  const [sep, dec] = lang === 'en' ? [',', '.'] : ['.', ','];
  const neg = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const cents = Math.round(abs * 100) % 100;
  const whole = Math.floor(Math.round(abs * 100) / 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  if (money) return `${neg}${grouped}${cents ? `${dec}${String(cents).padStart(2, '0')}` : ''}`;
  const frac = Math.round(abs * 100) / 100 - whole;
  return `${neg}${grouped}${frac ? `${dec}${String(Math.round(frac * 100)).padStart(2, '0').replace(/0$/, '')}` : ''}`;
}

const pct = (n: number, lang: ConditionsLang) => (lang === 'en' ? `${formatNumber(n, lang, false)}%` : `${formatNumber(n, lang, false)} %`);
const eur = (n: number, lang: ConditionsLang) => (lang === 'en' ? `€${formatNumber(n, lang, true)}` : `${formatNumber(n, lang, true)} €`);
const days = (n: number, lang: ConditionsLang) => (lang === 'en' ? `${n} ${n === 1 ? 'day' : 'days'}` : `${n} ${n === 1 ? 'día' : 'días'}`);

/** Frases de los tramos, de mayor a menor antelación. El último con 0 días se dice «con menos de» el anterior. */
export function cancellationLines(tiers: readonly ConditionsTier[], lang: ConditionsLang = 'es'): string[] {
  const sorted = [...tiers].map((t) => ({ min: Number(t.min_days_before), refund: num(t.deposit_refund_pct) ?? 0, extra: t.extra_costs === true }))
    .filter((t) => Number.isFinite(t.min)).sort((a, b) => b.min - a.min);
  return sorted.map((t, i) => {
    const prev = sorted[i - 1];
    const when = t.min > 0
      ? (lang === 'en' ? `With ${days(t.min, lang)} or more notice` : `Con ${days(t.min, lang)} o más de antelación`)
      : prev ? (lang === 'en' ? `With less than ${days(prev.min, lang)}` : `Con menos de ${days(prev.min, lang)}`)
        : (lang === 'en' ? 'At any time' : 'En cualquier momento');
    const what = t.refund <= 0
      ? (lang === 'en' ? 'the deposit is not refunded' : 'no se devuelve la señal')
      : (lang === 'en' ? `${pct(t.refund, lang)} of the deposit is refunded` : `se devuelve el ${pct(t.refund, lang)} de la señal`);
    const extra = t.extra ? (lang === 'en' ? ' and extra costs are charged' : ' y se cobran costes extra') : '';
    return `${when}: ${what}${extra}.`;
  });
}

/** Valor de cada marcador para unas condiciones (null = vacío). */
export function conditionsMarkerValues(conditions: Record<string, unknown>, tiers: readonly ConditionsTier[], lang: ConditionsLang = 'es'): Record<string, string | null> {
  const value = (key: string, fmt: (n: number) => string) => { const n = num(conditions[key]); return n === null || n === 0 ? null : fmt(n); };
  const lines = cancellationLines(tiers, lang);
  return {
    'condiciones.senal_porcentaje': value('deposit_percent', (n) => pct(n, lang)),
    'condiciones.senal_minima': value('deposit_minimum', (n) => eur(n, lang)),
    'condiciones.senal_plazo': value('deposit_days', (n) => days(n, lang)),
    'condiciones.senal_plazo_corto': value('deposit_days_short', (n) => days(n, lang)),
    'condiciones.poca_antelacion': value('short_notice_days', (n) => days(n, lang)),
    'condiciones.iva': value('vat_rate', (n) => pct(n, lang)),
    'condiciones.minimo': value('minimum_total', (n) => eur(n, lang)),
    'condiciones.cancelacion': lines.length ? lines.join('\n') : null,
  };
}

/** Resuelve el texto. `unknown`: marcadores que no existen (se dejan tal cual; el editor avisa al guardar). */
export function renderConditionsText(text: string | null | undefined, conditions: Record<string, unknown>, tiers: readonly ConditionsTier[], lang: ConditionsLang = 'es'): { text: string; unknown: string[] } {
  if (!text) return { text: '', unknown: [] };
  const values = conditionsMarkerValues(conditions, tiers, lang);
  const unknown = new Set<string>();
  let out = text.replace(/\{\{#([a-z_.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (whole, key: string, inner: string) => {
    if (!(key in values)) { unknown.add(key); return whole; }
    return values[key] === null ? '' : inner;
  });
  out = out.replace(/\{\{([a-z_.]+)\}\}/g, (whole, key: string) => {
    if (!(key in values)) { unknown.add(key); return whole; }
    return values[key] ?? '';
  });
  // bloques sueltos o mal cerrados de marcadores desconocidos también se avisan
  for (const m of out.matchAll(/\{\{[#/]([a-z_.]+)\}\}/g)) unknown.add(m[1]!);
  return { text: out, unknown: [...unknown] };
}
