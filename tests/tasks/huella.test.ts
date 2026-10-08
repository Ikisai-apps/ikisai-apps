/**
 * Tasks · huella en las URLs de la cáscara (`versionShellUrls`, apps/tasks/vite.config.ts): los `.js` y `.css` locales de
 * index.html pasan a `?v=<huella del contenido>`; la huella cambia con el contenido; lo externo, lo que no existe y el
 * resto de enlaces (manifiesto, iconos) no se tocan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { versionShellUrls } from '../../apps/tasks/vite.config.ts';

test('huella en las URLs de la cáscara: cambia con el contenido y no toca lo demás', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'tasks-dist-'));
  writeFileSync(path.join(dist, 'shell-ui.js'), 'uno');
  writeFileSync(path.join(dist, 'kit.css'), 'a{}');
  const html = '<link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/kit.css"><script src="/shell-ui.js"></script><script src="https://cdn.example/x.js"></script><script src="/no-existe.js"></script>';
  writeFileSync(path.join(dist, 'index.html'), html);
  assert.equal(versionShellUrls(dist), 2);
  const first = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const v1 = first.match(/shell-ui\.js\?v=([0-9a-f]{12})/)?.[1];
  assert.ok(v1, first);
  assert.match(first, /href="\/kit\.css\?v=[0-9a-f]{12}"/);
  assert.match(first, /href="\/manifest\.webmanifest"/);
  assert.match(first, /src="https:\/\/cdn\.example\/x\.js"/);
  assert.match(first, /src="\/no-existe\.js"/);
  // Otra versión del archivo: otra huella.
  writeFileSync(path.join(dist, 'shell-ui.js'), 'dos');
  writeFileSync(path.join(dist, 'index.html'), html);
  versionShellUrls(dist);
  const v2 = readFileSync(path.join(dist, 'index.html'), 'utf8').match(/shell-ui\.js\?v=([0-9a-f]{12})/)?.[1];
  assert.ok(v2 && v2 !== v1);
});
