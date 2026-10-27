/**
 * `organizers.github_evidence` (diseño en MUELA/equipo/feedback/organizers/GITHUB_EVIDENCE.md; Flow 6 §8.4 y §8.5): la
 * evidencia automática de una tarjeta a partir de una referencia estable (PR, rama, tarjeta o commit). Cada evidencia va
 * aparte, porque «verde ≠ fusionada ≠ publicada ≠ desplegada», y nada de esto es «aceptada», que lo decide Dirección.
 *
 * Solo lectura y solo en la Edge: el token (GITHUB_TOKEN, de solo lectura) nunca llega al navegador. Sin dependencias: el
 * `fetch`, el token y la hora se inyectan, para probarlo con respuestas grabadas.
 * - ETag: cada GET a la API de GitHub guarda su ETag y su cuerpo; con `If-None-Match`, un 304 no gasta cuota.
 * - Caché por estado: la evidencia de una referencia se reutiliza 60 s con la CI en marcha, 5 min con la PR abierta y la CI
 *   terminada, 10 min fusionada y sin desplegar y 24 h desplegada.
 * - Límite de GitHub (403/429 con la cuota agotada): la última evidencia guardada con `stale: true`, o RATE_LIMITED.
 * La caché vive en la memoria de la Edge (por instancia); si hace falta compartirla, el `store` se cambia por una tabla.
 */

export const REPO = 'Ikisai-apps/ikisai-apps';
/** La comprobación obligatoria del ruleset «main protegida». */
export const GATE = 'Lint de migraciones, typecheck y pruebas PGlite';
/** Las apps con dominio propio, como en scripts/apps.py. */
export const APPS = ['tasks', 'invoices', 'booking', 'food', 'central', 'organizers', 'guests', 'flow'] as const;
const SHARED = ['supabase/functions/_kit/', 'packages/sync-client/', 'packages/ui-kit/', 'packages/test-kit/', 'scripts/', '.github/workflows/release.yml', 'package.json', 'package-lock.json', 'tsconfig.json'];

export type EvidenceRef = { pr: number } | { branch: string } | { card: string } | { sha: string };
export type Step = 'sin_pr' | 'pr_abierta' | 'ci_verde' | 'fusionada' | 'publicada' | 'desplegada';

export interface Evidence {
  ref: EvidenceRef;
  at: string;
  stale?: boolean;
  prs: Array<{
    number: number; title: string; url: string; state: 'open' | 'closed' | 'merged'; author: string | null;
    head: { branch: string; sha: string }; createdAt: string;
    ci: { state: 'pending' | 'success' | 'failure' | 'none'; gate: string | null; failing: Array<{ name: string; url: string }>; source: string };
    merge: { merged: boolean; sha: string | null; at: string | null; by: string | null };
    release: { included: boolean | null; source: string | null };
    apps: string[];
    deploy: Array<{ app: string; commit: string | null; version: string | null; includes: boolean | null; source: string }>;
    summary: Step;
  }>;
  summary: Step;
}

export interface GithubDeps {
  fetch: typeof fetch;
  token: string | null;
  now?: () => number;
  /** Caché de respuestas (ETag) y de evidencias; por defecto, en memoria de la instancia. */
  store?: EvidenceStore;
}

export interface EvidenceStore {
  response: Map<string, { etag: string; body: unknown }>;
  evidence: Map<string, { value: Evidence; until: number }>;
}
export const memoryStore = (): EvidenceStore => ({ response: new Map(), evidence: new Map() });
const sharedStore = memoryStore();

export type GithubErrorCode = 'GITHUB_UNAVAILABLE' | 'RATE_LIMITED' | 'NOT_FOUND' | 'INVALID_OPERATION';
export class GithubError extends Error {
  status: number;
  code: GithubErrorCode;
  retryAfter: number | null;
  constructor(status: number, code: GithubErrorCode, message: string, retryAfter: number | null = null) {
    super(message);
    this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}

/** La referencia de la consulta: exactamente una de `pr`, `branch`, `card` o `sha`. */
export function parseRef(params: URLSearchParams): EvidenceRef {
  const given = (['pr', 'branch', 'card', 'sha'] as const).filter((k) => params.get(k));
  if (given.length !== 1) throw new GithubError(422, 'INVALID_OPERATION', 'Indica una sola referencia: pr, branch, card o sha.');
  const key = given[0]!;
  const value = params.get(key)!.trim();
  if (key === 'pr') {
    if (!/^[1-9]\d{0,6}$/.test(value)) throw new GithubError(422, 'INVALID_OPERATION', 'pr debe ser un número de PR.');
    return { pr: Number(value) };
  }
  if (key === 'branch') {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(value) || value.includes('..')) throw new GithubError(422, 'INVALID_OPERATION', 'Rama no válida.');
    return { branch: value };
  }
  if (key === 'card') {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) throw new GithubError(422, 'INVALID_OPERATION', 'Tarjeta no válida.');
    return { card: value };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new GithubError(422, 'INVALID_OPERATION', 'sha no válido.');
  return { sha: value.toLowerCase() };
}

