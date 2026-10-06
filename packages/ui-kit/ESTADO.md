# UI kit · estado

Actualizado: 6 de octubre de 2026. Agente UI, rama `ui/kit`, directorio `packages/ui-kit`.

## Hecho

- v0.1.0: tokens, base, componentes CSS, DOM e iconos, tema y acento, barra de estado (§6.4), login y shell, demo y pruebas Playwright (5 escenarios × 2 tamaños). Tipos en verde con el `tsconfig` raíz.

## En curso

- PR `ui/invoices-adopt-kit`: `apps/invoices` consume tokens, login, shell y barra de estado del kit; `app.css` se queda solo con lo propio (proveedores, conflictos, inicio).

## Pendiente

- v0.2: hoja inferior y diálogo con foco atrapado y cierre con Escape; componente de conflicto campo a campo; lista «pendiente de sincronizar» como componente; selector de tema para la cabecera; paleta de comandos (Ctrl K).
- Revisión visual de Tasks, Booking y Food cuando existan sus shells.

## Bloqueos y peticiones

- Ver `docs/core/PETICIONES.md`: script `test:ui-kit` en la raíz y carpeta `tests/ui-kit` en la CI (hoy las pruebas viven en `packages/ui-kit/tests` y se lanzan con `npm -w @ikisai/ui-kit run test:e2e`). Ubicación de este `ESTADO.md` (`docs/ui-kit/` o aquí).
