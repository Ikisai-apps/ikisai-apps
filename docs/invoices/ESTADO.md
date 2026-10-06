# Invoices · estado

Actualizado: 6 de octubre de 2026 (noche). Equipo Invoices (agente de backend). Worktree `ikisai-apps-invoices`.

## Hecho

- `docs/invoices/API.md` (G2) revisión 2, cotejado con el handoff V3: schema `ikisai.invoice.v1` exacto, nombre canónico `AAAA_MM_DD_(empresa)_objeto[_pNN][_NN].ext`, estados `pendiente_datos / pendiente_revision / validada / archivada / anulada`, asignación por línea con destinos `area/project/task`, `reservation/event`, `ingredient/equipment`, `general`, ZIP `IKISAI_COMPRAS_AAAA_TN/` con `facturas/`, tres CSV y `manifest.json` sin cerrar registros. Aprobado de forma provisional por Core.
- `docs/invoices/PETICIONES.md` con las peticiones resueltas y las abiertas (fase 2).

- PR #2 (API.md) y PR #26 (dominio compartido `_domain/invoices`: schema `ikisai.invoice.v1`, recálculo con tolerancia, nombre canónico, validación de campos, resúmenes; 10 pruebas) fusionadas.
- Migraciones `20261006_0200_invoices_model.sql` (tablas, triggers de bloqueo y nombre canónico, proyecciones para Booking y Food) y `20261006_0201_invoices_rules.sql` (recálculo SQL, hook `check_invariants`, `import_v1`, `validate`, `annul`, `create_export`, `mark_delivered`, `archive_period`, lecturas `fiscal_summary`, `items`, `export_bundle`, `export_preview`) con 8 pruebas contra PGlite a través de `invoices-api` (paridad con el dominio TS).

- PR #33 (migraciones) fusionada.
- Edge `invoices-api` completa (PR #37): `beforeCommit` con el dominio compartido, documentos comprobados en `core.files`, destinos `tasks` validados con el token del usuario contra `read/tasks.targets`, destinos `food` por las proyecciones de Food, `booking` deshabilitado hasta fase 2; rutas `dashboard`, `imports/preview`, `targets/*`, `exports/accountant`, `exports/:id/{manifest.json,*.csv,download}` (ZIP «store» en streaming con escritor propio). 8 pruebas (`tests/invoices/api.test.ts`).
- Pantallas sobre `@ikisai/ui-kit` (PR #37): **Inicio** (tarjetas de estado, trimestre, «Nueva factura»), **Facturas** (lista por mes con filtros; ficha en hoja con documento, artículos, impuestos, asignación por línea, pago, fiscal, importación; alta con documento y vista previa del nombre canónico; importar JSON con cuadre; validar, anular, archivar), **Compras** (por categoría, destino, proveedor o artículos; periodo; «solo validadas»; totales), **Gestoría** (resumen fiscal, alertas, entregas con ZIP/manifest/CSV, preparar entrega, marcar entregada, archivar periodo). Todo calculado en local con el dominio compartido; hoja de asignación con destinos de Tareas y Cocina (buscador con red, recientes sin red) y generales.
- `tests/invoices/fake-api.ts` ampliada (todas las tablas, recálculo y procedimientos mínimos) y `smoke.spec.ts` con factura a mano, Compras, Gestoría e Inicio.

## En curso

- PR #37 (`invoices/edge`): Edge + pantallas de la tanda. Pendiente de CI y fusión.

## Pendiente

- Aceptación A1–A21 con un PDF sintético contra la app publicada (PC y Android) y escenarios offline O1–O9 en Playwright (hoy: humo con factura a mano; falta la importación con JSON y archivos en la API falsa).
- Proveedores: formulario con `aliases` y `default_is_investment` (hoy solo se ven desde la importación).
- Compras: indicador de obsolescencia de destinos (§7.3) y filtros por retiro/ingrediente cuando lleguen esos destinos.
- Fase 2: destinos de Booking (`core.allow_read('invoices', 'booking.food_event_projection', 'view')`), `imports/extract`.
- Humo real contra `invoices-api` publicada tras la fusión (lo publica Core).

## Bloqueos

- Ninguno.
