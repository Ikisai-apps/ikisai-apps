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
- Publicado **invoices.ikisai.com** `v0.1.0-rc.2` (6 de octubre, con el ui-kit; antes `v0.1.0-rc.1`): función `invoices-api`, proyecto Pages `ikisai-invoices`, CNAME y certificado activos; `/version.json` y `/api/v1/health` coinciden. Humo real contra la API: 16/16.
- Secretos de Actions cargados en el repo nuevo (Supabase, Cloudflare, clave de backup nueva).
- **Extracción de documentos con modelo de visión** (`_kit/extract.ts`, contrato §5.5): helper `createDocumentExtractor` sobre el SDK oficial de Anthropic (`claude-opus-5-5`, prompt con caché, salida estructurada opcional, fallback en servidor ante rechazos), con errores del núcleo y 7 pruebas con transporte simulado (`tests/core/extract.test.ts`). Deno resuelve el SDK con `supabase/functions/import_map.json` (`import_map_path` en el despliegue). `scripts/set_edge_secrets.py` carga secretos de la Edge desde archivos de `private/`. Pendiente: que el usuario deje la clave en `private/anthropic-api-key.txt` → `ANTHROPIC_API_KEY`, e Invoices conecte el helper en `invoices-api/index.ts`.

## Equipos

- UI: `packages/ui-kit/ESTADO.md` (0.1.0 publicado; Invoices lo adopta desde la PR #5).

## Pendiente (fase 1 y siguientes)

- `checks.yml` ya corre en PR (#6, #7, #8 en verde). Pendiente el primer run de `backup.yml` y la restauración real del backup (hoy solo plan).
- **Releases automáticas desde GitHub Actions fallan desde el 6 de octubre**: la Management API de Supabase devuelve 500 «FGA Authentication Error» a los runners (EE. UU. Este) en `/database/migrations` y `/database/query`, mientras el mismo token funciona desde España. Se añadieron reintentos con espera creciente (#7, #8) sin efecto. Mientras dure, Core publica desde su PC con `release_cloud.py --apply`. Revisar en unos días; si persiste, abrir incidencia a Supabase o mover la release a un runner propio.
- Equipos de app: `docs/<app>/API.md` (G2) antes de código.
- Retirar la función QA `invoices-api-qa` cuando deje de usarse.
- Optimizar los tres viajes por petición (caché corta de identidad).

## Decisiones técnicas tomadas en la implementación

- Las visibilidad por ámbitos se aplica en la Edge mediante el hook `visible` de cada app; PostgreSQL devuelve filas por rol de tabla.
- Cada petición autenticada hace tres viajes a Supabase (usuario, sesión activa, bootstrap). Aceptable en V1; optimizable con caché corta por token.
- Los archivos viven en `core.files` (registro común) y las tablas de app los referencian por `file_id`.
- La respuesta perdida tras un commit devuelve 503 `BACKEND_UNAVAILABLE`; el reintento con el mismo `requestId` devuelve el recibo.
