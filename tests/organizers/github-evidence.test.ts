/** `organizers.github_evidence` (0704) con respuestas reales de GitHub grabadas el 27-10-2026 (PR #847, repo público):
 *  la evidencia por pasos, el ETag (304 sin gastar cuota), la caché por estado, el límite de GitHub, la ruta y quién la ve. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { affectedApps, githubEvidence, GithubError, memoryStore, parseRef } from '../../supabase/functions/_domain/organizers/github.ts';

const RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/github-847.json', import.meta.url)), 'utf8')).responses as
  Record<string, { etag: string | null; body: unknown }>;

/** GitHub grabado: 200 con su ETag, 304 si llega `If-None-Match` con ese ETag; `down` simula la cuota agotada. */
function recorded(options: { down?: boolean } = {}) {
  const calls: Array<{ url: string; status: number; auth: string | null }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const hit = RECORDED[url];
    let res: Response;
    if (options.down && url.startsWith('https://api.github.com/')) {
      res = new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '120' } });
    } else if (!hit) {
      res = new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    } else if (hit.etag && headers.get('if-none-match') === hit.etag) {
      res = new Response(null, { status: 304, headers: { etag: hit.etag } });
    } else {
      res = new Response(JSON.stringify(hit.body), { status: 200, headers: hit.etag ? { etag: hit.etag, 'content-type': 'application/json' } : { 'content-type': 'application/json' } });
    }
    calls.push({ url, status: res.status, auth: headers.get('authorization') });
    return res;
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

test('github_evidence · PR #847: CI verde, fusionada, publicada y desplegada, cada evidencia aparte', async () => {
  const gh = recorded();
  const out = await githubEvidence({ pr: 847 }, { fetch: gh.fetch, token: 'ghs_prueba', store: memoryStore() });
  assert.equal(out.summary, 'desplegada');
  const pr = out.prs[0]!;
  assert.deepEqual([pr.number, pr.state, pr.head.branch], [847, 'merged', 'organizers/k2-abrir-pdf']);
  assert.equal(pr.ci.state, 'success');
  assert.equal(pr.ci.gate, 'success');
  assert.equal(pr.merge.merged, true);
  assert.match(pr.merge.sha!, /^[0-9a-f]{40}$/);
  assert.equal(pr.release.included, true);
  assert.deepEqual(pr.apps, ['organizers']);
  assert.deepEqual([pr.deploy[0]!.app, pr.deploy[0]!.includes, pr.deploy[0]!.version], ['organizers', true, 'v0.1.0-build.856']);
  // El token va a GitHub y a nadie más.
  assert.ok(gh.calls.filter((c) => c.url.startsWith('https://api.github.com/')).every((c) => c.auth === 'Bearer ghs_prueba'));
  assert.ok(gh.calls.filter((c) => !c.url.startsWith('https://api.github.com/')).every((c) => c.auth === null));
  assert.equal(JSON.stringify(out).includes('ghs_prueba'), false);
});

test('github_evidence · caché por estado (desplegada: no vuelve a GitHub) y ETag (fresh: todo 304)', async () => {
  const gh = recorded();
  const store = memoryStore();
  let now = Date.parse('2026-10-28T09:00:00Z');
  const deps = { fetch: gh.fetch, token: 't', store, now: () => now };
  await githubEvidence({ pr: 847 }, deps);
  const first = gh.calls.length;
  now += 3_600_000;
  await githubEvidence({ pr: 847 }, deps);
  assert.equal(gh.calls.length, first, 'desplegada se guarda 24 h');
  const again = await githubEvidence({ pr: 847 }, deps, { fresh: true });
  const repeated = gh.calls.slice(first).filter((c) => c.url.startsWith('https://api.github.com/'));
  assert.ok(repeated.length > 0 && repeated.every((c) => c.status === 304), 'con ETag, GitHub responde 304');
  assert.equal(again.summary, 'desplegada');
});

test('github_evidence · por rama da la misma PR; con la cuota agotada, lo último guardado con stale', async () => {
  const store = memoryStore();
  const byBranch = await githubEvidence({ branch: 'organizers/k2-abrir-pdf' }, { fetch: recorded().fetch, token: 't', store });
  assert.deepEqual(byBranch.prs.map((p) => p.number), [847]);
  const stale = await githubEvidence({ branch: 'organizers/k2-abrir-pdf' }, { fetch: recorded({ down: true }).fetch, token: 't', store }, { fresh: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.summary, 'desplegada');
  await assert.rejects(githubEvidence({ pr: 847 }, { fetch: recorded({ down: true }).fetch, token: 't', store: memoryStore() }),
    (e: unknown) => e instanceof GithubError && e.code === 'RATE_LIMITED' && e.retryAfter === 120);
  await assert.rejects(githubEvidence({ pr: 847 }, { fetch: recorded().fetch, token: null, store: memoryStore() }),
    (e: unknown) => e instanceof GithubError && e.code === 'GITHUB_UNAVAILABLE');
});

test('github_evidence · referencia y apps afectadas', () => {
  assert.deepEqual(parseRef(new URLSearchParams('pr=847')), { pr: 847 });
  assert.deepEqual(parseRef(new URLSearchParams('sha=3DA907F')), { sha: '3da907f' });
  for (const bad of ['', 'pr=1&branch=x', 'pr=0', 'branch=a..b', 'card=con espacio', 'sha=zz']) {
    assert.throws(() => parseRef(new URLSearchParams(bad)), (e: unknown) => e instanceof GithubError && e.code === 'INVALID_OPERATION', bad);
  }
  assert.deepEqual(affectedApps(['docs/organizers/API.md', '.github/workflows/checks.yml']), []);
  assert.deepEqual(affectedApps(['apps/food/src/main.ts', 'supabase/migrations/20261028_0704_organizers_github_evidence.sql']), ['food', 'organizers']);
  assert.equal(affectedApps(['packages/ui-kit/src/x.ts']).length, 8);
});

test('github_evidence · la ruta: el personal sí (owner y editor sin grants); quien organiza un retiro, no', async () => {
  let app: TestApp | null = null;
  try {
    app = await createTestApp({
      app: 'organizers', slug: 'organizers-api', origin: ORGANIZERS_ORIGINS[0]!,
      createHandler: (config) => createOrganizersApp({ ...config, origins: [ORGANIZERS_ORIGINS[0]!], github: { token: 't', fetch: recorded().fetch, store: memoryStore() } }),
    });
    for (const token of [app.tokens.owner, app.tokens.editor]) {
      const res = await app.call('/api/v1/github/evidence?pr=847', { token });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.summary, 'desplegada');
    }
    const organizer = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2)`,
      [organizer, JSON.stringify({ grants: [{ reservation_id: crypto.randomUUID() }] })]);
    const denied = await app.call('/api/v1/github/evidence?pr=847', { token: app.supabase.tokenFor(organizer) });
    assert.equal(denied.status, 403, JSON.stringify(denied.data));
    assert.equal((await app.call('/api/v1/github/evidence?pr=847', { token: app.tokens.reader })).status, 403);
    assert.equal((await app.call('/api/v1/github/evidence?pr=1&sha=abcdef1', { token: app.tokens.owner })).data.error.code, 'INVALID_OPERATION');
    // En el catálogo de capacidades (0704).
    const caps = await app.call('/api/v1/capabilities', { token: app.tokens.owner });
    assert.ok(JSON.stringify(caps.data).includes('organizers.github_evidence'), JSON.stringify(caps.data).slice(0, 300));
  } finally {
    await app?.close();
  }
});
