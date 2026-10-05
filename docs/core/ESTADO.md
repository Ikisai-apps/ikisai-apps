# Core · estado

Actualizado: 6 de octubre de 2026 (fase 0 en curso).

## Hecho

- Repositorio `Ikisai-apps/ikisai-apps` creado (privado), `main` protegida pendiente de configurar.
- Migración `20261006_0001_core_base.sql`: apps, profiles, memberships, app_state, synced_tables, allowed_procedures, validate_hooks, code_sequences, changes, receipts; `core.commit` fila a fila con recibos y 409; snapshot, changes_since, history, undo_plan, purge_deleted, purge_row_history, set_membership, next_code; wrappers `public.core_*` solo para `service_role`.
- Migración `20261006_0003_core_files.sql`: registro de archivos y tickets de subida.
- Migración `20261006_0002_invoices_suppliers.sql`: app `invoices` y tabla `invoices.suppliers` registrada.
- `supabase/functions/_kit`: errores, acceso a Supabase, autenticación con sesión activa, rutas del núcleo, subidas con URL firmada y verificación, handler con CORS y rutas por app.
- `supabase/functions/invoices-api`: primera consumidora del kit, con validación de dominio para proveedores.
- `packages/test-kit`: PGlite con stubs de Auth, Supabase simulado (PostgREST, Auth, Storage) y suite de conformidad de 13 escenarios.
- `scripts/lint_migrations.mjs`: nombre, un schema por archivo, registro obligatorio.

## En curso

- `packages/sync-client` (agente delegado).
- `scripts/` de despliegue y workflows (agente delegado).
- `apps/invoices` esqueleto Vite + PWA.

## Pendiente de la fase 0

- Aplicar migraciones al proyecto Supabase y desplegar `invoices-api`.
- Crear buckets `purchase-documents`, `kitchen-media`, `booking-documents`.
- Ampliar la allow-list de Auth a los cuatro dominios.
- Publicar `invoices.ikisai.com` con login real y verificar `/version.json` y `/api/v1/health`.
- Secretos de Actions en el repo nuevo y backup cifrado.
- Proteger `main` (PR + CI).

## Decisiones técnicas tomadas en la implementación

- Las visibilidad por ámbitos se aplica en la Edge mediante el hook `visible` de cada app; PostgreSQL devuelve filas por rol de tabla.
- Cada petición autenticada hace tres viajes a Supabase (usuario, sesión activa, bootstrap). Aceptable en V1; optimizable con caché corta por token.
- Los archivos viven en `core.files` (registro común) y las tablas de app los referencian por `file_id`.
- La respuesta perdida tras un commit devuelve 503 `BACKEND_UNAVAILABLE`; el reintento con el mismo `requestId` devuelve el recibo.
