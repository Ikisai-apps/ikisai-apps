import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentExtractor, parseDocument, base64 } from '../../supabase/functions/_kit/extract.ts';
import { Fault } from '../../supabase/functions/_kit/errors.ts';
import type { RequestContext } from '../../supabase/functions/_kit/sync.ts';

const ctx = { app: 'invoices', user: { id: 'u1' } } as unknown as RequestContext;
const pdf = new TextEncoder().encode('%PDF-1.4 factura de prueba');
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const files = {
  pdf: { id: 'f1', bucket: 'purchase-documents', path: 'invoices/2026/f1.pdf', mime: 'application/pdf', filename: 'factura.pdf', size: pdf.byteLength },
  jpg: { id: 'f2', bucket: 'purchase-documents', path: 'invoices/2026/f2.jpg', mime: 'image/jpeg', filename: 'ticket.jpg', size: jpg.byteLength },
};
const supabaseConfig = { url: 'https://x.supabase.co', anonKey: 'anon', serviceKey: 'service' };

function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 2100, output_tokens: 410, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 }, ...extra,
  };
}

/** Transporte simulado: sirve los objetos del bucket y responde a la API de Anthropic con lo que se le indique. */
function transport(reply: (request: { url: string; headers: Headers; body: any }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Headers; body: any }> = [];
  const storage = new Map<string, Uint8Array>([[files.pdf.path, pdf], [files.jpg.path, jpg]]);
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(supabaseConfig.url + '/storage/v1/object/')) {
      const path = decodeURIComponent(url.slice((supabaseConfig.url + '/storage/v1/object/purchase-documents/').length));
      const data = storage.get(path);
      return data ? new Response(data as unknown as BodyInit, { status: 200 }) : Response.json({ error: 'not found' }, { status: 404 });
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const call = { url, headers, body };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { fetch: fetchStub, calls, storage };
}

async function faultOf(promise: Promise<unknown>): Promise<Fault> {
  try { await promise; } catch (e) { if (e instanceof Fault) return e; throw e; }
  assert.fail('esperaba Fault');
}

test('sin clave de API: EXTRACTION_UNAVAILABLE 503 sin tocar la red', async () => {
  let called = false;
  const extract = createDocumentExtractor(supabaseConfig, { apiKey: '', fetch: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch });
  const f = await faultOf(extract({ files: [files.pdf], prompt: 'Lee la factura', ctx }));
  assert.equal(f.status, 503); assert.equal(f.code, 'EXTRACTION_UNAVAILABLE'); assert.deepEqual(f.details, { reason: 'NO_API_KEY' }); assert.equal(called, false);
});

test('adjunta PDF e imagen en base64, manda el prompt como system con caché y pide el fallback por defecto', async () => {
  const t = transport(() => Response.json(message('Nota: el IVA de la línea 2 no se lee bien.\n```json\n{"schema_version":"ikisai.invoice.v1","lines":[{"net_amount":10}]}\n```')));
  const extract = createDocumentExtractor({ ...supabaseConfig, fetch: t.fetch }, { apiKey: 'sk-test', fetch: t.fetch, maxRetries: 0 });
  const out = await extract({ files: [files.pdf, files.jpg], prompt: 'Lee la factura adjunta', ctx });
  assert.deepEqual(out.document, { schema_version: 'ikisai.invoice.v1', lines: [{ net_amount: 10 }] });
  assert.deepEqual(out.warnings, ['Nota: el IVA de la línea 2 no se lee bien.']);
  assert.equal(out.usage.model, 'claude-opus-5-5'); assert.equal(out.usage.inputTokens, 2100); assert.equal(out.usage.outputTokens, 410); assert.equal(out.usage.cacheReadInputTokens, 1500);
  assert.equal(t.calls.length, 1);
  const call = t.calls[0]!;
  assert.ok(call.url.startsWith('https://api.anthropic.com/v1/messages'), call.url);
  assert.equal(call.headers.get('x-api-key'), 'sk-test');
  assert.match(call.headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
  assert.equal(call.body.model, 'claude-opus-5-5'); assert.equal(call.body.fallbacks, 'default'); assert.equal(call.body.max_tokens, 16000);
  assert.deepEqual(call.body.output_config, { effort: 'medium' });
  assert.deepEqual(call.body.system, [{ type: 'text', text: 'Lee la factura adjunta', cache_control: { type: 'ephemeral' } }]);
  const content = call.body.messages[0].content;
  assert.equal(call.body.messages[0].role, 'user');
  assert.equal(content[0].type, 'document'); assert.equal(content[0].source.media_type, 'application/pdf'); assert.equal(content[0].source.data, base64(pdf)); assert.equal(content[0].title, 'factura.pdf');
  assert.equal(content[1].type, 'image'); assert.equal(content[1].source.media_type, 'image/jpeg'); assert.equal(content[1].source.data, Buffer.from(jpg).toString('base64'));
  assert.equal(content[2].type, 'text'); assert.match(content[2].text, /factura\.pdf, ticket\.jpg/);
});

test('con schema se pide salida estructurada y el JSON limpio no genera avisos', async () => {
  const t = transport(() => Response.json(message('{"a":1}')));
  const extract = createDocumentExtractor({ ...supabaseConfig, fetch: t.fetch }, { apiKey: 'sk-test', fetch: t.fetch, maxRetries: 0, model: 'claude-sonnet-5-5', effort: 'low' });
  const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false };
  const out = await extract({ files: [files.jpg], prompt: 'p', ctx, schema });
  assert.deepEqual(out.document, { a: 1 }); assert.deepEqual(out.warnings, []);
  assert.deepEqual(t.calls[0]!.body.output_config, { effort: 'low', format: { type: 'json_schema', schema } });
  assert.equal(t.calls[0]!.body.model, 'claude-sonnet-5-5');
});

