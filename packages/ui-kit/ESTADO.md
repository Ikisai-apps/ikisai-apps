# UI kit · estado

Actualizado: 6 de octubre de 2026. Agente UI, rama `ui/kit`, directorio `packages/ui-kit`.

## Hecho

- v0.7.0 (tanda 8): selector de etiquetas con familias (`createLabelPicker`, `labelChips`) y tarjeta de proyecto con anillo (`renderProjectCard`, `ringSvg`).
- v0.6.1: la marca «BORRADOR» ya no desplaza la cabecera de la página imprimible.
- v0.6.0 (tanda 7): lista reordenable con arrastre, botones y teclado (`createSortableList`, `positionBetween`) y campo de fecha con atajos (`createDateField`).
- v0.5.0 (tanda 6): página completa imprimible A4 con print CSS, orientada a la vista del organizador de Food y reutilizable por Invoices.
- v0.4.1 (tanda 5): toast sobre la hoja en móvil corregido; snippet de la paleta Ctrl K en el README.
- v0.4.0 (tanda 4): hoja de importación con previsualización de JSON y cuadre de totales (para Invoices, sin tocar `apps/invoices`); revisión visual de `apps/food` y de la ficha de reserva de Booking.
- v0.3.0 (tanda 3): `compressImage` (WebP 1600 px + miniatura 480 px, con prueba), calendario mensual y semanal accesible, campo de cantidad con unidad. 28 pruebas Playwright.
- v0.2.1: separador en `.row-meta`.
- v0.2.0 fusionada en main (PR #17): hoja inferior y diálogo con foco atrapado, conflicto campo a campo sobre `PendingConflict`, rechazados sobre `RejectedBatch`, barra y banners con `rejected` y `USER_CHANGED` (sync-client 0.2), lista «pendiente» como componente, selector de tema y paleta Ctrl K. 22 pruebas Playwright.
- v0.1.0 fusionada en main (PR #4). v0.1.1 fusionada con la adopción de Invoices (PR #5).
- v0.1.0: tokens, base, componentes CSS, DOM e iconos, tema y acento, barra de estado (§6.4), login y shell, demo y pruebas Playwright (5 escenarios × 2 tamaños). Tipos en verde con el `tsconfig` raíz.

## En curso

- Adopción de `openImportSheet` por Invoices cuando su equipo lo decida (hoy tienen su propia hoja en `invoices.ts`; el kit replica su comportamiento y permite inyectar proveedor, categoría y avisos de duplicado).

## Pendiente

- Revisión visual de `apps/tasks` cuando su `ESTADO.md` diga que los escenarios portados están en verde (indicación de Core); componentes que pidan los equipos.
- Pendiente de Core: revisión visual de `apps/tasks` y adopción del kit módulo a módulo cuando su equipo termine el recorrido manual. Candidatos: calendario con horas (si Booking lo necesita).

## Bloqueos y peticiones

- Ver `docs/core/PETICIONES.md`: script `test:ui-kit` en la raíz y carpeta `tests/ui-kit` en la CI (hoy las pruebas viven en `packages/ui-kit/tests` y se lanzan con `npm -w @ikisai/ui-kit run test:e2e`). Ubicación de este `ESTADO.md` (`docs/ui-kit/` o aquí).
