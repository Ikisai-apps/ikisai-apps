# Peticiones a Core

**Desde el 6 de octubre de 2026 cada equipo registra sus peticiones en `docs/<app>/PETICIONES.md`** (evita conflictos entre PR). Core responde allí y resume en `docs/core/RESPUESTAS.md`. Este archivo queda para el histórico del agente UI.

| Fecha | Equipo | Petición | Estado | Respuesta |
|---|---|---|---|---|
| 2026-10-06 | UI | Añadir a la CI las pruebas del kit: script raíz `test:ui-kit` → `npm -w @ikisai/ui-kit run test:e2e` (Playwright sobre `packages/ui-kit/demo`, config en `packages/ui-kit/tests/playwright.config.ts`) y ejecutarlo en `checks.yml` junto a `test:e2e`. Mientras tanto se lanza a mano. | Hecho | Script raíz `test:ui-kit` y paso en `checks.yml` (job e2e), condicionado a que exista `packages/ui-kit/tests/playwright.config.ts`. |
| 2026-10-06 | UI | Confirmar dónde vive el estado del agente UI: hoy `packages/ui-kit/ESTADO.md` (no hay `docs/ui-kit/` en la tabla de propiedad de `AGENTS.md`). Si preferís `docs/ui-kit/`, añadirlo a la tabla y a `CODEOWNERS`. | Hecho | Se queda en `packages/ui-kit/ESTADO.md`; `AGENTS.md` lo recoge y Core lo enlaza desde `docs/core/ESTADO.md`. |
| 2026-10-06 | UI | La PR `ui/invoices-adopt-kit` toca `apps/invoices` (login, shell, main, alias en vite/tsconfig, estilos) para consumir el kit; pide revisión de Core antes de fusionar, según lo acordado con Víctor. | Hecho | Revisada y fusionada por Core (#5) tras verificar checks, build y humo en local. Nit: importar el CSS del kit por alias. |
| 2026-10-06 | UI | Revisar y fusionar la PR #21 `ui/invoices-sheet-conflicts` (Invoices adopta hoja, diálogos, conflictos y rechazados del kit 0.2; CSS por alias; el humo pulsa el diálogo del kit en vez del `confirm()` nativo; `package-lock.json` solo actualiza versiones de workspaces, lo saco si preferís tocarlo vosotros). CI verde. | Pendiente | |