test('respuesta sin JSON, truncada o rechazada → EXTRACTION_INVALID 422 con el motivo y el uso', async () => {
  let reply = message('No puedo leer el documento, está en blanco.');
  const t = transport(() => Response.json(reply));
  const extract = createDocumentExtractor({ ...supabaseConfig, fetch: t.fetch }, { apiKey: 'sk-test', fetch: t.fetch, maxRetries: 0 });
  let f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.status, 422); assert.equal(f.code, 'EXTRACTION_INVALID'); assert.deepEqual((f.details as any).errors, ['NO_JSON']); assert.deepEqual((f.details as any).warnings, ['No puedo leer el documento, está en blanco.']);
  assert.equal((f.details as any).usage.outputTokens, 410);
  reply = message('{"a":', { stop_reason: 'max_tokens' });
  f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.code, 'EXTRACTION_INVALID'); assert.deepEqual((f.details as any).errors, ['TRUNCATED']);
  reply = message('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: null } });
  f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.code, 'EXTRACTION_INVALID'); assert.deepEqual((f.details as any).errors, ['REFUSAL']); assert.equal((f.details as any).category, 'general_harms');
});

test('errores del proveedor: 401/429/5xx/red → EXTRACTION_UNAVAILABLE 503; 400 → INVALID_FILE 422', async () => {
  let status = 401;
  const t = transport(() => status === 0 ? Promise.reject(new TypeError('fetch failed')) : Response.json({ type: 'error', error: { type: 'x', message: 'provider says no' } }, { status }));
  const extract = createDocumentExtractor({ ...supabaseConfig, fetch: t.fetch }, { apiKey: 'sk-bad', fetch: t.fetch, maxRetries: 0 });
  let f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.status, 503); assert.equal(f.code, 'EXTRACTION_UNAVAILABLE'); assert.equal((f.details as any).reason, 'API_KEY_REJECTED');
  status = 429; f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.status, 503); assert.equal((f.details as any).reason, 'RATE_LIMITED');
  status = 529; f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.status, 503); assert.equal((f.details as any).reason, 'PROVIDER_ERROR');
  status = 0; f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.status, 503); assert.equal((f.details as any).reason, 'NETWORK');
  status = 400; f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.status, 422); assert.equal(f.code, 'INVALID_FILE'); assert.equal((f.details as any).reason, 'PROVIDER_REJECTED'); assert.match(f.message, /provider says no/);
});

test('documentos: tipo no admitido, demasiado grandes o ausentes del bucket, antes de llamar al modelo', async () => {
  const t = transport(() => Response.json(message('{}')));
  const extract = createDocumentExtractor({ ...supabaseConfig, fetch: t.fetch }, { apiKey: 'sk-test', fetch: t.fetch, maxRetries: 0, maxImageBytes: 4, maxTotalBytes: 30 });
  let f = await faultOf(extract({ files: [{ ...files.pdf, mime: 'image/heic' }], prompt: 'p', ctx }));
  assert.equal(f.code, 'INVALID_FILE'); assert.equal((f.details as any).mime, 'image/heic');
  f = await faultOf(extract({ files: [files.jpg], prompt: 'p', ctx }));
  assert.equal(f.code, 'INVALID_FILE'); assert.equal((f.details as any).maxImageBytes, 4);
  f = await faultOf(extract({ files: [files.pdf, files.pdf], prompt: 'p', ctx }));
  assert.equal(f.code, 'INVALID_FILE'); assert.equal((f.details as any).maxTotalBytes, 30);
  f = await faultOf(extract({ files: [{ ...files.pdf, path: 'no/existe.pdf' }], prompt: 'p', ctx }));
  assert.equal(f.status, 404); assert.equal(f.code, 'FILE_NOT_FOUND');
  assert.equal(t.calls.length, 0);
});

test('parseDocument separa prosa y JSON, con y sin vallas', () => {
  assert.deepEqual(parseDocument('{"x":1}'), { ok: true, document: { x: 1 }, warnings: [] });
  assert.deepEqual(parseDocument('Aviso.\n```json\n{"x":[1,{"y":"}"}]}\n```\nFin.'), { ok: true, document: { x: [1, { y: '}' }] }, warnings: ['Aviso.', 'Fin.'] });
  assert.deepEqual(parseDocument('{"x":'), { ok: false, error: 'NO_JSON', warnings: ['{"x":'] });
  assert.deepEqual(parseDocument('{"x":}'), { ok: false, error: 'INVALID_JSON', warnings: [] });
  assert.equal(base64(new Uint8Array(70000).fill(65)), Buffer.alloc(70000, 65).toString('base64'));
});
