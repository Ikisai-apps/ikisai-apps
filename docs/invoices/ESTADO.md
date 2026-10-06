# Invoices · estado

Actualizado: 6 de octubre de 2026 (tarde). Equipo Invoices (agente de backend). Worktree `ikisai-apps-invoices`.

## Hecho

- `docs/invoices/API.md` (G2) revisión 2, cotejado con el handoff V3: schema `ikisai.invoice.v1` exacto, nombre canónico `AAAA_MM_DD_(empresa)_objeto[_pNN][_NN].ext`, estados `pendiente_datos / pendiente_revision / validada / archivada / anulada`, asignación por línea con destinos `area/project/task`, `reservation/event`, `ingredient/equipment`, `general`, ZIP `IKISAI_COMPRAS_AAAA_TN/` con `facturas/`, tres CSV y `manifest.json` sin cerrar registros. Aprobado de forma provisional por Core.
- `docs/invoices/PETICIONES.md` con las peticiones resueltas y las abiertas (fase 2).

- PR #2 (API.md) y PR #26 (dominio compartido `_domain/invoices`: schema `ikisai.invoice.v1`, recálculo con tolerancia, nombre canónico, validación de campos, resúmenes; 10 pruebas) fusionadas.
- Migraciones `20261006_0200_invoices_model.sql` (tablas, triggers de bloqueo y nombre canónico, proyecciones para Booking y Food) y `20261006_0201_invoices_rules.sql` (recálculo SQL, hook `check_invariants`, `import_v1`, `validate`, `annul`, `create_export`, `mark_delivered`, `archive_period`, lecturas `fiscal_summary`, `items`, `export_bundle`, `export_preview`) con 8 pruebas contra PGlite a través de `invoices-api` (paridad con el dominio TS).

## En curso

- PR `invoices/model` (migraciones). Siguiente: `beforeCommit` completo en `invoices-api` (archivos desde `core.files`, destinos de Tareas con `ctx.token`, rechazo de escrituras reservadas), rutas (`imports/preview`, `targets/tasks`, ZIP en streaming, CSV), y pantallas sobre `apps/invoices` con `@ikisai/ui-kit`.

## Pendiente

- Lectura `tasks.targets` por parte de Tasks (puente: `snapshot` de `tasks-api` con el token del usuario).
- Fase 2: proyecciones de Booking y Food para destinos; `imports/extract`.

## Bloqueos

- Ninguno.
