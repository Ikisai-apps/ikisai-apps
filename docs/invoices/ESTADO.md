# Invoices · estado

Actualizado: 6 de octubre de 2026 (tanda 6). Equipo Invoices (agente de backend). Worktree `ikisai-apps-invoices`.

## Hecho

- `docs/invoices/API.md` (G2) revisión 2, cotejado con el handoff V3: schema `ikisai.invoice.v1` exacto, nombre canónico `AAAA_MM_DD_(empresa)_objeto[_pNN][_NN].ext`, estados `pendiente_datos / pendiente_revision / validada / archivada / anulada`, asignación por línea con destinos `area/project/task`, `reservation/event`, `ingredient/equipment`, `general`, ZIP `IKISAI_COMPRAS_AAAA_TN/` con `facturas/`, tres CSV y `manifest.json` sin cerrar registros. Aprobado de forma provisional por Core.
- `docs/invoices/PETICIONES.md` con las peticiones resueltas y las abiertas (fase 2).

- PR #2 (API.md) y PR #26 (dominio compartido `_domain/invoices`: schema `ikisai.invoice.v1`, recálculo con tolerancia, nombre canónico, validación de campos, resúmenes; 10 pruebas) fusionadas.
- Migraciones `20261006_0200_invoices_model.sql` (tablas, triggers de bloqueo y nombre canónico, proyecciones para Booking y Food) y `20261006_0201_invoices_rules.sql` (recálculo SQL, hook `check_invariants`, `import_v1`, `validate`, `annul`, `create_export`, `mark_delivered`, `archive_period`, lecturas `fiscal_summary`, `items`, `export_bundle`, `export_preview`) con 8 pruebas contra PGlite a través de `invoices-api` (paridad con el dominio TS).

- PR #33 (migraciones) fusionada.
- Edge `invoices-api` completa (PR #37): `beforeCommit` con el dominio compartido, documentos comprobados en `core.files`, destinos `tasks` validados con el token del usuario contra `read/tasks.targets`, destinos `food` por las proyecciones de Food, `booking` deshabilitado hasta fase 2; rutas `dashboard`, `imports/preview`, `targets/*`, `exports/accountant`, `exports/:id/{manifest.json,*.csv,download}` (ZIP «store» en streaming con escritor propio). 8 pruebas (`tests/invoices/api.test.ts`).
- Pantallas sobre `@ikisai/ui-kit` (PR #37): **Inicio** (tarjetas de estado, trimestre, «Nueva factura»), **Facturas** (lista por mes con filtros; ficha en hoja con documento, artículos, impuestos, asignación por línea, pago, fiscal, importación; alta con documento y vista previa del nombre canónico; importar JSON con cuadre; validar, anular, archivar), **Compras** (por categoría, destino, proveedor o artículos; periodo; «solo validadas»; totales), **Gestoría** (resumen fiscal, alertas, entregas con ZIP/manifest/CSV, preparar entrega, marcar entregada, archivar periodo). Todo calculado en local con el dominio compartido; hoja de asignación con destinos de Tareas y Cocina (buscador con red, recientes sin red) y generales.
- `tests/invoices/fake-api.ts` ampliada (todas las tablas, recálculo y procedimientos mínimos) y `smoke.spec.ts` con factura a mano, Compras, Gestoría e Inicio.

- PR #37 fusionada y publicada en `invoices.ikisai.com` (`v0.1.0-build.47`).
- Tanda 2 (`invoices/aceptacion`): `tests/invoices/acceptance.spec.ts` automatiza el recorrido A1–A13 y A18 (documento con nombre canónico y lectura firmada, importación del ejemplo del handoff con proveedor por NIF, cuadre y REVISAR IMPORTES, validar y editar tras validar, asignación a Tareas y Cocina con el token del usuario, sobreasignación, Compras, Gestoría, anulación) y los escenarios offline O1–O6 (cola con PDF y JSON, recarga sin red, reconexión con subida y verificación, fusión de campos disjuntos, conflicto solapado, destino desaparecido → rechazado, subida que no verifica). La API falsa de Playwright reproduce la superficie de `invoices-api` (subidas, destinos, `import_v1`, `validate`, `annul`, hook de estados).
- La importación desde la app se envía como operaciones de fila (`importOperations` del dominio) para que funcione sin red con espejo optimista; `invoices.import_v1` queda para la API.
- Proveedores: formulario con alias e «inversión por defecto». Compras y ficha: indicador de obsolescencia de destinos («destino cambiado / desaparecido») comparando revisiones con red.

- PR #53 fusionada. Humo real de Core contra `invoices.ikisai.com` (importación del ejemplo y ZIP): 10 de 10.
- Tanda 3 (`invoices/tanda3`): escenarios O7–O9 (Compras y resumen fiscal idénticos sin red tras recargar; `reader` solo lee, también sin red, sin botones de escritura; cerrar sesión vacía el espejo), filtros de Compras por destino (retiro, ingrediente, maquinaria, proyecto…), tipo de artículo y «solo sin asignar»; `[hidden]` fuerza `display:none` sobre las clases del kit.

- PR #68 fusionada.
- Tanda 4 (`invoices/tanda4`): prompt de extracción para ChatGPT copiable dentro de «Importar JSON» (`_domain/invoices/extraction-prompt.ts`, con el schema resumido y un ejemplo, porque quien lo pega no tiene el archivo del handoff); capturas a 390 px y 1440 px con `tests/invoices/shots.ts` (`npx tsx tests/invoices/shots.ts`, salida en `App/capturas-invoices-2026-10-06`) y ajustes: pestañas cortas en Compras, casillas sin estirar, hueco para el botón flotante, chip «Desde JSON», el aviso «se sincronizará cuando haya red» solo sin red.

- PR #72 (tanda 4) fusionada.
- Tanda 5 (`invoices/tanda5`): contrato e implementación de `POST imports/extract` (extracción automática V2; llama al helper `extractInvoice` de `_kit` cuando Core lo publique, mientras tanto `EXTRACTION_UNAVAILABLE 503`; documento validado contra el schema; pruebas con un extractor simulado), botones «Extraer» en la factura pendiente de datos y «Extraer pendientes» en Facturas que llevan el resultado a la vista previa de importación; medida de `loadMirror` con 500 facturas sintéticas (`tests/invoices/perf.ts`) y agrupación de las recargas del espejo.

- PR #79 (tanda 5) fusionada.
- Tanda 6 (`invoices/tanda6`): destinos de Reservas activos en la hoja de asignación (buscador «Reservas (eventos: retiros)» contra `targets/booking`, que lee `booking.food_event_projection` registrada para `invoices` por la migración 0402 de Booking, PR #80); ajuste de `tests/invoices/api.test.ts` empujado a la rama de Booking a petición de Core.

## En curso

- PR de la tanda 6 (`invoices/tanda6`).

## Pendiente

- Aceptación manual en Android: la hace el usuario con facturas reales del negocio; sus incidencias llegan por el buzón de Core.
- Extracción automática: conectar el helper `extractInvoice` de `_kit` en `index.ts` cuando Core avise (la ruta, los botones y las pruebas ya están).
- Fase 2: destinos de Booking (`core.allow_read('invoices', 'booking.food_event_projection', 'view')`), `imports/extract`.
- Humo real contra `invoices-api` publicada tras la fusión (lo publica Core).

## Bloqueos

- Ninguno.
