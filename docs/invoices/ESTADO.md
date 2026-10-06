# Invoices · estado

Actualizado: 6 de octubre de 2026. Equipo Invoices (agente de backend). Rama `invoices/api-doc`, worktree `ikisai-apps-invoices`.

## Hecho

- `docs/invoices/API.md` (puerta G2) redactado siguiendo la plantilla: modelo completo (`suppliers` ampliada, `invoices`, `invoice_files`, `invoice_lines`, `tax_lines`, `allocations`, `exports`, `export_items`), estados y bloqueos, periodo fiscal derivado, nombre canónico, procedimientos `import_v1`, `register`, `annul`, `create_export`, `mark_delivered`, hooks de validación, rutas propias, destinos tipados, resumen fiscal, ZIP de gestoría con manifest, pantallas, offline, aceptación (A1–A21, O1–O8) y reparto.
- Petición de revisión registrada en `docs/core/PETICIONES.md` con las siete peticiones concretas a Core (§12 del documento).

## Pendiente

- Revisión y aprobación de Core (G2). Hasta entonces no se crean migraciones ni rutas.
- Cotejar con el handoff V3 (`03_IKISAI_INVOICE_IMPORT_V1.schema.json`, `04_EJEMPLO…json`, `07_CHECKLIST_ACEPTACION.md` A): **no estaba en este PC** y la forma del JSON `ikisai.invoice.v1` del documento es una propuesta.
- Tras G2: migración `*_invoices_model.sql`, `packages/domain-invoices`, `beforeCommit` y rutas, pruebas de conformidad y dominio; frontend por verticales.

## Bloqueos

- Validación de destinos de Tareas desde `beforeCommit` necesita el bearer del usuario en `RequestContext` (petición a Core).
- Los `args` de un `call` que referencian un archivo necesitan el `file_id` verificado: se pide al `sync-client` la sustitución de marcadores `{"$blob": sha256}`.
- Ruta de resolución de destinos en la API de Tareas: a coordinar con el equipo Tasks.
