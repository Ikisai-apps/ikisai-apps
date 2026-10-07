/** Booking · SES-1 (API.md §17.3): solicitudes validadas contra los XSD oficiales, ZIP/Base64, sobres SOAP, respuestas y transporte. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateXML } from 'xmllint-wasm';
import {
  batchOutcome, batchQueryEnvelope, buildCancellationRequest, buildGuestReportRequest, buildReservationRequest, communicationEnvelope,
  fromBase64, parseBatchResponse, parseCommunicationResponse, SesDataError, unzipSingle, zipSingle, type SesContract,
} from '../../supabase/functions/_domain/booking/ses/mod.ts';
import { createSesTransport, sesCredentials } from '../../supabase/functions/booking-api/ses/transport.ts';
import { FNMT_AC_COMPONENTES_PEM } from '../../supabase/functions/booking-api/ses/fnmt.ts';

const dir = new URL('../../integrations/ses/', import.meta.url);
// Algún XSD oficial está en Latin-1 aunque declare UTF-8 (un nombre de elemento que no usamos): se lee como lo que es.
const xsd = (name: string) => {
  const bytes = readFileSync(new URL(name, dir));
  try { return { fileName: name, contents: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; } catch {
    return { fileName: name, contents: new TextDecoder('latin1').decode(bytes).replace(/encoding="UTF-8"/, 'encoding="ISO-8859-1"') };
  }
};
async function valid(xml: string, schema: string, preload: string[] = ['tiposGenerales.xsd']) {
  const out = await validateXML({ xml: [{ fileName: 'solicitud.xml', contents: xml }], schema: [xsd(schema)], preload: preload.map(xsd) });
  assert.ok(out.valid, `${schema}: ${out.errors.map((e) => e.message ?? e.rawMessage).join(' | ')}`);
}

const contract: SesContract = {
  reference: 'RSV_2027_001', contractDate: '2027-04-02', startDate: '2027-05-10', endDate: '2027-05-12', arrivalTime: '17:00',
  persons: 20, rooms: 6, internet: true, payment: { type: 'transferencia', date: '2027-04-01', holder: 'Organización Sintética' },
};

test('ses · RH, PV y anulación cumplen los XSD oficiales', async () => {
  const rh = buildReservationRequest({ establishmentCode: '0000000001', contract,
    holder: { role: 'TI', firstName: 'Persona', lastName1: 'Organizadora', email: 'organiza@example.invalid', phone: '600000000', documentType: 'DNI', documentNumber: '00000000T' } });
  await valid(rh, 'altaReservaHospedaje.xsd');
  assert.match(rh, /<fechaEntrada>2027-05-10T17:00:00<\/fechaEntrada><fechaSalida>2027-05-12T12:00:00<\/fechaSalida>/);
  assert.match(rh, /<tipoPago>TRANS<\/tipoPago>/);

  const pv = buildGuestReportRequest({ establishmentCode: '0000000001', contract, guests: [
    { role: 'VI', firstName: 'Ana', lastName1: 'Sintética', lastName2: 'Prueba', documentType: 'DNI', documentNumber: '00000000T', documentSupport: 'AAA000000',
      birthDate: '1990-01-01', nationality: 'esp', sex: 'M', address: { address: 'C/ Falsa 1 & 2', postalCode: '00000', country: 'ESP', municipalityCode: '28079' }, email: 'ana@example.invalid' },
    { role: 'VI', firstName: 'Leo', lastName1: 'Sintético', birthDate: '2018-01-01', sex: 'X', kinship: 'hj', address: { address: 'C/ Falsa 1', postalCode: '00000', country: 'ESP' } },
  ] });
  await valid(pv, 'altaParteHospedaje.xsd');
  assert.match(pv, /C\/ Falsa 1 &amp; 2/);
  assert.match(pv, /<sexo>O<\/sexo>/); assert.match(pv, /<parentesco>HJ<\/parentesco>/); assert.match(pv, /<nacionalidad>ESP<\/nacionalidad>/);

  await valid(buildCancellationRequest(['a1b2c3']), 'anularComunicacion.xsd', []);

  assert.throws(() => buildGuestReportRequest({ establishmentCode: '1', contract, guests: [{ role: 'VI', firstName: 'Sin', lastName1: 'Fecha' }] }),
    (e: unknown) => e instanceof SesDataError && e.field === 'fechaNacimiento');
  assert.throws(() => buildReservationRequest({ establishmentCode: '1', contract: { ...contract, persons: 0 }, holder: { role: 'TI', firstName: 'A', lastName1: 'B' } }), SesDataError);
  assert.throws(() => buildReservationRequest({ establishmentCode: '1', contract, holder: { role: 'TI', firstName: 'Solo nombre', lastName1: null } }), SesDataError);
});

test('ses · sobre SOAP: cabecera válida, solicitud en ZIP y Base64 que se recupera igual', async () => {
  const solicitud = buildCancellationRequest(['codigo-1']);
  const { xml, contentSha256 } = await communicationEnvelope({ landlordCode: '0000000001', application: 'Ikisai Booking', operation: 'B', solicitud });
  assert.match(contentSha256, /^[0-9a-f]{64}$/);
  const request = /<com:comunicacionRequest>[\s\S]*<\/com:comunicacionRequest>/.exec(xml)![0]
    .replace('<com:comunicacionRequest>', '<com:comunicacionRequest xmlns:com="http://www.soap.servicios.hospedajes.mir.es/comunicacion">');
  await valid(request, 'comunicacion.xsd', ['tipoComunicacion.xsd']);
  const b64 = /<solicitud>([^<]+)<\/solicitud>/.exec(xml)![1]!;
  const inner = await unzipSingle(fromBase64(b64));
  assert.equal(inner.filename, 'solicitud.xml');
  assert.ok(inner.content.endsWith(solicitud));
  // mismo contenido, mismos bytes
  assert.deepEqual(await zipSingle('a.xml', 'hola'), await zipSingle('a.xml', 'hola'));
  assert.match(batchQueryEnvelope(['lote-1']), /<com:consultaLoteRequest><codigosLote><lote>lote-1<\/lote><\/codigosLote>/);
});

test('ses · lectura de respuestas oficiales (con sus erratas) y estados de lote', () => {
  const ok = parseCommunicationResponse(`<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><ns3:comunicacionResponse xmlns:ns3="x">
    <respuesta><codigoRetorno>0</codigoRetorno><descripcion>Ok</descripcion><lote>00000000-0000-0000-0000-000000000000</lote></respuesta></ns3:comunicacionResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`);
  assert.deepEqual(ok, { code: 0, description: 'Ok', lot: '00000000-0000-0000-0000-000000000000' });
  assert.equal(parseCommunicationResponse('<respuesta><codigo>109</codigo><descripcion>Formato de solicitud incorrecto</descripcion></respuesta>').code, 109);
  assert.equal(parseCommunicationResponse('<soap:Fault><faultstring>Unauthorized</faultstring></soap:Fault>').code, -1);

  const batch = parseBatchResponse(`<ns3:consultaLoteResponse><respuesta><codigo>0</codigo><descripcion>Ok</descripcion></respuesta>
    <resultado><lote>L1</lote><tipoComunicacion>PV</tipoComunicacion><codigoEstado>6</codigoEstado><descEstado>Lote tramitado con errores</descEstado>
    <fechaProcesamiento>2027-05-10T18:00:00</fechaProcesamiento><resultadoComunicaciones>
      <resultadoComunicacion><orden>1</orden><codigoComunicacion>C-1</codigoComunicacion></resultadoComunicacion>
      <resutadoComunicacion><orden>2</orden><tipoError>Error validación de datos</tipoError><error>No existe un establecimiento para ese código</error></resutadoComunicacion>
    </resultadoComunicaciones></resultado></ns3:consultaLoteResponse>`);
  assert.equal(batch.batches.length, 1);
  assert.equal(batchOutcome(batch.batches[0]!.stateCode), 'parcial');
  assert.deepEqual(batch.batches[0]!.items.map((i) => [i.order, i.code, i.error]), [[1, 'C-1', null], [2, null, 'No existe un establecimiento para ese código']]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(batchOutcome), ['aceptado', 'rechazado', 'error', 'en_proceso', 'en_proceso', 'parcial']);
});

test('ses · transporte: Basic, SOAPAction vacío, endpoint por entorno; secretos por entorno; intermedio igual que el del repo', async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const fakeSes: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string>, body: new TextDecoder().decode(init!.body as Uint8Array) });
    return new Response('<respuesta><codigo>0</codigo><descripcion>Ok</descripcion><lote>L9</lote></respuesta>', { status: 200 });
  };
  const transport = createSesTransport({ fetchImpl: fakeSes });
  const res = await transport.post('pre', '<x/>', { user: 'usuario', password: 'clave' });
  assert.equal(res.status, 200);
  assert.equal(calls[0]!.url, 'https://hospedajes.pre-ses.mir.es/hospedajes-web/ws/v1/comunicacion');
  assert.equal(calls[0]!.headers.authorization, `Basic ${btoa('usuario:clave')}`);
  assert.equal(calls[0]!.headers.soapaction, '');
  assert.equal(parseCommunicationResponse(res.body).lot, 'L9');

  const env = { SES_PRE_USER: 'u', SES_PRE_PASSWORD: 'p', SES_PRE_LANDLORD_CODE: '0000000001', SES_PRE_ESTABLISHMENT_CODE: '0000000002' } as Record<string, string>;
  assert.deepEqual(sesCredentials((n) => env[n], 'pre'), { user: 'u', password: 'p', landlordCode: '0000000001', establishmentCode: '0000000002' });
  assert.equal(sesCredentials((n) => env[n], 'prod'), null);

  const pem = readFileSync(new URL('fnmt-ac-componentes.pem', dir), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.equal(FNMT_AC_COMPONENTES_PEM.trim(), pem);
});