/** Las apps que publica una PR por sus archivos, con la regla de scripts/release_matrix.py (`affected`). */
export function affectedApps(files: string[]): string[] {
  const apps = new Set<string>();
  for (const path of files) {
    if (SHARED.some((s) => path.startsWith(s)) || /^supabase\/migrations\/\d{8}_\d{4}_core_/.test(path)) return [...APPS];
    for (const app of APPS) {
      if ([`apps/${app}/`, `supabase/functions/${app}-api/`, `packages/domain-${app}/`, `supabase/functions/_domain/${app}/`].some((p) => path.startsWith(p))
        || new RegExp(`^supabase/migrations/\\d{8}_\\d{4}_${app}_`).test(path)) apps.add(app);
    }
  }
  return APPS.filter((a) => apps.has(a));
}

const ORDER: Step[] = ['sin_pr', 'pr_abierta', 'ci_verde', 'fusionada', 'publicada', 'desplegada'];
const TTL: Record<Step, number> = { sin_pr: 300, pr_abierta: 300, ci_verde: 300, fusionada: 600, publicada: 600, desplegada: 86_400 };

export async function githubEvidence(ref: EvidenceRef, deps: GithubDeps, options: { fresh?: boolean } = {}): Promise<Evidence> {
  const store = deps.store ?? sharedStore;
  const now = deps.now ?? Date.now;
  const key = JSON.stringify(ref);
  const cached = store.evidence.get(key);
  if (cached && !options.fresh && cached.until > now()) return cached.value;
  if (!deps.token) throw new GithubError(503, 'GITHUB_UNAVAILABLE', 'Falta el token de GitHub en la Edge (GITHUB_TOKEN).');

  const api = async <T>(path: string): Promise<T> => {
    const url = `https://api.github.com${path}`;
    const known = store.response.get(url);
    const res = await deps.fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ikisai-organizers',
        Authorization: `Bearer ${deps.token}`, ...(known ? { 'If-None-Match': known.etag } : {}),
      },
    });
    if (res.status === 304 && known) return known.body as T;
    if (res.status === 404) throw new GithubError(404, 'NOT_FOUND', 'No está en GitHub.');
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      const retry = Number(res.headers.get('retry-after') ?? '') || Math.max(0, Number(res.headers.get('x-ratelimit-reset') ?? 0) - Math.floor(now() / 1000)) || 60;
      throw new GithubError(429, 'RATE_LIMITED', 'GitHub ha limitado las consultas; vuelve a probar en un rato.', retry);
    }
    if (!res.ok) throw new GithubError(503, 'GITHUB_UNAVAILABLE', `GitHub respondió ${res.status}.`);
    const body = await res.json() as T;
    const etag = res.headers.get('etag');
    if (etag) store.response.set(url, { etag, body });
    return body;
  };

  try {
    const value = await collect(ref, api, deps, now);
    const step = value.summary;
    const pending = value.prs.some((p) => p.ci.state === 'pending');
    store.evidence.set(key, { value, until: now() + 1000 * (pending ? 60 : TTL[step]) });
    return value;
  } catch (error) {
    if (error instanceof GithubError && error.code === 'RATE_LIMITED' && cached) return { ...cached.value, stale: true };
    throw error;
  }
}

type Api = <T>(path: string) => Promise<T>;

async function collect(ref: EvidenceRef, api: Api, deps: GithubDeps, now: () => number): Promise<Evidence> {
  const numbers = await prNumbers(ref, api);
  const prs = [];
  for (const n of numbers.slice(0, 5)) prs.push(await prEvidence(n, api, deps));
  const summary = prs.reduce<Step>((best, p) => (ORDER.indexOf(p.summary) > ORDER.indexOf(best) ? p.summary : best), 'sin_pr');
  return { ref, at: new Date(now()).toISOString(), prs, summary };
}

