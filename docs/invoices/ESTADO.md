# Invoices · estado

Actualizado: 6 de octubre de 2026. Equipo Invoices (agente de backend). Worktree `ikisai-apps-invoices`.

## Hecho

- `docs/invoices/API.md` (G2) revisión 2, cotejado con el handoff V3: schema `ikisai.invoice.v1` exacto, nombre canónico `AAAA_MM_DD_(empresa)_objeto[_pNN][_NN].ext`, estados `pendiente_datos / pendiente_revision / validada / archivada / anulada`, asignación por línea con destinos `area/project/task`, `reservation/event`, `ingredient/equipment`, `general`, ZIP `IKISAI_COMPRAS_AAAA_TN/` con `facturas/`, tres CSV y `manifest.json` sin cerrar registros. Aprobado de forma provisional por Core.
- `docs/invoices/PETICIONES.md` con las peticiones resueltas y las abiertas (fase 2).

## En curso

- PR `invoices/api-doc` (#2) rebasada sobre `main`; se fusiona con CI verde.
- Siguiente: `supabase/functions/_domain/invoices` (tipos, schema, recalculo, nombre canónico), migración `*_invoices_model.sql`, `import_v1`, rutas y pantallas.

## Pendiente

- Lectura `tasks.targets` por parte de Tasks (puente: `snapshot` de `tasks-api` con el token del usuario).
- Fase 2: proyecciones de Booking y Food para destinos; `imports/extract`.

## Bloqueos

- Ninguno.
