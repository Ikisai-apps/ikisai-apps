import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * La interfaz de Tasks son scripts clásicos que viven en `public/` y se copian tal cual a `dist/` (index.html incluido).
 * Lo único que se compila es el núcleo del adaptador: `src/core.ts` → `dist/sync-core.js` (IIFE, `window.IkisaiTasks`),
 * que index.html carga justo antes de `sync.js`.
 */
export default defineConfig({
  root,
  base: '/',
  publicDir: 'public',
  resolve: {
    alias: [
      { find: '@ikisai/sync-client', replacement: path.resolve(root, '../../packages/sync-client/src/index.ts') },
      { find: '@ikisai/domain-tasks', replacement: path.resolve(root, '../../packages/domain-tasks/src/index.ts') },
    ],
  },
  preview: { port: 4175, strictPort: false },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: path.resolve(root, 'src/core.ts'),
      formats: ['iife'],
      name: 'IkisaiTasksCore',
      fileName: () => 'sync-core.js',
    },
  },
});
