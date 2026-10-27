# Arrancar Core en otro ordenador

Guía mínima para que el rol de Core (hoy **Core Producción · La Muela**, RELEVO-001) pueda trabajar desde cualquier equipo. Sin secretos ni datos personales.

## Requisitos
- git, Node 20 o superior con npm, Python 3.12 (o 3.11) y la CLI `gh` autenticada con una cuenta con permiso de escritura en `Ikisai-apps/ikisai-apps` y `Ikisai-apps/ikisai-coordinacion`.
- No hacen falta Deno, la CLI de Supabase ni Wrangler: las pruebas usan PGlite y los despliegues, los scripts de `scripts/`.

## Repositorios
- `Ikisai-apps/ikisai-apps` (este, **público**): código, migraciones, CI y documentación técnica.
- `Ikisai-apps/ikisai-coordinacion` (privado): canal de mensajes entre equipos (`canal/`), con su formato en el README. Un mensaje publicado no se reescribe: se corrige con otro.

## Arranque
1. `git clone` en una carpeta propia; un worktree por agente (`git worktree add ../wt-<app> -b <app>/<tema> origin/main`) y `npm ci` en cada uno.
2. `npm run check && npm run test` en verde antes de tocar nada.
3. Leer `AGENTS.md`, `docs/core/CONTRATO_SINCRONIZACION.md`, `docs/core/DESPLIEGUE.md` y los últimos mensajes de `canal/`.

## Publicar
- Lo fusionado en `main` se publica por lotes: cada 30 min, las apps afectadas (`release.yml`, environment `production`, secretos custodiados en GitHub). El equipo no necesita conocer sus valores.
- `main` tiene un ruleset: PR obligatoria y checks «Qué ha cambiado» y «Lint de migraciones, typecheck y pruebas PGlite». No se desactiva para ganar tiempo.
- Los scripts de una sola vez (`configure_supabase_auth.py`, `configure_supabase_storage.py`, `initialize_app_owner.py`) leen `private/cloud-credentials.json` (ignorado por Git). Cada equipo usa **su propio token** de Supabase, creado por el usuario para ese ordenador; nunca se copian claves entre equipos ni se pegan en un chat.

## Dónde está cada fuente de contexto
| Qué | Dónde |
|---|---|
| Código y documentación técnica | este repositorio |
| Decisiones y traspasos saneados | `ikisai-coordinacion/canal/` |
| Feedback de las apps | `core.feedback_reports` (y vistas «Sugerencias y QA»); volcado con `scripts/feedback_pull.py` |
| Buzones de agentes, notas y borradores | en el ordenador de cada equipo, fuera de Git (pendiente de consolidar) |
| Credenciales | `private/` de cada ordenador y secretos de GitHub; nunca en Git |
