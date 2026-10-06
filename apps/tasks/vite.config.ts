import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postcss, { type Plugin as PostcssPlugin } from 'postcss';
import { build, defineConfig, type Plugin } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const alias = [
  { find: '@ikisai/sync-client', replacement: path.resolve(root, '../../packages/sync-client/src/index.ts') },
  { find: '@ikisai/domain-tasks', replacement: path.resolve(root, '../../packages/domain-tasks/src/index.ts') },
  { find: /^@ikisai\/ui-kit$/, replacement: path.resolve(root, '../../packages/ui-kit/src/index.ts') },
];

/** Clase que envuelve cada trozo de interfaz pintado con el kit mientras convive con la interfaz heredada. */
export const KIT_SCOPE = 'ikisai-kit';
/** Dentro de una pieza del kit, contenido heredado al que el CSS del kit no debe llegar. */
export const LEGACY_SCOPE = 'ikisai-legacy';

/** Añade `:where(:not(.ikisai-legacy *))` al último compuesto del selector, antes de un pseudoelemento si lo hay. */
function stopAtLegacy(selector: string): string {
  // :where() no suma especificidad: las reglas heredadas que hoy ganan dentro de piezas del kit siguen ganando.
  // Dentro del contenido heredado, el kit vuelve a valer en piezas suyas envueltas de nuevo en `.ikisai-kit`.
  const guard = `:where(:not(.${LEGACY_SCOPE} *),.${LEGACY_SCOPE} .${KIT_SCOPE} *)`;
  const pseudo = selector.indexOf('::');
  return pseudo >= 0 ? selector.slice(0, pseudo) + guard + selector.slice(pseudo) : selector + guard;
}

/** Divide una lista de selectores por las comas de primer nivel (respeta `:is(a,b)` y `[a="x,y"]`). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', current = '';
  for (const ch of list) {
    if (quote) { current += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Acota el CSS del kit a `.ikisai-kit` y lo detiene en `.ikisai-legacy` (contenido heredado dentro de una pieza del kit,
 * como el cuerpo de la hoja: el kit pinta el marco y no el contenido): la hoja del kit y la heredada comparten nombres de clase (`.topbar`, `.brand`,
 * `.field`, `.chip`…), así que, hasta que la interfaz heredada desaparezca, las reglas del kit solo se aplican dentro de
 * los elementos que la app marca con esa clase. Quedan globales los tokens (`:root`), las fuentes y las animaciones; las
 * reglas de `html`/`body` del kit no se aplican (las de la app mandan).
 */
function scopeKitCss(): PostcssPlugin {
  return {
    postcssPlugin: 'ikisai-tasks-scope-kit',
    Rule(rule) {
      const parent = rule.parent as { type?: string; name?: string } | undefined;
      if (parent?.type === 'atrule' && /^(font-face|keyframes|page)$/i.test(parent.name ?? '')) return;
      rule.selectors = splitSelectors(rule.selector).map((selector) => {
        if (/^:root\b/.test(selector)) {
          // `:root[data-theme="dark"] .toast` → sigue dependiendo del tema, pero dentro del ámbito.
          const rest = selector.replace(/^:root(\[[^\]]*\]|:not\([^)]*\))*/, '');
          return rest.trim() ? `${selector.slice(0, selector.length - rest.length)} .${KIT_SCOPE} ${stopAtLegacy(rest.trim())}` : selector;
        }
        if (/^(\*|::selection|html\b|body\b)/.test(selector)) return `.${KIT_SCOPE} ${stopAtLegacy(selector.replace(/^(html|body)\b/, 'x-never'))}`;
        return `.${KIT_SCOPE} ${stopAtLegacy(selector)}`;
      });
    },
  };
}
scopeKitCss.postcss = true;

/**
 * Segundo paquete clásico: `src/kit.ts` → `dist/kit.js` + `dist/kit.css` (`window.IkisaiKit`, el kit de interfaz común).
 * Un IIFE solo admite una entrada, así que se construye en una segunda pasada al terminar la principal.
 */
function kitBundle(): Plugin {
  return {
    name: 'ikisai-tasks-kit-bundle',
    apply: 'build',
    async closeBundle() {
      await build({
        configFile: false,
        root,
        base: '/',
        logLevel: 'warn',
        resolve: { alias },
        css: { postcss: { plugins: [scopeKitCss()] } },
        build: {
          outDir: 'dist',
          emptyOutDir: false,
          copyPublicDir: false,
          target: 'es2022',
          sourcemap: false,
          cssCodeSplit: false,
          lib: { entry: path.resolve(root, 'src/kit.ts'), formats: ['iife'], name: 'IkisaiKitBundle', fileName: () => 'kit.js' },
          rollupOptions: { output: { assetFileNames: 'kit[extname]' } },
        },
      });
    },
  };
}

/**
 * La interfaz de Tasks son scripts clásicos que viven en `public/` y se copian tal cual a `dist/` (index.html incluido).
 * Se compilan dos piezas: el núcleo del adaptador, `src/core.ts` → `dist/sync-core.js` (IIFE, `window.IkisaiTasks`),
 * que index.html carga justo antes de `sync.js`, y el kit de interfaz común, `src/kit.ts` → `dist/kit.js` + `dist/kit.css`.
 */
export default defineConfig({
  root,
  base: '/',
  publicDir: 'public',
  resolve: { alias },
  plugins: [kitBundle()],
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
