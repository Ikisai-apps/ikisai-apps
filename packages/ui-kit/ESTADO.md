# UI kit · estado

Actualizado: 6 de octubre de 2026. Agente UI, rama `ui/kit`, directorio `packages/ui-kit`.

## Hecho

- v0.2.1: separador en `.row-meta`.
- v0.2.0 fusionada en main (PR #17): hoja inferior y diálogo con foco atrapado, conflicto campo a campo sobre `PendingConflict`, rechazados sobre `RejectedBatch`, barra y banners con `rejected` y `USER_CHANGED` (sync-client 0.2), lista «pendiente» como componente, selector de tema y paleta Ctrl K. 22 pruebas Playwright.
- v0.1.0 fusionada en main (PR #4). v0.1.1 fusionada con la adopción de Invoices (PR #5).
- v0.1.0: tokens, base, componentes CSS, DOM e iconos, tema y acento, barra de estado (§6.4), login y shell, demo y pruebas Playwright (5 escenarios × 2 tamaños). Tipos en verde con el `tsconfig` raíz.

## En curso

- Invoices: segunda adopción (hoja de proveedores con `openSheet`, pantalla de conflictos con `renderConflicts`, rechazados, `confirmDialog` en cerrar sesión y papelera, importación del CSS por alias). PR a `apps/invoices` con visto bueno de Core.

## Pendiente

- Revisión visual de Tasks, Booking y Food cuando existan sus shells; componentes que pidan (calendario, cantidades, fotos recomprimidas).
- v0.3 candidatos: campo de fecha con atajos (hoy, mañana), selector de etiquetas con familias, tarjeta de proyecto con anillo de progreso (de Tareas), esqueleto de página completa.

## Bloqueos y peticiones

- Ver `docs/core/PETICIONES.md`: script `test:ui-kit` en la raíz y carpeta `tests/ui-kit` en la CI (hoy las pruebas viven en `packages/ui-kit/tests` y se lanzan con `npm -w @ikisai/ui-kit run test:e2e`). Ubicación de este `ESTADO.md` (`docs/ui-kit/` o aquí).
