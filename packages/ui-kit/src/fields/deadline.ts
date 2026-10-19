/**
 * Plazo en texto (MUELA-075, pieza 19): «Antes del mié, 14 oct, 19:20 (quedan 5 h)», la misma función en lista, ficha y
 * cola. La regla del plazo (cuándo vence algo) es de la app; aquí solo se dice.
 * - Con hora (ISO con `T`): fecha corta, hora y lo que queda en minutos, horas o días.
 * - Sin hora (`YYYY-MM-DD`): sin hora y lo que queda en días («vence hoy», «queda 1 día»).
 * - El año solo cuando no es el actual. Pasado el plazo: «venció hace 2 h».
 * La fecha se dice en la zona horaria de la casa (`Europe/Madrid` por defecto), no en la del dispositivo.
 */
import { kitLocaleTag, kt } from '../i18n/i18n.ts';

export interface DeadlineOptions {
  /** Ahora (para pruebas); por defecto `new Date()`. */
  now?: Date;
  timeZone?: string;
  /** Delante de la fecha; por defecto «Antes del». `''` lo quita. */
  prefix?: string;
  /** Sin el paréntesis de lo que queda. */
  noLeft?: boolean;
  locale?: string;
}

export interface DeadlineInfo {
  /** «mié, 14 oct, 19:20» o «mié, 14 oct 2027». */
  when: string;
  /** «quedan 5 h», «vence hoy», «venció hace 2 días». */
  left: string;
  overdue: boolean;
  /** Sin hora: días que faltan (negativo si pasó); con hora: minutos. */
  amount: number;
  unit: 'days' | 'minutes';
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function dayKeyIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function dayDiff(from: string, to: string): number {
  const [a, b] = [from, to].map((k) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))));
  return Math.round((b! - a!) / 86_400_000);
}

const n = (v: number) => String(v);

export function deadlineInfo(due: string, options: DeadlineOptions = {}): DeadlineInfo {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? 'Europe/Madrid';
  const locale = options.locale ?? kitLocaleTag();
  const dateOnly = DATE_ONLY.test(due);
  // Un día sin hora se dice a mediodía UTC para que ninguna zona lo mueva de día.
  const date = dateOnly ? new Date(`${due}T12:00:00Z`) : new Date(due);
  const thisYear = dayKeyIn(now, timeZone).slice(0, 4);
  const dueYear = dateOnly ? due.slice(0, 4) : dayKeyIn(date, timeZone).slice(0, 4);
  const fmt = new Intl.DateTimeFormat(locale, {
    timeZone: dateOnly ? 'UTC' : timeZone, weekday: 'short', day: 'numeric', month: 'short',
    ...(dueYear !== thisYear ? { year: 'numeric' } : {}),
  }).format(date).replace(/\./g, '');
  const time = dateOnly ? '' : new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const when = time ? `${fmt}, ${time}` : fmt;

  if (dateOnly) {
    const days = dayDiff(dayKeyIn(now, timeZone), due);
    const left = days === 0 ? kt('vence hoy')
      : days === 1 ? kt('queda 1 día')
        : days > 1 ? kt('quedan {n} días', { n: n(days) })
          : days === -1 ? kt('venció ayer') : kt('venció hace {n} días', { n: n(-days) });
    return { when, left, overdue: days < 0, amount: days, unit: 'days' };
  }
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  const abs = Math.abs(minutes);
  const span = abs < 60 ? kt('{n} min', { n: n(Math.max(1, abs)) })
    : abs < 48 * 60 ? kt('{n} h', { n: n(Math.round(abs / 60)) })
      : kt('{n} días', { n: n(Math.round(abs / 1440)) });
  const one = abs >= 60 && abs < 90;
  const left = minutes >= 0
    ? (one ? kt('queda {span}', { span }) : kt('quedan {span}', { span }))
    : kt('venció hace {span}', { span });
  return { when, left, overdue: minutes < 0, amount: minutes, unit: 'minutes' };
}

/** «Antes del mié, 14 oct, 19:20 (quedan 5 h)». */
export function deadlineText(due: string, options: DeadlineOptions = {}): string {
  const info = deadlineInfo(due, options);
  const prefix = options.prefix ?? kt('Antes del');
  const head = prefix ? `${prefix} ${info.when}` : info.when;
  return options.noLeft ? head : `${head} (${info.left})`;
}
