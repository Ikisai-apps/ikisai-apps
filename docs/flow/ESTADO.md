# Flow · estado

App interna nueva (`flow.ikisai.com`, Pages `ikisai-flow`, Edge `flow-api`, schema `flow` con migraciones en 0900–0999). Alta en el registro común: PR compartida de Core (`core/alta-flow`, migración `0093_core_flow_app`).

## Hecho

- 2026-10-26 · **Arranque (primer incremento, sin modelo de datos)**, para validar el despliegue:
  - `flow-api` sobre el `_kit` (`createApp`), sin tablas, rutas propias ni subidas. Orígenes `https://flow.ikisai.com` y `https://ikisai-flow.pages.dev`.
  - `_domain/flow` (`APP`, `TABLES` vacío) y `packages/domain-flow`, que lo reexporta.
  - `apps/flow` (PWA): login del kit, cáscara común con el menú lateral (MUELA-013) y el lanzador de apps dentro, «Sugerencias y QA» y revisor, «‹ Volver a…» (`returnTo`, K9), barra de estado, Inicio «en preparación», service worker con actualización coordinada y `_worker.js` hacia `flow-api`. El icono es provisional.
  - Pruebas: `tests/flow/conformance.test.ts` (`runConformance` sin tabla, con la opción que añade Core), `tests/flow/api.test.ts` (health, bootstrap sin tablas, nada que escribir, sin subidas) y `tests/flow/shell.spec.ts` (Playwright contra la `flow-api` real sobre PGlite: login erróneo, Inicio, menú, cierre de sesión y «Volver a…»).

- 2026-10-26 · **Modelo y carta** (#707, publicada en `main`): migración `0900` (9 tablas, guarda, 6 procedimientos, semilla del §8), `GET public/menu` y la carta pública. Conformidad completa sobre `flow.projects`, y pruebas de los criterios §15.6–12, 14 y 18–21.
- 2026-10-26 · **FLOW-DIR-001** (rama `flow/caja`): migración `0901` (número de cliente, ampliaciones, entrega por cantidad, devoluciones pendientes, P-2, `image_key`); carta en `/` con «Enviar a barra» y «Soy el N»; personal en `/equipo` con Caja, Preparación, Servicio y Logística; fichas de pedido y de entrega compartidas; Inicio con las 4 guías; imágenes del Serrano.

## Pendiente

- Conectar `applyPublicOperations` cuando Core fusione la 0094 (#713). Hasta entonces, «Enviar a barra» responde que se enseñe el pedido en barra, y `tests/flow` no migra (la 0901 usa `core.allow_public_write` y `core.is_public_batch`).
- Playwright de la carta (envío y número), de caja→preparación→entrega y de varias sesiones a la vez (§15.13–16), con turno de Core.
- Modo servicio (FLOW-DIR-001 §7): Wake Lock con indicador, sonido o vibración opcionales.
- Imágenes del resto de productos cuando VG las tenga (`node apps/flow/scripts/assets.mjs <carpeta>` y una migración con sus `image_key`).
- Primera release y dominio (`release_cloud.py --app flow --bind-domain`) y propietario inicial (`initialize_app_owner.py`). Los hace Core.
- Con la primera tabla sincronizable, `runConformance` completo (`table`, `fieldA`, `fieldB` y `required`).
- Icono de la app (hoy, uno provisional de tres corrientes; el logo de Ikisai está en `public/guias/logo.webp`).

## Preguntas abiertas

El documento funcional V1 de VG ya está (canon V1, fuera del repo). Las preguntas de modelo, roles, imágenes y refresco entre móviles están en `docs/flow/API.md` §13 (P-1 a P-5), pendientes de la revisión de Core.

## Bloqueos

- Ninguno para este incremento. Lo demás espera al documento funcional (preguntas de arriba).
