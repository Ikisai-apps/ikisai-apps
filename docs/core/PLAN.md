# Ikisai Apps · Plan del agente Core (v2)

Fecha: 5 de octubre de 2026. Autor: agente Core. Estado: **plan aprobado en dirección; nada implementado todavía.**

Sustituye a la v1 del mismo día. Recoge las decisiones tomadas con el usuario: repo único, núcleo común, **todas las apps funcionan offline**, Tareas se refactoriza al mismo modelo que las demás, y el trabajo se reparte entre tantos agentes en paralelo como admita el diseño sin crear conflictos. El agente de backend del bloque 3 se retira en cuanto fusione `ui/grafica` y corrija sus errores; a partir de ahí Core asume Tareas.

Documentos hermanos:

- `CORE_SYNC_CONTRACT.md`: contrato técnico del núcleo (datos, commit, API, cliente offline). Es la pieza que debe estar cerrada antes de abrir trabajo en paralelo.
- Handoff V3 y canon funcional del zip: siguen siendo la referencia funcional de Invoices, Booking y Food.
- Hojas C03/C04/C08 de «App de gestión»: referencia de campos.

---

## 1. Diagnóstico que justifica el refactor

El modelo de Tareas nació para editar notas de Google Keep, cuya API obliga a reescribir la nota entera. De ahí heredó `replace_state` (cada guardado borra e inserta el grafo completo) y los atributos en `data jsonb`. Eso no es necesario para el offline y no escala a facturas, líneas de compra o huéspedes.

Lo que sí hay que conservar de Tareas, porque es exactamente lo que necesita una app offline: comandos en lote con `requestId` y recibos idempotentes, `expectedVersion` por entidad con 409 explícito, log de cambios con cursor para sincronización incremental, y cola de salida en IndexedDB. El núcleo generaliza esas cuatro piezas sobre tablas relacionales tipadas.

---

## 2. Arquitectura objetivo

```text
                 ┌──────────────── Cloudflare Pages (un proyecto por app) ────────────────┐
                 │ tasks.ikisai.com  invoices.ikisai.com  booking.ikisai.com  food.ikisai.com │
                 └───────┬──────────────┬───────────────────┬───────────────────┬───────────┘
                         │ /api/v1 mismo origen (_worker.js por dominio)         │
                 ┌───────▼──────┐ ┌─────▼───────┐ ┌─────────▼─────┐ ┌───────────▼───┐
 Edge Functions  │  tasks-api   │ │ invoices-api│ │  booking-api  │ │   food-api    │
 (Deno + TS)     │  importa _kit│ │ importa _kit│ │ importa _kit  │ │ importa _kit  │
                 └───────┬──────┘ └─────┬───────┘ └─────────┬─────┘ └───────────┬───┘
                         └──────────────┴──────────┬────────┴───────────────────┘
                                        ┌──────────▼───────────┐
 PostgreSQL (un proyecto Supabase)      │  core.*  núcleo       │  memberships · profiles · changes
                                        │                      │  receipts · app_state · code_sequences
                                        ├──────────────────────┤  commit() genérico · next_code() · triggers
                                        │ tasks.* invoices.*   │  tablas tipadas con id/revision/deleted_at
                                        │ booking.* food.*     │  proyecciones de solo lectura entre schemas
                                        └──────────────────────┘
 Storage privado: ikisai-files (tasks) · purchase-documents · kitchen-media
```

Principios:

1. **Un núcleo, cuatro consumidores.** `core` contiene solo lo que no pertenece a ningún dominio: pertenencia, perfiles, log de cambios, recibos, cursores, códigos humanos, triggers y la función de commit. Nada de negocio.
2. **Mismo contrato de sincronización en las cuatro apps.** `/commands`, `/changes`, `/snapshot`, `/history`, `/uploads`, `/auth`. El cliente offline es un paquete compartido.
3. **Cada schema tiene un único dueño que escribe.** Las lecturas cruzadas van por vistas de proyección (apps hermanas) y por enlaces tipados validados al guardar.
4. **TypeScript en todas partes.** Edge (Deno) y frontend (Vite) comparten los paquetes de dominio: la validación que corre offline en el cliente es la misma que corre en el servidor.
5. **Modo lectura primero, estado antes que formulario, nada de dashboards decorativos** (canon funcional del zip).

