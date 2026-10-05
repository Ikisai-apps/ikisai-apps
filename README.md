# Ikisai Apps

Repositorio único de las aplicaciones de Ikisai sobre un núcleo común de sincronización offline.

| App | Dominio | Estado |
|---|---|---|
| Tasks | tasks.ikisai.com | pendiente de portar desde `Ikisai-apps/ikisai-tasks` |
| Invoices | invoices.ikisai.com | fase 0: esqueleto |
| Booking | booking.ikisai.com | pendiente |
| Food | food.ikisai.com | pendiente |

Documentación: `docs/core/PLAN.md` (organización y fases) y `docs/core/CONTRATO_SINCRONIZACION.md` (contrato normativo). Reglas para agentes en `AGENTS.md`.

Backend compartido: Supabase `ctytaorylbninfyupfsn` (PostgreSQL, Auth, Edge Functions, Storage). Frontends en Cloudflare Pages. Sin secretos en este repositorio: configuración privada en `private/` (ignorado) o en los secretos de GitHub Actions.
