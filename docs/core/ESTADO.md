# Core · estado

Actualizado: 6 de octubre de 2026. **Puerta G1 cerrada: núcleo funcionando y primera app publicada.**

## Hecho

- Repositorio `Ikisai-apps/ikisai-apps` creado (privado). La protección de rama no está disponible en el plan gratuito de la organización para repos privados: la regla «solo PR con CI verde a `main`» es de convivencia (`AGENTS.md`) y la vigila Core.
- Migración `20261006_0001_core_base.sql`: apps, profiles, memberships, app_state, synced_tables, allowed_procedures, validate_hooks, code_sequences, changes, receipts; `core.commit` fila a fila con recibos y 409; snapshot, changes_since, history, undo_plan, purge_deleted, purge_row_history, set_membership, next_code; wrappers `public.core_*` solo para `service_role`.
- Migración `20261006_0003_core_files.sql`: registro de archivos y tickets de subida.
- Migración `20261006_0002_invoices_suppliers.sql`: app `invoices` y tabla `invoices.suppliers` registrada.
- `supabase/functions/_kit`: errores, acceso a Supabase, autenticación con sesión activa, rutas del núcleo, subidas con URL firmada y verificación, handler con CORS y rutas por app.
- `supabase/functions/invoices-api`: primera consumidora del kit, con validación de dominio para proveedores.
- `packages/test-kit`: PGlite con stubs de Auth, Supabase simulado (PostgREST, Auth, Storage) y suite de conformidad de 13 escenarios.
- `scripts/lint_migrations.mjs`: nombre, un schema por archivo, registro obligatorio.

- `packages/sync-client`: cliente offline compartido, 22 pruebas.
- `scripts/`: despliegue por app (schema, función con `_kit`, Pages, auth, storage, owner, release), backup cifrado; workflows `checks`, `release`, `backup`.
- `apps/invoices`: esqueleto PWA (login, shell, proveedores offline, conflictos, SW coordinado) con prueba Playwright.
- Supabase real: migraciones aplicadas (`core`, `invoices`; `ikisai.*` intacto), buckets `purchase-documents`, `kitchen-media`, `booking-documents`, Auth con los cuatro dominios, owner de Invoices dado de alta.
- Publicado **invoices.ikisai.com** `v0.1.0-rc.1`: función `invoices-api`, proyecto Pages `ikisai-invoices`, CNAME y certificado activos; `/version.json` y `/api/v1/health` coinciden. Humo real contra la API: 16/16.
- Secretos de Actions cargados en el repo nuevo (Supabase, Cloudflare, clave de backup nueva).

## Pendiente (fase 1 y siguientes)

- Primer run real de `checks.yml` en una PR y de `backup.yml`; restauración real del backup (hoy solo plan).
- Equipos de app: `docs/<app>/API.md` (G2) antes de código.
- Retirar la función QA `invoices-api-qa` cuando deje de usarse.
- Optimizar los tres viajes por petición (caché corta de identidad).

## Decisiones técnicas tomadas en la implementación

- Las visibilidad por ámbitos se aplica en la Edge mediante el hook `visible` de cada app; PostgreSQL devuelve filas por rol de tabla.
- Cada petición autenticada hace tres viajes a Supabase (usuario, sesión activa, bootstrap). Aceptable en V1; optimizable con caché corta por token.
- Los archivos viven en `core.files` (registro común) y las tablas de app los referencian por `file_id`.
- La respuesta perdida tras un commit devuelve 503 `BACKEND_UNAVAILABLE`; el reintento con el mismo `requestId` devuelve el recibo.
