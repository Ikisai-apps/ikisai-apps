import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const syncClientEntry = path.resolve(root, '../../packages/sync-client/src/index.ts');
const uiKitEntry = path.resolve(root, '../../packages/ui-kit/src/index.ts');

/** Archivos de `public/` que forman parte del shell (todo menos lo que es del despliegue). */
function publicShellFiles(dir: string, prefix = '/'): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_')) continue; // _worker.js, _headers, _redirects
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...publicShellFiles(full, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

/**
 * Inyecta en `sw.js` la lista de archivos a precachear (los que emite Rollup más los de `public/`)
 * y un nombre de caché derivado de su hash. Así el SW cambia exactamente cuando cambia el shell.
 */
function serviceWorkerShell(): Plugin {
  return {
    name: 'ikisai:sw-shell',
    apply: 'build',
    generateBundle(_options, bundle) {
      const sw = Object.values(bundle).find((item) => item.type === 'chunk' && item.fileName === 'sw.js');
      if (!sw || sw.type !== 'chunk') return;
      const emitted = Object.keys(bundle).filter((file) => file !== 'sw.js' && !file.endsWith('.map'));
      const shell = ['/', ...emitted.map((file) => `/${file}`), ...publicShellFiles(path.join(root, 'public'))];
      const unique = Array.from(new Set(shell)).sort();
      const digest = createHash('sha256').update(unique.join('\n')).digest('hex').slice(0, 12);
      sw.code = sw.code
        .replace('"__SHELL_ASSETS__"', JSON.stringify(unique))
        .replace("'__SHELL_ASSETS__'", JSON.stringify(unique))
        .replace('__SHELL_VERSION__', digest);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');
  const target = process.env.VITE_API_PROXY ?? env.VITE_API_PROXY;
  const proxy: Record<string, ProxyOptions> | undefined = target
    ? { '/api': { target, changeOrigin: true, secure: true } }
    : undefined;

  return {
    root,
    base: '/',
    publicDir: 'public',
    envDir: root,
    resolve: {
      alias: [
        { find: '@ikisai/sync-client', replacement: syncClientEntry },
        { find: /^@ikisai\/ui-kit$/, replacement: uiKitEntry },
      ],
    },
    server: { port: 5174, strictPort: false, proxy },
    preview: { port: 4174, strictPort: false, proxy },
    plugins: [serviceWorkerShell()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          main: path.resolve(root, 'index.html'),
          sw: path.resolve(root, 'src/sw.ts'),
        },
        output: {
          // El SW sale como /sw.js sin hash: su URL de registro es estable y el navegador detecta cambios por contenido.
          entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
