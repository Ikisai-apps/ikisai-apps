/** Food · `day` de las pruebas: el mismo día de calendario a cualquier hora, también con cambio de hora en medio. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIME_ZONE, dayAt } from './helpers.ts';

const MADRID = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const next = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

test('day · hoy es la fecha de Madrid y cada desplazamiento suma un día de calendario, cada media hora de dos semanas con cambio de hora', () => {
  // Otoño (25-10-2026) y primavera (28-03-2027), cada una con la semana de antes y la de después: todos los días de la
  // semana y la medianoche de UTC y de Madrid.
  for (const from of ['2026-10-18T00:00:00Z', '2027-03-21T00:00:00Z']) {
    for (let t = Date.parse(from); t < Date.parse(from) + 14 * 86400000; t += 30 * 60000) {
      const now = new Date(t);
      assert.equal(dayAt(now, 0), MADRID.format(now), now.toISOString());
      for (let offset = -14; offset < 63; offset++) assert.equal(dayAt(now, offset + 1), next(dayAt(now, offset)), `${now.toISOString()} +${offset}`);
    }
  }
});

test('day · el caso que rompió la CI: lunes 19-10-2026 a las 00:17 de Madrid, una semana después es el lunes 26', () => {
  const now = new Date('2026-10-18T22:17:00Z');
  assert.deepEqual([dayAt(now, 0), dayAt(now, 6), dayAt(now, 7)], ['2026-10-19', '2026-10-25', '2026-10-26']);
});
