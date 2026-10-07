import { defineConfig } from 'playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Playwright descarga Chromium en %LOCALAPPDATA%\ms-playwright; si la revisión que espera no está instalada
 * pero hay otra, la usamos (evita `npx playwright install` en máquinas sin red o sin permisos).
 */
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

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    headless: true,
    viewport: { width: 390, height: 844 },
    locale: 'es-ES',
    // «Hoy» de las apps es el de Madrid; con el runner en UTC, de 00:00 a 02:00 las fechas no cuadraban.
    timezoneId: 'Europe/Madrid',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
});
