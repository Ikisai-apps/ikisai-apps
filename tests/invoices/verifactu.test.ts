/** VERI*FACTU (API.md §14.6): huella con los tres ejemplos oficiales de la AEAT (v0.1.2), QR y formato del número. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatIssuedNumber, validIssuedNumberFormat, vfAltaHash, vfAltaString, vfAmount, vfAnulacionHash, vfQrUrl, vfUrlEncode } from '../../packages/domain-invoices/src/index.ts';

export const AEAT_CASE_1 = '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60';
export const AEAT_CASE_2 = 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97';
export const AEAT_CASE_3 = '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68';

test('huella: los tres ejemplos oficiales de la especificación v0.1.2', async () => {
  const first = { issuerTaxId: '89890001K', numSerie: '12345678/G33', issueDate: '01-01-2024', invoiceType: 'F1', quotaTotal: 12.35, amountTotal: 123.45, previousHash: null, generatedAt: '2024-01-01T19:20:30+01:00' };
  assert.equal(vfAltaString(first), 'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00');
  assert.equal(await vfAltaHash(first), AEAT_CASE_1);
  assert.equal(await vfAltaHash({ ...first, numSerie: '12345679/G34', previousHash: AEAT_CASE_1, generatedAt: '2024-01-01T19:20:35+01:00' }), AEAT_CASE_2);
  assert.equal(await vfAnulacionHash({ issuerTaxId: '89890001K', numSerie: '12345679/G34', issueDate: '01-01-2024', previousHash: AEAT_CASE_2, generatedAt: '2024-01-01T19:20:40+01:00' }), AEAT_CASE_3);
  // Espacios al principio y al final no cuentan
  assert.equal(await vfAltaHash({ ...first, numSerie: ' 12345678/G33 ' }), AEAT_CASE_1);
});

test('importes, codificación de URL y QR de cotejo', () => {
  assert.equal(vfAmount(123.45), '123.45'); assert.equal(vfAmount(241.4), '241.40'); assert.equal(vfAmount(-10), '-10.00'); assert.equal(vfAmount(0.005), '0.01');
  assert.equal(vfUrlEncode('12345678&G33'), '12345678%26G33');
  assert.equal(vfUrlEncode('F2026-0001'), 'F2026-0001');
  assert.equal(vfQrUrl('pruebas', '89890001K', '12345678&G33', '01-01-2024', 241.4),
    'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.40');
  assert.ok(vfQrUrl('produccion', 'B12345674', 'F2026-0001', '07-10-2026', 110).startsWith('https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?'));
});

test('formato del número de una serie de emisión', () => {
  assert.equal(formatIssuedNumber('{serie}{año}-{n:4}', 'F', 2026, 1), 'F2026-0001');
  assert.equal(formatIssuedNumber('{serie}-{año}-{n}', 'R', 2026, 12), 'R-2026-12');
  // Numeración de la hoja del usuario (ronda 47): F_02_26 → F_03_26, sin recortar a partir de 100
  assert.equal(formatIssuedNumber('{serie}_{n:2}_{aa}', 'F', 2026, 3), 'F_03_26');
  assert.equal(formatIssuedNumber('{serie}_{n:2}_{aa}', 'F', 2026, 100), 'F_100_26');
  assert.equal(formatIssuedNumber('{serie}_{n:2}_{aa}', 'R', 2026, 1), 'R_01_26');
  assert.equal(validIssuedNumberFormat('{serie}_{n:2}_{aa}', 'F'), true);
  assert.equal(validIssuedNumberFormat('{serie}{año}-{n:4}', 'F'), true);
  assert.equal(validIssuedNumberFormat('{serie}{año}', 'F'), false);
  assert.equal(validIssuedNumberFormat('{serie}-ñ-{n}', 'F'), false);
});
