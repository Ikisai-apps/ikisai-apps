import { defineConfig } from 'playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');

function chromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : null;
  if (!base) return undefined;
  for (const revision of ['chromium-1217']) {
    const candidate = path.join(base, revision, 'chrome-win64', 'chrome.exe');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const executablePath = chromiumExecutable();
const port = 4179;

export default defineConfig({
  testDir: here,
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: path.resolve(pkg, 'test-results'),
  webServer: {
    command: `npx vite --config demo/vite.config.ts --port ${port} --strictPort --host 127.0.0.1`,
    cwd: pkg,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    headless: true,
    locale: 'es-ES',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'movil', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'escritorio', use: { viewport: { width: 1440, height: 1000 } } },
  ],
});
