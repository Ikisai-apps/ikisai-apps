/**
 * Tasks · service worker: la cáscara (scripts de nombre fijo, servidos con caché HTTP de horas) se descarga siempre fresca
 * al instalar una versión nueva (`cache: 'reload'`). Sin eso, una versión nueva del worker podía guardar las copias viejas
 * del navegador y el móvil seguía con la interfaz anterior, «Al día» y sin aviso (8-10-2026).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(path.resolve(here, '../../apps/tasks/public', name), 'utf8');

test('el service worker instala la cáscara sin la caché HTTP y la app busca versión al abrir y al volver a primer plano', () => {
  const sw = read('sw.js');
  assert.match(sw, /addAll\(SHELL\.map\(u=>new Request\(u,\{cache:'reload'\}\)\)\)/);
  const updates = read('updates.js');
  assert.match(updates, /current\.update\(\)/, 'al abrir');
  assert.match(updates, /visibilitychange[\s\S]*registration\?\.update\(\)/, 'al volver a primer plano');
  assert.match(updates, /function maybeAutoUpdate/, 'aplicación automática al abrir si es seguro');
});