El esquema `ikisai.*` actual se sustituye por `tasks.*` sobre el núcleo. La nube está vacía, así que no hay migración de datos; las migraciones antiguas se conservan en el historial y se retiran con una migración final de limpieza cuando el nuevo Tareas esté publicado y verificado.

---

## 3. Repositorio único `Ikisai-apps/ikisai-apps`

```text
ikisai-apps/
├── AGENTS.md                      # reglas de convivencia multiagente (ver §6)
├── CODEOWNERS                     # dueño por directorio; Core revisa lo compartido
├── package.json / pnpm-workspace  # workspaces; una sola versión de TS, Vite, Playwright
├── supabase/
│   ├── migrations/                # UNA secuencia; cada archivo toca un solo schema
│   │   ├── 20261010_0001_core_*.sql
│   │   ├── 2026…_tasks_*.sql  2026…_invoices_*.sql  2026…_booking_*.sql  2026…_food_*.sql
│   └── functions/
│       ├── _kit/                  # edge-kit: auth, errores, commit, uploads, cors, hmac
│       ├── tasks-api/ invoices-api/ booking-api/ food-api/
├── packages/
│   ├── sync-client/               # IndexedDB, outbox, pull de cambios, conflictos
│   ├── ui-kit/                    # tokens «Taller», shell de login, componentes base (agente UI)
│   ├── domain-tasks/ domain-invoices/ domain-booking/ domain-food/   # tipos + validación compartida
│   └── test-kit/                  # PGlite, fixtures, suite de conformidad del núcleo
├── apps/
│   ├── tasks/ invoices/ booking/ food/     # Vite + TS, PWA, cada una con su _worker.js
├── integrations/calendar/         # cuenta de servicio Google (plan B: Apps Script)
├── scripts/                       # deploy schema/function/pages/auth/backup, adaptados de ikisai-tasks
├── tests/                         # e2e Playwright por app, escenarios offline
└── docs/
    ├── core/ (contrato, decisiones)  tasks/ invoices/ booking/ food/ (API por app, aceptación)
```

`ikisai-tasks` se congela y archiva cuando `apps/tasks` esté publicado en `tasks.ikisai.com` con la misma versión en `/health` y `/version.json`. Hasta entonces sigue sirviendo producción sin cambios.

---

## 4. El núcleo (lo que construye Core al principio)

Resumen; el detalle normativo está en `CORE_SYNC_CONTRACT.md`.

**Datos.** Toda tabla sincronizable lleva `id uuid`, `revision bigint`, `created_at`, `updated_at`, `updated_by`, `deleted_at` (borrado lógico) y opcionalmente `code text unique` (`RSV_2026_001`). Tablas en `core`: `apps`, `memberships(app, user_id, role, scopes)`, `profiles`, `app_state(app, cursor)`, `changes`, `receipts`, `code_sequences`, `synced_tables` (registro de tablas y columnas escribibles por app).

**Commit.** `core.commit(app, actor, request_id, digest, expected_cursor, operations)`: una transacción; bloquea el cursor de la app; devuelve el recibo si el `request_id` ya existe; aplica cada operación (`insert|update|delete|restore` sobre tablas registradas, o `call` a un procedimiento del schema de la app en la lista blanca) comprobando `revision` fila a fila; anota antes/después en `core.changes`; incrementa el cursor; guarda el recibo. Un 409 nunca sobrescribe.

**API uniforme por app** (`_kit` la implementa, la app añade sus rutas de lectura y exportación): `bootstrap`, `snapshot`, `changes?after=`, `commands`, `history` + `undo`, `uploads`, `auth/*`, `health`.

**Cliente offline** (`sync-client`): espejo local por tabla, cola de comandos, pull incremental, fusión automática cuando los campos cambiados son disjuntos, conflicto explícito cuando no lo son, cola de blobs para PDF y fotos, estado de red visible. Nunca finge que un guardado se hizo.

**Seguridad.** RLS activado y todo revocado a `anon`/`authenticated`; solo las Edge con service key. Pertenencia releída en cada petición. `reader` no escribe. Las funciones `core.*` y los procedimientos de app son `security definer` ejecutables solo por `service_role`.

**Lo que se deja preparado pero no se hace en fase 0:** claves de agente y propuestas con aprobación humana en `core` con columna `app` (hoy son de Tareas), lanzador «mis apps», SSO entre subdominios.

