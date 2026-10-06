import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.resolve(root, '../fonts');

/** Sirve `../fonts` en `/fonts/` sin duplicar los archivos en el repo. */
function kitFonts(): Plugin {
  return {
    name: 'ikisai:kit-fonts',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/fonts/')) return next();
        const name = path.basename(req.url.split('?')[0] ?? '');
        try {
          const data = readFileSync(path.join(fontsDir, name));
          res.setHeader('Content-Type', 'font/woff2');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.end(data);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const name of readdirSync(fontsDir)) {
        this.emitFile({ type: 'asset', fileName: `fonts/${name}`, source: readFileSync(path.join(fontsDir, name)) });
      }
    },
  };
}

export default defineConfig({
  root,
  base: '/',
  publicDir: false,
  resolve: {
    alias: { '@ikisai/sync-client': path.resolve(root, '../../sync-client/src/index.ts') },
  },
  server: { port: 5178, strictPort: false },
  preview: { port: 4178, strictPort: false },
  plugins: [kitFonts()],
  build: { outDir: path.resolve(root, '../dist-demo'), emptyOutDir: true, target: 'es2022', sourcemap: false },
});
