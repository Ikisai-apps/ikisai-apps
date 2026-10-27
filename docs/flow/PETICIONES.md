# Flow · peticiones a Core

Peticiones del equipo Flow sobre lo compartido (`core`, `_kit`, `sync-client`, `test-kit`, raíz, CI) y, a través de Core, a otros equipos. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Nº | Fecha | Petición | Estado | Respuesta |
|---|---|---|---|---|
| P1 | 2026-10-26 | `runConformance` sin tabla de muestra, para una app recién dada de alta y todavía sin modelo de datos | En curso | 26-10-2026: va en la PR compartida de Core (`core/alta-flow`). Con la primera tabla, suite completa. |
| P2 | 2026-10-26 | Alta de `flow` en `core.apps` (lanzador), `scripts/apps.py`, CI y rango de migraciones 0900–0999 | En curso | 26-10-2026: PR compartida de Core (`0093_core_flow_app`, sort 45, sin bucket). |

## Huecos del servicio del sábado (prueba de extremo a extremo, `tests/flow/servicio-sabado.test.ts`, 27-10)

La prueba recorre el servicio con las Edges reales de Flow, Food, Finance y Booking sobre la misma base. Lo que salió y a quién le toca:

| Nº | Hueco | A quién | Estado |
|---|---|---|---|
| S1 | `create_flow` desde la plantilla `barra` en un evento nuevo creaba una v1: sin cuentas, caja profunda, «Dar por hecho y entregar», fresco ni el puesto «Pan». | Flow | Hecho en la 0920: la versión nunca queda por debajo de la de la plantilla, se siembra `barra` v2 y se añaden las unidades de plantilla. |
| S2 | Flow no ofrecía nada en el catálogo de capacidades. | Flow | Hecho en la 0920: `flow.day_summary` (lectura, owner) y `flow.logistics_task` (crear tarea de Logística, idempotente). |
| S3 | La carta de Food necesita su previsión de unidades por línea (`expected_units`) antes de «Generar tareas de ingredientes». Sin ella las cantidades salen a 0 y no se crean puntos de existencias. La semilla de la carta de octubre la trae a 0. | Food (y quien prepare el evento) | Aviso para el sábado: poner la previsión en Food antes de generar. Flow ya avisa con «Sin cantidad (revisar en Food)». |
| S4 | Recorrido completo en verde: Booking (evento y huéspedes) → «Nuevo flujo» barra v2 → carta y previsión de Food → ingredientes con recipientes y fresco → pedido público y de visitante (enlace de un solo uso) → caja (metálico, unificado, cuenta) → «Dar por hecho y entregar» → reposición en recipientes → justificante fiscal a Finance → cierre a Food y a Finance como proceso sin el fiscal → números de huésped → check-in con la llegada en Booking → capacidades de Flow. | — | `run_tests flow`: 103 de 103. |
