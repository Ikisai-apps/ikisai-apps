/**
 * Ikisai Flow · API. Primer incremento: solo el núcleo del kit (salud, sesión, bootstrap, sincronización, feedback y
 * uso), sin tablas ni rutas propias. Sirve para validar el despliegue de flow.ikisai.com (docs/flow/ESTADO.md).
 */
import { createApp, type AppConfig } from '../_kit/mod.ts';
import { APP } from '../_domain/flow/mod.ts';

export const FLOW_ORIGINS = ['https://flow.ikisai.com', 'https://ikisai-flow.pages.dev'];

export function createFlowApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'routes'> & Partial<Pick<AppConfig, 'origins'>>) {
  return createApp({
    ...base,
    app: APP,
    slug: 'flow-api',
    origins: base.origins ?? FLOW_ORIGINS,
    routes: [],
  });
}
