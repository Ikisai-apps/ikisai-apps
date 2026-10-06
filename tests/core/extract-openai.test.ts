/** Extracción con OpenAI (Chat Completions) y selección del proveedor por secretos de la Edge. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentExtractor, createDocumentExtractorFromEnv, base64 } from '../../supabase/functions/_kit/extract.ts';
import { Fault } from '../../supabase/functions/_kit/errors.ts';
import type { RequestContext } from '../../supabase/functions/_kit/sync.ts';

const ctx = { app: 'invoices', user: { id: 'u1' } } as unknown as RequestContext;
const pdf = new TextEncoder().encode('%PDF-1.4 factura');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
const files = {
  pdf: { id: 'f1', bucket: 'purchase-documents', path: 'a/f1.pdf', mime: 'application/pdf', filename: 'factura.pdf', size: pdf.byteLength },
  png: { id: 'f2', bucket: 'purchase-documents', path: 'a/f2.png', mime: 'image/png', filename: 'ticket.png', size: png.byteLength },
};
const base = { url: 'https://x.supabase.co', anonKey: 'anon', serviceKey: 'service' };

function completion(content: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4.1-2025-04-14',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null }, ...extra }],
    usage: { prompt_tokens: 1800, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1024 } },
  };
}

function transport(reply: (call: { url: string; headers: Headers; body: any }) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Headers; body: any }> = [];
  const storage = new Map<string, Uint8Array>([[files.pdf.path, pdf], [files.png.path, png]]);
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(base.url + '/storage/v1/object/')) {
      const data = storage.get(decodeURIComponent(url.slice((base.url + '/storage/v1/object/purchase-documents/').length)));
      return data ? new Response(data as unknown as BodyInit) : Response.json({}, { status: 404 });
    }
    const call = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

async function faultOf(promise: Promise<unknown>): Promise<Fault> {
  try { await promise; } catch (e) { if (e instanceof Fault) return e; throw e; }
  assert.fail('esperaba Fault');
}

test('openai · PDF en file_data, imagen en image_url, prompt como system, json_schema con schema y uso normalizado', async () => {
  const t = transport(() => Response.json(completion('{"schema_version":"ikisai.invoice.v1"}')));
  const extract = createDocumentExtractor({ ...base, fetch: t.fetch }, { provider: 'openai', apiKey: 'sk-test', fetch: t.fetch, maxRetries: 0 });
  const schema = { type: 'object', properties: { schema_version: { type: 'string' } } };
  const out = await extract({ files: [files.pdf, files.png], prompt: 'Lee la factura', ctx, schema });
  assert.deepEqual(out.document, { schema_version: 'ikisai.invoice.v1' });
  assert.deepEqual(out.usage, { ...out.usage, model: 'gpt-4.1-2025-04-14', inputTokens: 1800, outputTokens: 300, cacheReadInputTokens: 1024, cacheCreationInputTokens: 0 });
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.headers.get('authorization'), 'Bearer sk-test');
  assert.equal(call.body.model, 'gpt-4.1'); assert.equal(call.body.max_completion_tokens, 16000);
  assert.deepEqual(call.body.messages[0], { role: 'system', content: 'Lee la factura' });
  const parts = call.body.messages[1].content;
  assert.deepEqual(parts[0], { type: 'file', file: { filename: 'factura.pdf', file_data: 'data:application/pdf;base64,' + base64(pdf) } });
  assert.equal(parts[1].type, 'image_url'); assert.equal(parts[1].image_url.url, 'data:image/png;base64,' + base64(png));
  assert.equal(parts[2].type, 'text');
  assert.deepEqual(call.body.response_format, { type: 'json_schema', json_schema: { name: 'documento', schema, strict: false } });
});

test('openai · sin schema pide json_object; rechazo, truncado y sin JSON → EXTRACTION_INVALID', async () => {
  let reply: any = completion('{"a":1}');
  const t = transport(() => Response.json(reply));
  const extract = createDocumentExtractor({ ...base, fetch: t.fetch }, { provider: 'openai', apiKey: 'sk-test', fetch: t.fetch, maxRetries: 0 });
  assert.deepEqual((await extract({ files: [files.pdf], prompt: 'p', ctx })).document, { a: 1 });
  assert.deepEqual(t.calls[0]!.body.response_format, { type: 'json_object' });
  reply = { ...completion(null), choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'No puedo ayudar con eso.' } }] };
  let f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.code, 'EXTRACTION_INVALID'); assert.deepEqual((f.details as any).errors, ['REFUSAL']);
  reply = completion('{"a":', { finish_reason: 'length' });
  f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.deepEqual((f.details as any).errors, ['TRUNCATED']);
  reply = completion('sin json');
  f = await faultOf(extract({ files: [files.pdf], prompt: 'p', ctx }));
  assert.deepEqual((f.details as any).errors, ['NO_JSON']);
});

test('openai · errores del proveedor: 401, cuota, 429, 5xx y red → 503; 400 → INVALID_FILE; reintenta 5xx una vez', async () => {
  let status = 401; let code = 'invalid_api_key'; let fails = 0;
  const t = transport(() => {
    if (status === 0) return Promise.reject(new TypeError('fetch failed'));
    if (status === 502 && fails++ === 0) return Response.json({ error: { message: 'bad gateway' } }, { status: 502 });
    if (status === 502) return Response.json(completion('{"ok":true}'));
    return Response.json({ error: { message: 'proveedor dice no', code } }, { status });
  });
  const make = (retries: number) => createDocumentExtractor({ ...base, fetch: t.fetch }, { provider: 'openai', apiKey: 'sk-x', fetch: t.fetch, maxRetries: retries });
  let f = await faultOf(make(0)({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.status, 503); assert.equal((f.details as any).reason, 'API_KEY_REJECTED');
  status = 429; code = 'insufficient_quota';
  f = await faultOf(make(0)({ files: [files.pdf], prompt: 'p', ctx })); assert.equal((f.details as any).reason, 'QUOTA_EXHAUSTED');
  code = 'rate_limit_exceeded';
  f = await faultOf(make(0)({ files: [files.pdf], prompt: 'p', ctx })); assert.equal((f.details as any).reason, 'RATE_LIMITED');
  status = 0;
  f = await faultOf(make(0)({ files: [files.pdf], prompt: 'p', ctx })); assert.equal((f.details as any).reason, 'NETWORK');
  status = 400;
  f = await faultOf(make(0)({ files: [files.pdf], prompt: 'p', ctx })); assert.equal(f.code, 'INVALID_FILE'); assert.match(f.message, /proveedor dice no/);
  status = 502;
  assert.deepEqual((await make(1)({ files: [files.pdf], prompt: 'p', ctx })).document, { ok: true });
});

test('selección por secretos: EXTRACTION_PROVIDER manda; si no, OpenAI con OPENAI_API_KEY; modelo por OPENAI_MODEL; sin claves → 503', async () => {
  const t = transport(() => Response.json(completion('{"x":1}')));
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  await createDocumentExtractorFromEnv({ ...base, fetch: t.fetch }, env({ OPENAI_API_KEY: 'sk-o', OPENAI_MODEL: 'gpt-modelo-x', ANTHROPIC_API_KEY: 'sk-ant' }), { fetch: t.fetch, maxRetries: 0 })({ files: [files.pdf], prompt: 'p', ctx });
  assert.equal(t.calls.at(-1)!.url, 'https://api.openai.com/v1/chat/completions'); assert.equal(t.calls.at(-1)!.body.model, 'gpt-modelo-x');
  const forced = createDocumentExtractorFromEnv({ ...base, fetch: t.fetch }, env({ EXTRACTION_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-o' }), { fetch: t.fetch, maxRetries: 0 });
  const f = await faultOf(forced({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(f.code, 'EXTRACTION_UNAVAILABLE'); assert.equal((f.details as any).reason, 'NO_API_KEY');
  const none = await faultOf(createDocumentExtractorFromEnv(base, env({}))({ files: [files.pdf], prompt: 'p', ctx }));
  assert.equal(none.status, 503);
});
