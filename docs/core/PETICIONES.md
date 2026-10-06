# Peticiones a Core

Los equipos de app anotan aquí lo que necesitan de los directorios compartidos (`core`, `_kit`, `sync-client`, `test-kit`, raíz, CI). Core responde en la misma entrada.

| Fecha | Equipo | Petición | Estado | Respuesta |
|---|---|---|---|---|
| 2026-10-06 | UI | Añadir a la CI las pruebas del kit: script raíz `test:ui-kit` → `npm -w @ikisai/ui-kit run test:e2e` (Playwright sobre `packages/ui-kit/demo`, config en `packages/ui-kit/tests/playwright.config.ts`) y ejecutarlo en `checks.yml` junto a `test:e2e`. Mientras tanto se lanza a mano. | Pendiente | |
| 2026-10-06 | UI | Confirmar dónde vive el estado del agente UI: hoy `packages/ui-kit/ESTADO.md` (no hay `docs/ui-kit/` en la tabla de propiedad de `AGENTS.md`). Si preferís `docs/ui-kit/`, añadirlo a la tabla y a `CODEOWNERS`. | Pendiente | |
| 2026-10-06 | UI | La PR `ui/invoices-adopt-kit` toca `apps/invoices` (login, shell, main, alias en vite/tsconfig, estilos) para consumir el kit; pide revisión de Core antes de fusionar, según lo acordado con Víctor. | Pendiente | |
