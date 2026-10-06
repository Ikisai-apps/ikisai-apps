# UI kit · estado

Actualizado: 6 de octubre de 2026. Agente UI, rama `ui/kit`, directorio `packages/ui-kit`.

## Hecho

- v0.1.0 fusionada en main (PR #4). v0.1.1: texto «Todo sincronizado».
- v0.1.0: tokens, base, componentes CSS, DOM e iconos, tema y acento, barra de estado (§6.4), login y shell, demo y pruebas Playwright (5 escenarios × 2 tamaños). Tipos en verde con el `tsconfig` raíz.

## En curso

- PR `ui/invoices-adopt-kit` (pendiente de revisión de Core): `apps/invoices` consume tokens, login, shell, barra de estado, DOM, iconos y toast del kit; `tokens.css` y `login.ts` propios desaparecen y `app.css` queda vacío. Humo de Invoices y pruebas del kit en verde; capturas revisadas en móvil y escritorio, claro y oscuro.

## Pendiente

- v0.2: hoja inferior y diálogo con foco atrapado y cierre con Escape; componente de conflicto campo a campo; lista «pendiente de sincronizar» como componente; selector de tema para la cabecera; paleta de comandos (Ctrl K).
- Revisión visual de Tasks, Booking y Food cuando existan sus shells.

## Bloqueos y peticiones

- Ver `docs/core/PETICIONES.md`: script `test:ui-kit` en la raíz y carpeta `tests/ui-kit` en la CI (hoy las pruebas viven en `packages/ui-kit/tests` y se lanzan con `npm -w @ikisai/ui-kit run test:e2e`). Ubicación de este `ESTADO.md` (`docs/ui-kit/` o aquí).