---

## 5. Las apps sobre el núcleo

| App | Dominio (dueño) | Offline relevante | Lee de otras | Es leída por |
|---|---|---|---|---|
| Tasks | áreas, proyectos, tareas e hijas, dependencias, etiquetas, familias, vistas | edición completa en móvil | nada | Invoices (destinos), Booking/Food (crear tarea, V2) |
| Invoices | proveedores, facturas, documentos, líneas, impuestos, asignaciones | registrar y asignar sin red; subida de PDF en cola | Tasks (API con token), proyecciones de Booking y Food | Booking (coste por retiro, V2), Food (entradas de stock, V2) |
| Booking | reservas, eventos, huéspedes, restricciones, Calendar | editar reserva/evento sin red; Calendar se proyecta al reconectar | nada | Food (proyección sin huéspedes), Invoices |
| Food | recetas, ingredientes, maquinaria, menús, compra, preparación | cocina con wifi malo: recetas y menús locales, fotos en caché | proyección de Booking, entradas de Invoices (V2) | Invoices |

Decisiones ya tomadas que se mantienen de la v1: `invoices.suppliers` ligera, periodo fiscal derivado de la fecha, categorías de gasto cerradas con `is_investment`, Calendar por cuenta de servicio con `calendar_links` + `calendar_sync_jobs`, huéspedes nunca visibles para Food, obsolescencia por comparación de revisiones, importación `ikisai.invoice.v1` desde ChatGPT en V1 con puerta a extracción desde la Edge en V2.

**Tareas** se porta al núcleo con tablas tipadas (`tasks.tabs`, `projects`, `tasks`, `task_dependencies`, `labels`, `families`, `saved_views`), los ámbitos por área/proyecto viajan en `core.memberships.scopes`, y la interfaz actual se conserva: `sync.js` se sustituye por `sync-client`, los módulos de UI de «Taller» se mantienen y se migran a TypeScript módulo a módulo cuando se toque cada función. Las pruebas de paridad contra Python desaparecen; el servidor Python y SQLite se retiran con el repo antiguo.

---

## 6. Organización del trabajo en paralelo

### Roles

- **Core (yo):** contrato, núcleo, `_kit`, `sync-client`, `test-kit`, CI, releases, migraciones a producción, revisión de todo lo compartido, misiones cruzadas entre apps, coordinación.
- **Agente UI:** `packages/ui-kit` (tokens, login shell, componentes) y revisión visual de las cuatro apps.
- **Equipo por app** (uno o varios agentes): `apps/<app>`, `supabase/functions/<app>-api`, `packages/domain-<app>`, migraciones `*_<app>_*`, `tests/<app>`, `docs/<app>`. Dentro de una app, el reparto natural es **backend** (SQL + Edge + dominio) y **frontend** (Vite + UI), con el `docs/<app>/API.md` cerrado antes de separarse; a partir de la base, se puede repartir por verticales funcionales (por ejemplo en Food: recetario, menú, compra/preparación).

### Reglas que evitan conflictos

1. **Propiedad por directorio** declarada en `CODEOWNERS`. Nadie edita fuera de su directorio; lo compartido (`_kit`, `sync-client`, `core`, raíz, CI, `AGENTS.md`) lo cambia Core a petición.
2. **Contrato antes que paralelismo.** Ningún equipo arranca hasta que el contrato del núcleo (G1) y la API de su app (G2) están aprobados por escrito.
3. **Una rama por agente y tema** (`<app>/<tema>`), PR a `main`, CI verde obligatoria, revisión de Core si toca algo compartido. Sin force-push. Commits pequeños.
4. **Migraciones:** una sola secuencia con timestamp; cada archivo toca un único schema (lint en CI que lo verifica); inmutables una vez fusionadas; dependencias entre schemas solo mediante misión coordinada por Core. **Solo el workflow de release de `main` aplica migraciones al proyecto Supabase.** Los agentes prueban con PGlite y con la suite de conformidad.
5. **Suite de conformidad del núcleo:** toda `<app>-api` debe pasar los mismos tests de commit, idempotencia, 409, cambios incrementales, borrado lógico y permisos antes de añadir rutas propias.
6. **Datos sintéticos siempre.** Sin datos personales ni secretos en fixtures ni en Git. `private/` ignorado.
7. **Definición de hecho** por app: recorrido de aceptación del zip ejecutado en PC y Android, escenarios offline en Playwright (corte de red, recarga, reconexión, conflicto), documentación de despliegue y recuperación.
8. **Canal de coordinación:** cada equipo mantiene `docs/<app>/ESTADO.md` con hecho, pendiente y bloqueos; Core lee esos archivos y resuelve cruces. Las peticiones a Core se registran en `docs/core/PETICIONES.md`.
9. **Un worktree por agente en este PC** (`git worktree add ../ikisai-apps-<agente> <rama>`): cada agente tiene su directorio de trabajo propio sobre el mismo repo y no pisa el de otro. Hoy dos agentes comparten clon y ramas; eso se termina con el repo nuevo.
10. **`main` protegida:** solo PRs con CI verde; sin force-push; los dueños de directorio revisan lo suyo y Core lo compartido.

