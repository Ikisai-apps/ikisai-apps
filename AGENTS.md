# Ikisai Apps · reglas para agentes

Lee antes de tocar nada: `docs/core/PLAN.md` y `docs/core/CONTRATO_SINCRONIZACION.md`. El contrato es normativo.

## Qué es este repo

Un único repositorio para las cuatro apps de Ikisai (Tasks, Invoices, Booking, Food) sobre un proyecto Supabase compartido (`ctytaorylbninfyupfsn`) y un núcleo común de sincronización offline (`core`). Cada app tiene su propio dominio, su propia Edge Function y su propio proyecto de Cloudflare Pages.

## Propiedad por directorio

| Directorio | Dueño |
|---|---|
| `supabase/migrations/*_core_*`, `supabase/functions/_kit`, `packages/sync-client`, `packages/test-kit`, `scripts`, `.github`, raíz, `docs/core` | Core |
| `packages/ui-kit` (incluido su `ESTADO.md`) | agente UI |
| `apps/<app>`, `supabase/functions/<app>-api`, `supabase/functions/_domain/<app>`, `packages/domain-<app>`, `supabase/migrations/*_<app>_*`, `tests/<app>`, `docs/<app>` | equipo de `<app>` |

Nadie edita fuera de su directorio. Lo compartido lo cambia Core a petición: anota lo que necesitas en **`docs/<app>/PETICIONES.md`** (tu propio archivo, para que las PR de distintos equipos no colisionen); Core responde ahí y resume en `docs/core/RESPUESTAS.md`. El código de dominio compartido entre Edge y frontend vive en `supabase/functions/_domain/<app>/` y `packages/domain-<app>` solo lo reexporta.

## Reglas fuertes

1. **Un schema, un dueño.** `tasks.*`, `invoices.*`, `booking.*`, `food.*`. Las lecturas cruzadas van por vistas `*_projection` del dueño o por la API del dueño con el token del usuario. Nunca se escribe en tablas ajenas.
2. **Toda tabla sincronizable** sigue §2 del contrato: `id`, `revision`, `created_at`, `updated_at`, `updated_by`, `deleted_at`, y queda registrada en `core.synced_tables` en la misma migración que la crea.
3. **Migraciones:** una sola secuencia `YYYYMMDD_NNNN_<schema>_<tema>.sql`. Cada archivo toca un único schema (la CI lo comprueba). Una migración fusionada en `main` es inmutable. Solo el workflow de release aplica migraciones al proyecto Supabase.
4. **Escrituras solo vía `core.commit`.** Con `requestId`, `expectedRevision` y recibos. Un 409 nunca se resuelve sobrescribiendo.
5. **Permisos:** RLS activado y todo revocado a `anon`/`authenticated`; solo las Edge con service key. Pertenencia releída en cada petición. `reader` no escribe.
6. **Sin secretos ni datos personales** en Git, fixtures o capturas. Usa `private/` (ignorado).
7. **Conformidad:** toda `<app>-api` pasa `packages/test-kit` antes de añadir rutas propias.
8. **Ramas, commits y PR (punto medio: pocos intercambios, cero conflictos).**
   - **Una rama por agente y tanda** (`<app>/<tanda-o-tema>`). Commits locales tan frecuentes como quieras; no cuentan en el histórico de `main` porque se fusiona con squash.
   - **Push por hito, no por archivo:** empuja y abre (o actualiza) la PR cuando tengas un incremento coherente que pasa las pruebas en local (una migración con su conformidad, una ruta con sus pruebas, una pantalla). Una PR por tanda es lo normal; añade commits a la misma PR hasta cerrarla. Como mínimo, empuja la rama al terminar cada tanda aunque la PR no esté lista (copia de seguridad; sin PR no cuesta nada).
   - **Antes de empujar, en local:** `npm run check && npm run test` y las pruebas de tu app. La CI de GitHub confirma, no descubre.
   - **Rebase sobre `origin/main` al empezar cada tanda y justo antes de fusionar.** Con la propiedad por territorio, los conflictos son raros; si aparece uno fuera de tu territorio, no lo resuelvas tú: pídelo a Core.
   - **Documentación con el código:** `ESTADO.md`, `API.md` y `PETICIONES.md` van en la misma PR que el trabajo de la tanda. Nada de PR solo de documentación salvo que no haya código.
   - **Supabase no se toca desde los equipos:** las migraciones se prueban con PGlite y las publica Core desde `main`. Si necesitas probar una Edge contra Supabase real, pide a Core un despliegue al slug `<app>-api-qa`.
   - **Quién fusiona:** si la PR solo toca directorios de tu equipo, la fusionas tú con la CI en verde (squash, borrando la rama). Si toca algo compartido o de otro equipo, espera el visto bueno de Core o del equipo afectado. Sin force-push y sin push directo a `main`.
9. **Estado:** cada equipo mantiene `docs/<app>/ESTADO.md` (hecho, pendiente, bloqueos).
10. **Definición de hecho:** recorrido de aceptación en PC y Android, escenarios offline en Playwright, documentación de despliegue y recuperación.

## Comandos

```text
npm install                 # workspaces
npm run check               # typecheck + lint de migraciones
npm run test                # núcleo y conformidad (PGlite)
npm run test:e2e            # Playwright
python scripts/release_cloud.py --app <app> --version vX.Y.Z   # plan; --apply publica (solo Core/CI)
```
