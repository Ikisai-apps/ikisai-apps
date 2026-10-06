/** MCP por app (contrato §3.2): JSON-RPC sobre `POST /api/v1/mcp` con las herramientas genéricas y las de dominio. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';
import type { McpTool } from '../../supabase/functions/_kit/mcp.ts';

const TABLE = 'invoices.suppliers';
const ORIGIN = 'https://invoices.ikisai.com';
let app: TestApp;
let agent: string;
let seq = 0;

const domainTool: McpTool = {
  name: 'invoices_add_supplier', description: 'Alta de proveedor por nombre.', minRole: 'editor',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
  handler: (args, _ctx, kit) => kit.commit({ requestId: 'add-' + String(args.name).toLowerCase(), operations: [{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: args.name, tax_id: null } }] }),
};

async function rpc(method: string, params?: unknown, token?: string) {
  const res = await app.call('/api/v1/mcp', { token, body: { jsonrpc: '2.0', id: ++seq, method, ...(params === undefined ? {} : { params }) } });
  return res;
}

test.before(async () => {
  app = await createTestApp({ app: 'invoices', slug: 'invoices-api', origin: ORIGIN, createHandler: (config) => createApp({ ...config, app: 'invoices', slug: 'invoices-api', origins: [ORIGIN], mcpTools: [domainTool] }) });
  agent = (await app.call('/api/v1/agents', { body: { name: 'Bot MCP', role: 'editor' } })).data.token;
});
test.after(async () => { await app.close(); });

test('mcp · initialize negocia versión, ping, notificación 202, método desconocido y JSON roto', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, agent);
  assert.equal(init.status, 200); assert.equal(init.data.result.protocolVersion, '2025-06-18'); assert.equal(init.data.result.serverInfo.name, 'ikisai-invoices');
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' }, agent)).data.result.protocolVersion, '2025-11-25');
  assert.deepEqual((await rpc('ping', undefined, agent)).data.result, {});
  const note = await app.call('/api/v1/mcp', { token: agent, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  assert.equal((await rpc('resources/list', undefined, agent)).data.error.code, -32601);
  assert.equal((await app.call('/api/v1/mcp', { token: agent, method: 'GET' })).status, 405);
  assert.equal((await app.call('/api/v1/mcp', { token: null, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401);
});

test('mcp · tools/list según rol: lector sin escritura; agente con prepare_batch; persona sin él; herramientas de dominio', async () => {
  const names = async (token: string) => (await rpc('tools/list', undefined, token)).data.result.tools.map((t: any) => t.name) as string[];
  const reader = await names(app.tokens.reader);
  assert.ok(reader.includes('invoices_snapshot')); assert.ok(!reader.includes('invoices_commit')); assert.ok(!reader.includes('invoices_add_supplier'));
  const bot = await names(agent);
  for (const n of ['invoices_commit', 'invoices_prepare_batch', 'invoices_undo', 'invoices_add_supplier']) assert.ok(bot.includes(n), n);
  assert.ok(!(await names(app.tokens.editor)).includes('invoices_prepare_batch'));
});

test('mcp · tools/call: herramienta de dominio, snapshot, error de herramienta como isError, borrado de agente → propuesta', async () => {
  const added = await rpc('tools/call', { name: 'invoices_add_supplier', arguments: { name: 'Makro' } }, agent);
  assert.equal(added.data.result.isError, undefined, JSON.stringify(added.data)); assert.equal(added.data.result.structuredContent.changes.length, 1);
  const id = added.data.result.structuredContent.changes[0].id;
  const snap = await rpc('tools/call', { name: 'invoices_snapshot', arguments: { tables: [TABLE] } }, agent);
  assert.ok(snap.data.result.structuredContent.tables[0].rows.some((r: any) => r.id === id));
  assert.ok(JSON.parse(snap.data.result.content[0].text).tables);
  const ops = [{ op: 'delete', table: TABLE, id, expectedRevision: 1 }];
  const blocked = await rpc('tools/call', { name: 'invoices_commit', arguments: { requestId: 'mcp-del', operations: ops } }, agent);
  assert.equal(blocked.data.result.isError, true); assert.equal(blocked.data.result.structuredContent.error.code, 'CONFIRMATION_REQUIRED');
  const prop = await rpc('tools/call', { name: 'invoices_prepare_batch', arguments: { requestId: 'mcp-del', operations: ops } }, agent);
  assert.equal(prop.data.result.structuredContent.status, 'pending');
  await app.call(`/api/v1/proposals/${prop.data.result.structuredContent.id}/approve`, { body: {} });
  const done = await rpc('tools/call', { name: 'invoices_commit', arguments: { requestId: 'mcp-del', operations: ops, confirmationId: prop.data.result.structuredContent.id } }, agent);
  assert.equal(done.data.result.isError, undefined, JSON.stringify(done.data)); assert.equal(done.data.result.structuredContent.proposalId, prop.data.result.structuredContent.id);
  const listed = await rpc('tools/call', { name: 'invoices_proposals', arguments: { status: 'consumed' } }, agent);
  assert.equal(listed.data.result.structuredContent.items.length, 1);
  const unknown = await rpc('tools/call', { name: 'invoices_commit', arguments: {} }, app.tokens.reader);
  assert.equal(unknown.data.error.code, -32602);
});

test('mcp · lote JSON-RPC: respuestas en orden y sin las notificaciones', async () => {
  const res = await app.call('/api/v1/mcp', { token: agent, body: [
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ] });
  assert.equal(res.status, 200); assert.equal(res.data.length, 2); assert.equal(res.data[0].id, 'a'); assert.equal(res.data[1].id, 'b');
});
