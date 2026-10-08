/**
 * Build de Guests para las pruebas de Playwright, **uno solo** aunque haya varios workers (la CI lanza `--workers=2`).
 * Antes cada spec (`portal.spec.ts`, `modules.spec.ts`) hacía su `vite build`, que vacía `dist/`: si dos se cruzaban, una
 * página podía cargar a medias. Mismo patrón que `tests/tasks/e2e-server.ts` (`buildTasksApp`, 8-10-2026): se construye
 * solo si las fuentes cambiaron desde el último build (huella de rutas, tamaños y fechas en `dist/.e2e-stamp`) y con un
 * cerrojo entre procesos; quien llega mientras otro construye, espera a que termine.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GUESTS_VITE_CONFIG = path.resolve(here, '../../apps/guests/vite.config.ts');
const DIST = path.resolve(here, '../../apps/guests/dist');
const BUILD_SOURCES = [
  '../../apps/guests/public', '../../apps/guests/src', '../../apps/guests/index.html', '../../apps/guests/vite.config.ts',
  '../../packages/ui-kit/src', '../../packages/sync-client/src', '../../packages/domain-booking/src', '../../supabase/functions/_domain',
].map((p) => path.resolve(here, p));

function sourceStamp(): string {
  const hash = createHash('sha256');
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) { for (const name of readdirSync(p).sort()) walk(path.join(p, name)); return; }
    hash.update(`${p}|${st.size}|${st.mtimeMs};`);
  };
  for (const p of BUILD_SOURCES) walk(p);
  return hash.digest('hex');
}

export async function buildGuestsApp(): Promise<void> {
  const stampFile = path.join(DIST, '.e2e-stamp');
  const stamp = sourceStamp();
  const fresh = () => existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp;
  const lock = path.join(tmpdir(), `ikisai-guests-e2e-build-${createHash('sha256').update(DIST).digest('hex').slice(0, 12)}`);
  for (const started = Date.now(); ;) {
    if (fresh()) return;
    let mine = false;
    try { mkdirSync(lock); mine = true; } catch {
      // Un cerrojo de un proceso que murió a medias no bloquea para siempre.
      try { if (Date.now() - statSync(lock).mtimeMs > 180_000) rmSync(lock, { recursive: true, force: true }); } catch { /* ya no está */ }
    }
    if (mine) {
      try {
        if (!fresh()) { await build({ configFile: GUESTS_VITE_CONFIG, logLevel: 'silent' }); writeFileSync(stampFile, stamp); }
      } finally { rmSync(lock, { recursive: true, force: true }); }
      return;
    }
    if (Date.now() - started > 240_000) throw new Error('Esperando el build de Guests de otro worker más de 4 minutos.');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
