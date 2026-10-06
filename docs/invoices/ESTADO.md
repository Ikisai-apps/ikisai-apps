# Invoices · estado

Actualizado: 6 de octubre de 2026 (tanda 3). Equipo Invoices (agente de backend). Worktree `ikisai-apps-invoices`.

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

## En curso

- PR de la tanda 3 (`invoices/tanda3`).

## Pendiente

- Aceptación manual sobre la app publicada en Android (instalación PWA, foto de ticket con la cámara, descarga del ZIP en el móvil). En PC los recorridos están automatizados; falta pasarlos sobre `invoices.ikisai.com` con una cuenta de prueba (ver pregunta en el buzón: las facturas no se purgan, así que los datos sintéticos de producción habría que anularlos o limpiarlos con `core.purge_row_history`).
- Destinos de Reservas en cuanto Booking registre `booking.food_event_projection` para `invoices` (la Edge y el filtro «Retiro» de Compras ya están preparados).
- Fase 2: destinos de Booking (`core.allow_read('invoices', 'booking.food_event_projection', 'view')`), `imports/extract`.
- Humo real contra `invoices-api` publicada tras la fusión (lo publica Core).

## Bloqueos

- Ninguno.