Decisiones de producto cerradas el 5 de octubre que afectan a todas las apps: historial íntegro sin compactar; papelera sin purga automática con botón «Vaciar papelera» para `owner` (facturas exentas); PDF sin límite propio, fotos recomprimidas en cliente a «resolución WhatsApp» sin conservar original; fusión automática de campos disjuntos en todas las apps. Detalle en `CORE_SYNC_CONTRACT.md` §11.

### Puertas (gates)

| Puerta | Qué debe existir | Quién |
|---|---|---|
| G0 | Este plan y `CORE_SYNC_CONTRACT.md` aprobados por el usuario | Core + usuario |
| G1 | Repo creado, `core` migrado, `_kit`, `sync-client`, `test-kit`, CI, release y backup funcionando con una app de prueba vacía publicada | Core |
| G2 | `docs/<app>/API.md` + modelo de datos de cada app aprobados; `ui-kit` v0 con tokens | Equipos + UI + Core |
| G3 | Cada app pasa la conformidad del núcleo y su recorrido de aceptación | Equipos |
| G4 | Misiones cruzadas (proyecciones, asignaciones, coste por retiro, stock) | Core + equipos |

### Fases y paralelismo

- **Fase 0 · Núcleo (Core, en solitario, 1–2 semanas).** G0 → G1. Mientras tanto el agente UI prepara `ui-kit` a partir de «Taller» y el agente de backend saliente termina la fusión de `ui/grafica`.
- **Fase 1 · Cuatro equipos a la vez.** Tasks (port), Invoices, Booking y Food arrancan en paralelo tras G1 y su G2. Invoices tiene prioridad de publicación; Tasks tiene prioridad de corte porque libera el repo antiguo. Booking y Food pueden avanzar en backend aunque la UI vaya detrás.
- **Fase 2 · Cruces.** Proyección Booking → Food, destinos de Invoices, entradas de stock, coste por retiro, agentes multiapp, lanzador.
- **Fase 3 · Piloto.** Uso real varios días en PC y Android, correcciones, 1.0 de cada app.

---

## 7. Qué hay que pedir o preparar fuera del código

- Proyecto GCP gratuito y cuenta de servicio con el calendario «Agram Camp - Reservas» compartido en edición (Booking). Clave JSON como secreto de la Edge.
- Dominios `invoices.`, `booking.`, `food.ikisai.com` en Cloudflare (los crea el script de Pages, como hizo Tareas).
- Ampliar `site_url` y la allow-list de Auth a los cuatro dominios.
- Confirmar el momento del corte de Tareas antiguo → nuevo (la nube está vacía; cuanto antes, más barato).
- Vigilar cuotas del plan gratuito de Supabase (Storage de facturas) y activar el backup externo antes de cargar facturas reales.

## 8. Riesgos

- **Núcleo demasiado ambicioso.** Mitigación: el contrato fija lo mínimo; lo que no necesiten dos apps no entra.
- **Agentes bloqueados esperando a Core.** Mitigación: G1 pequeño y rápido; API de app y UI pueden diseñarse en paralelo con la fase 0.
- **Conflictos de fusión en archivos compartidos.** Mitigación: propiedad por directorio, cambios compartidos solo por Core, PRs pequeños.
- **Datos personales de huéspedes.** Minimización, sin copias de documentos, cifrado en backups, proyecciones sin identificar.
- **Offline con adjuntos grandes.** Cola de blobs separada de los comandos, límites claros, reintentos con progreso visible.
