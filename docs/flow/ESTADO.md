# Flow · estado

App interna nueva (`flow.ikisai.com`, Pages `ikisai-flow`, Edge `flow-api`, schema `flow` con migraciones en 0900–0999). Alta en el registro común: PR compartida de Core (`core/alta-flow`, migración `0093_core_flow_app`).

## Hecho

- 2026-10-26 · **Arranque (primer incremento, sin modelo de datos)**, para validar el despliegue:
  - `flow-api` sobre el `_kit` (`createApp`), sin tablas, rutas propias ni subidas. Orígenes `https://flow.ikisai.com` y `https://ikisai-flow.pages.dev`.
  - `_domain/flow` (`APP`, `TABLES` vacío) y `packages/domain-flow`, que lo reexporta.
  - `apps/flow` (PWA): login del kit, cáscara común con el menú lateral (MUELA-013) y el lanzador de apps dentro, «Sugerencias y QA» y revisor, «‹ Volver a…» (`returnTo`, K9), barra de estado, Inicio «en preparación», service worker con actualización coordinada y `_worker.js` hacia `flow-api`. El icono es provisional.
  - Pruebas: `tests/flow/conformance.test.ts` (`runConformance` sin tabla, con la opción que añade Core), `tests/flow/api.test.ts` (health, bootstrap sin tablas, nada que escribir, sin subidas) y `tests/flow/shell.spec.ts` (Playwright contra la `flow-api` real sobre PGlite: login erróneo, Inicio, menú, cierre de sesión y «Volver a…»).

## Pendiente

- Rebasar sobre `main` cuando Core fusione la PR compartida (registro, CI, rango 0900, `core.apps` y la opción sin tabla de `runConformance`). Hasta entonces, `tests/flow` falla en `main` porque `flow` no está en `core.apps`.
- Primera release y dominio (`release_cloud.py --app flow --bind-domain`) y propietario inicial (`initialize_app_owner.py`). Los hace Core.
- `docs/flow/API.md` (puerta G2): propuesta del 26-10-2026, en revisión por Core. Sin su visto bueno no hay migraciones ni rutas propias.
- Con la primera tabla sincronizable, `runConformance` completo (`table`, `fieldA`, `fieldB` y `required`).
- Icono y color de marca propios de Flow (hoy, los de Central con un dibujo provisional).

## Preguntas abiertas

El documento funcional V1 de VG ya está (canon V1, fuera del repo). Las preguntas de modelo, roles, imágenes y refresco entre móviles están en `docs/flow/API.md` §13 (P-1 a P-5), pendientes de la revisión de Core.

## Bloqueos

- Ninguno para este incremento. Lo demás espera al documento funcional (preguntas de arriba).