async function prNumbers(ref: EvidenceRef, api: Api): Promise<number[]> {
  if ('pr' in ref) return [ref.pr];
  if ('branch' in ref) {
    const owner = REPO.split('/')[0];
    const list = await api<Array<{ number: number }>>(`/repos/${REPO}/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:${ref.branch}`)}`);
    return list.map((p) => p.number);
  }
  if ('sha' in ref) {
    const list = await api<Array<{ number: number }>>(`/repos/${REPO}/commits/${ref.sha}/pulls`);
    return list.map((p) => p.number);
  }
  // Tarjeta: la convención es «Tarjeta: <id>» en la descripción de la PR. La búsqueda tiene su propio límite (30/min).
  const q = encodeURIComponent(`repo:${REPO} is:pr "Tarjeta: ${ref.card}"`);
  const found = await api<{ items: Array<{ number: number }> }>(`/search/issues?q=${q}&per_page=10`);
  return found.items.map((i) => i.number);
}

interface GhPull {
  number: number; title: string; html_url: string; state: 'open' | 'closed'; user: { login: string } | null; created_at: string;
  head: { ref: string; sha: string }; merged_at: string | null; merge_commit_sha: string | null; merged_by: { login: string } | null;
}
interface GhCheckRun { name: string; status: string; conclusion: string | null; html_url: string }

async function prEvidence(n: number, api: Api, deps: GithubDeps): Promise<Evidence['prs'][number]> {
  const pull = await api<GhPull>(`/repos/${REPO}/pulls/${n}`);
  const runsPath = `/repos/${REPO}/commits/${pull.head.sha}/check-runs?per_page=100`;
  const runs = (await api<{ check_runs: GhCheckRun[] }>(runsPath)).check_runs;
  const gateRun = runs.find((r) => r.name === GATE) ?? null;
  const failing = runs.filter((r) => r.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion ?? ''))
    .map((r) => ({ name: r.name, url: r.html_url }));
  const ciState: Evidence['prs'][number]['ci']['state'] = !runs.length ? 'none'
    : gateRun?.status === 'completed' ? (gateRun.conclusion === 'success' ? 'success' : 'failure')
    : failing.length ? 'failure' : 'pending';
  const merged = !!pull.merged_at;
  const files = (await api<Array<{ filename: string }>>(`/repos/${REPO}/pulls/${n}/files?per_page=100`)).map((f) => f.filename);
  const apps = affectedApps(files);

  let included: boolean | null = null;
  const deploy: Evidence['prs'][number]['deploy'] = [];
  if (merged && pull.merge_commit_sha) {
    included = await contains('released', pull.merge_commit_sha, api);
    for (const app of apps) {
      const source = `https://${app}.ikisai.com/version.json`;
      let commit: string | null = null; let version: string | null = null;
      try {
        const res = await deps.fetch(source, { headers: { 'User-Agent': 'ikisai-organizers' } });
        if (res.ok) {
          const body = await res.json() as { commit?: unknown; version?: unknown; release?: unknown };
          commit = typeof body.commit === 'string' && /^[0-9a-f]{7,40}$/.test(body.commit) ? body.commit : null;
          version = typeof body.release === 'string' ? body.release : typeof body.version === 'string' ? body.version : null;
        }
      } catch { /* sin versión legible: includes null */ }
      deploy.push({ app, commit, version, includes: commit ? await contains(commit, pull.merge_commit_sha, api) : null, source });
    }
  }
  const step: Step = merged
    ? (apps.length && deploy.length === apps.length && deploy.every((d) => d.includes) ? 'desplegada' : included ? 'publicada' : 'fusionada')
    : ciState === 'success' ? 'ci_verde' : 'pr_abierta';
  return {
    number: pull.number, title: pull.title, url: pull.html_url, state: merged ? 'merged' : pull.state, author: pull.user?.login ?? null,
    head: { branch: pull.head.ref, sha: pull.head.sha }, createdAt: pull.created_at,
    ci: { state: ciState, gate: gateRun ? (gateRun.status === 'completed' ? gateRun.conclusion : gateRun.status) : null, failing, source: `https://github.com/${REPO}/pull/${n}/checks` },
    merge: { merged, sha: merged ? pull.merge_commit_sha : null, at: pull.merged_at, by: pull.merged_by?.login ?? null },
    release: { included, source: merged ? `https://github.com/${REPO}/compare/${pull.merge_commit_sha}...released` : null },
    apps, deploy, summary: step,
  };
}

/** ¿`head` contiene `commit`? `compare/{commit}...{head}`: «ahead» o «identical» quiere decir que sí. */
async function contains(head: string, commit: string, api: Api): Promise<boolean | null> {
  try {
    const out = await api<{ status: string }>(`/repos/${REPO}/compare/${commit}...${head}`);
    return out.status === 'ahead' || out.status === 'identical';
  } catch (error) {
    if (error instanceof GithubError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}
