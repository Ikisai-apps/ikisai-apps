# Ikisai Apps · Despliegue y operación

Scripts de `scripts/` (Python 3.12, sin dependencias salvo `cryptography` para el backup cifrado) y workflows de `.github/workflows/`. Todos los scripts funcionan en **modo plan por defecto**: solo leen y describen lo que harían. `--apply` ejecuta de verdad y, salvo en la CI de release, solo lo usa Core. Cada ejecución deja un informe JSON en `private/` (ignorado por Git). Ningún script imprime el cuerpo de error del proveedor: solo un código de dominio (`{"status":"error","code":"..."}`); sin credenciales devuelven `{"status":"invalid_configuration"}` y salida 1.

## Credenciales

| Dónde | Qué |
|---|---|
| CI (secretos del environment `production`) | `SUPABASE_ACCESS_TOKEN` (token `sbp_…` de la Management API), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_API_TOKEN`, `IKISAI_BACKUP_KEY` (32 bytes en base64, solo backup) |
| Local | `private/cloud-credentials.json`: `{"supabase":{"projectRef":"ctytaorylbninfyupfsn","projectUrl":"https://….supabase.co","accessToken":"sbp_…"},"cloudflare":{"accountId":"…","zoneId":"…","apiToken":"…","zone":"ikisai.com"}}` |

El entorno tiene prioridad sobre el archivo. `--credentials RUTA` apunta a otro archivo. El proyecto autorizado es siempre `ctytaorylbninfyupfsn` y la zona `ikisai.com`; la sección `cloudflare` ya no lleva `domain`: el dominio lo decide la app. La service key del proyecto (Auth Admin, Storage) nunca se guarda: se revela con `GET /api-keys?reveal=true` y vive solo en memoria del proceso.

## Registro de apps (`scripts/apps.py`)

Única fuente de verdad de lo que depende de la app. `python scripts/apps.py [app]` lo muestra.

| app | dominio | proyecto Pages | Edge slug | directorios | bucket |
|---|---|---|---|---|---|
| tasks | tasks.ikisai.com | ikisai-tasks | tasks-api | `apps/tasks`, `supabase/functions/tasks-api` | `ikisai-files` |
| invoices | invoices.ikisai.com | ikisai-invoices | invoices-api | `apps/invoices`, `supabase/functions/invoices-api` | `purchase-documents` |
| booking | booking.ikisai.com | ikisai-booking | booking-api | `apps/booking`, `supabase/functions/booking-api` | `booking-documents` |
| food | food.ikisai.com | ikisai-food | food-api | `apps/food`, `supabase/functions/food-api` | `kitchen-media` |

Límites de bucket: `purchase-documents` 52 428 800 bytes (PDF + webp/jpeg/png); resto 15 728 640; `kitchen-media` solo webp/jpeg/png.

## Scripts

### `deploy_supabase_schema.py [--apply]`
Ejecuta `node scripts/lint_migrations.mjs` (aborta con `MIGRATION_LINT_FAILED`), lee el historial `GET /database/migrations` y aplica en orden las pendientes de `supabase/migrations/*.sql` con nombre `<archivo>_<sha256[:12]>`.
- Las migraciones del antiguo `ikisai-tasks` (nombres que empiezan por `202610050`) se **ignoran**: no se tocan ni reescriben (`legacyMigrationsIgnored` en el informe).
- `APPLIED_MIGRATION_CHANGED`: una migración ya aplicada cambió de contenido. Las fusionadas en `main` son inmutables; crea otra.
- `EXISTING_SCHEMA_WITHOUT_OWNED_MIGRATION`: existe el schema `core` pero ninguna migración de este repo consta en el historial (proyecto desconocido; no se pisa).
- Tras aplicar verifica el historial y cuenta tablas, tablas con RLS y apps en `core.apps`. Informe: `private/supabase-schema-deployment.json`.

### `deploy_supabase_function.py --app <app> [--qa] [--apply]`
Una sola función con slug `<app>-api` (con `--qa`, `<app>-api-qa`) a partir de `supabase/functions/<app>-api/` **más** `supabase/functions/_kit/`. Cada archivo (`.ts`, `.js`, `.mjs`, `.json`, `.txt`; sin `node_modules`, `tests/`, `*.test.*`, `*.spec.*`) se sube con su ruta relativa a `supabase/functions/` (`invoices-api/index.ts`, `_kit/auth.ts`) y `entrypoint_path = <app>-api/index.ts`, por lo que los imports `../_kit/x.ts` funcionan. `verify_jwt: false` (la autenticación la hace `_kit` en cada ruta). Si `IKISAI_RELEASE` está definido sustituye en `index.ts` el literal `Deno.env.get('IKISAI_RELEASE') ?? 'development'` por la versión (`releaseInjected` en el informe). Si el proveedor rechaza el despliegue, su respuesta se guarda redactada en `private/edge-deployment-error-<slug>.txt`. Informe: `private/edge-deployment-<app>[-qa].json`.

### `deploy_cloudflare_pages.py --app <app> [--domain] [--apply]`
1. Usa `apps/<app>/dist`; si no existe ejecuta `npm run build --workspace apps/<app>` y, si falla, para con `FRONTEND_BUILD_FAILED` y la cola del log.
2. Copia a `private/pages-build/<app>`, escribe `version.json` (`release` = `IKISAI_RELEASE` o hash, `commit` = `GITHUB_SHA` o `git rev-parse HEAD`, `frontendHash`), `_headers` (nosniff, referrer, X-Frame-Options DENY, Permissions-Policy; `version.json`, `sw.js` e `index.html` sin caché) y `_worker.js`: el del dist si la app trae `public/_worker.js`, si no uno generado que reenvía solo `/api/v1/*` y `/health` a `…/functions/v1/<app>-api`, rechaza orígenes cruzados (`ORIGIN_REJECTED`) y sirve el resto como estático. Si existe `sw.js`, actualiza su nombre de caché `ikisai-shell-<hash>`.
3. Con `--apply`: proyecto Pages `ikisai-<app>` (lo crea si falta, rama de producción `main`), sube solo los assets que faltan (`check-missing` → `upload` en lotes de 50 → `upsert-hashes`) con MIME correcto (`.js/.mjs` → `application/javascript`, `.woff2` → `font/woff2`, `.webmanifest` → `application/manifest+json`, `.wasm` → `application/wasm`) y crea el deployment.
4. Con `--domain` (requiere `zoneId`): añade el dominio `<app>.ikisai.com` al proyecto y un CNAME proxied a `ikisai-<app>.pages.dev`. Si ya hay registros DNS para ese nombre y no son exactamente ese CNAME, aborta con `EXISTING_DOMAIN_RECORD_NO_OVERWRITE`.
En modo plan también se valida la configuración de Cloudflare (sin llamadas). Informe: `private/pages-deployment-<app>.json`.

### `configure_supabase_auth.py [--apply]`
`site_url = https://tasks.ikisai.com`, `uri_allow_list` con `https://<app>.ikisai.com/**` de las cuatro apps y `disable_signup: true`. Muestra el estado actual (`before`) y, tras aplicar, verifica (`AUTH_CONFIG_UNVERIFIED` si no coincide). Informe: `private/auth-configuration.json`.

### `configure_supabase_storage.py --bucket <nombre> [--apply]`
Crea el bucket **privado** si no existe con el límite y los tipos de `apps.py`; si existe y es público aborta (`EXISTING_PUBLIC_BUCKET_NO_CHANGE`); si existe privado con otro límite/tipos informa el `drift` y con `--apply` lo ajusta (nunca lo hace público). Informe: `private/storage-configuration-<bucket>.json`.

### `initialize_app_owner.py --app <app> --email <email> [--apply]`
Busca el usuario en `auth.users` (consulta de solo lectura por la Management API). Requiere que la app esté en `core.apps` (lo hacen las migraciones; si no, `APP_NOT_FOUND`). Con `--apply`: si el usuario no existe lo crea con la Auth Admin API (`email_confirm: true`) y una contraseña aleatoria que se guarda **solo** en `private/owner-<app>.json` (modo 0600; entrégala por un canal privado y pide cambiarla). Después ejecuta `insert into core.profiles … on conflict do nothing` e `insert into core.memberships (app, user_id, role) values (…, 'owner') on conflict (app, user_id) do update set role = 'owner'`, y verifica el rol. Si la cuenta se creó aquí y el SQL falla, se borra esa cuenta nueva. Informe sin secretos: `private/owner-initialization-<app>.json`.

### `release_cloud.py --app <app> --version vX.Y.Z[-sufijo] [--apply] [--bind-domain]`
Orden fijo: **schema → function → pages (→ domain)**. Exporta `IKISAI_RELEASE` para que la Edge y `version.json` lleven la misma etiqueta. Con `--apply` comprueba hasta 6 veces (cada 5 s) que `https://<app>.ikisai.com/version.json` y `/api/v1/health` devuelven `release == versión` (`RELEASE_VERIFICATION_FAILED` si no). Si un paso falla, el informe se escribe igualmente con `status: error` y `failedStep`. Nunca importa datos ni hace rollback: los pasos anteriores quedan publicados y se corrige hacia delante. Informe: `private/release-<app>.json`.

### `cloud_backup.py backup|verify|restore`
- `backup --output RUTA.zip`: exporta por `/database/query` (solo lectura, lotes de 500 filas ordenadas por clave primaria) todas las tablas de los schemas `core`, `tasks`, `invoices`, `booking`, `food` que existan, como `data/<schema>/<tabla>.jsonl`, y descarga todos los objetos de los buckets registrados que existan como `objects/<bucket>/<ruta>`. `manifest.json` lleva filas y SHA-256 por tabla y tamaño y SHA-256 por objeto. El zip se valida al terminar y se borra si algo falla. No contiene tokens ni sesiones.
- `verify --source RUTA.zip`: inventario exacto y hashes.
- `restore --source RUTA.zip --plan`: **solo plan**. Devuelve recuentos y los pasos documentados (proyecto vacío con migraciones aplicadas, carga `core` → apps con triggers `core_touch_revision` desactivados, objetos a buckets privados, recálculo de `core.app_state.cursor`, pertenencias revisadas a mano). La ejecución real no está implementada (ver «Pendiente»).

### `encrypted_backup.py create|decrypt`
`create --output RUTA.ikisai [--skip-unchanged]` crea el zip anterior, lo cifra con AES-256-GCM (`IKISAI_BACKUP_KEY`, cabecera `IkisaiAppsEncryptedBackup-v1`), comprueba el descifrado y la integridad, y calcula una huella HMAC del manifiesto (sin la fecha) que da nombre al artefacto; con `--skip-unchanged` consulta los artefactos recientes de GitHub (`GITHUB_REPOSITORY`, `GITHUB_TOKEN`) y no crea otro si la huella coincide con el último (menos de 30 días y más de 7 de vida). `decrypt --source --output` recupera el zip y lo valida. Requiere `pip install -r scripts/requirements-backup.txt`.

### `release_matrix.py`
Solo lo usa `release.yml`: decide qué apps se publican y con qué versión (ver abajo). Sin red ni credenciales.

## Workflows

| Workflow | Disparo | Qué hace |
|---|---|---|
| `checks.yml` | `pull_request` a `main`, `workflow_call` | Node 20 con caché npm, `npm ci`, `npm run check` (lint de migraciones + typecheck), `npm run test` (PGlite). Job `e2e` aparte que instala Chromium y ejecuta `npm run test:e2e` solo si existe `playwright.config.ts`. |
| `release.yml` | `workflow_dispatch` (inputs `app`, `version`, `bind_domain`) y `push` a `main` | Job `plan` (`release_matrix.py`): en dispatch la app elegida; en push las apps cuyos directorios cambiaron desde `github.event.before` (`apps/<app>`, `supabase/functions/<app>-api`, `packages/domain-<app>`, migraciones `*_<app>_*`; un cambio compartido —`_kit`, migraciones `core`, `sync-client`, `ui-kit`, `scripts`, workflows— marca todas), filtradas a las **publicables** (existen `supabase/functions/<app>-api/index.ts` y `apps/<app>/package.json`). Llama a `checks.yml` y luego, por app de la matriz, `python scripts/release_cloud.py --app $APP --version $VERSION --apply` en el environment `production`, concurrencia `ikisai-release-<app>` sin cancelar, y sube `private/release-<app>.json` como artefacto (90 días). Versión por defecto: `v0.1.0-build.<run_number>`. |
| `backup.yml` | cron `17 3 * * *` y dispatch | `encrypted_backup.py create --skip-unchanged`; artefacto `encrypted-IkisaiApps-<huella>-<run_id>` 90 días. |

## Orden de una release

1. PR a `main` con CI verde (`checks.yml`). Las migraciones nuevas pasan el lint y las pruebas PGlite.
2. Fusionar en `main`. `release.yml` publica automáticamente las apps afectadas con `v0.1.0-build.<n>`; para una versión con nombre, lanzar `release.yml` a mano con `app` y `version` (`vX.Y.Z` o `vX.Y.Z-beta.1`).
3. `release_cloud.py` ejecuta: migraciones pendientes → Edge `<app>-api` con la release inyectada → build y Pages `ikisai-<app>` → (primera vez) dominio y CNAME con `bind_domain`.
4. Verificación: `version.json` y `/api/v1/health` del dominio responden la misma `release`. El informe queda como artefacto.
5. Primera puesta en marcha de una app (una sola vez, Core en local): `configure_supabase_auth.py --apply`, `configure_supabase_storage.py --bucket <bucket> --apply`, release con `bind_domain`, `initialize_app_owner.py --app <app> --email <propietario> --apply`.

Ensayo local sin tocar nada: `python scripts/release_cloud.py --app invoices --version v0.1.0-rc.1` (plan) o cada script por separado.

## Pendiente

- `cloud_backup.py restore` solo ofrece `--plan`; la restauración real (carga ordenada con triggers desactivados y recálculo de cursores) y su ensayo en un proyecto vacío quedan por implementar.
- `encrypted_backup.py --skip-unchanged` requiere `actions: read` en el token del workflow (ya concedido en `backup.yml`).
- El `_worker.js` generado reenvía `/api/v1/*` y `/health`; si una app necesita más rutas en el worker, debe traer el suyo en `apps/<app>/public/_worker.js`.
