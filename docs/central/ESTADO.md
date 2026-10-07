# Central · estado

## Hecho

- 2026-10-07 · Puerta G2: `docs/central/API.md` aprobado por Core (ronda 1) y preguntas de producto respondidas por el usuario (ronda 2).
- 2026-10-07 · **V1-a (accesos)** y base de **V1-b (personas)**:
  - Migración `0500_central_people`: `central.people`, `central.person_private` y `central.person_records` (reservadas: owner o editor con ámbito `people`), invariantes (`ORPHAN_CHILD`, nunca un agente como persona), lecturas `central.app_catalog` (owner) y `central.record_file`.
  - `central-api` (`createApp({ admin: true })`): conformidad del núcleo sobre `central.people`, hook `visible`, `beforeCommit` con `_domain/central`, rutas `catalog/apps` y `people/records/:id/file`.
  - `apps/central` (PWA): Inicio (resumen para owner), Accesos con Cuentas (rol por app, ámbito `people` de Central, contraseña temporal nueva, desactivar/reactivar), Alta con contraseña temporal una vez, Agentes (revocar) y Registro (filtro por app, paginado), Conflictos; lanzador del kit; icono propio.
  - Pruebas: `tests/central/*.test.ts` (24: conformidad, API, dominio) y `tests/central/access.spec.ts` (Playwright contra la `central-api` real sobre PGlite).

- 2026-10-07 · **Entidad** (configuración común, ronda 3): migración `0501_central_entity` (fila única, solo owner escribe, NIF/NIE/CIF con control), proyección `central.common_entity_projection` para Booking y Finance (con bucket y ruta del logotipo para firmar), pantalla Entidad con subida del logotipo sin red; pruebas `tests/central/entity.test.ts` y `entity.spec.ts`.

- 2026-10-07 · **V1-b (personas)**, pantallas: lista con búsqueda, filtro y orden manual; ficha con Ficha, Contacto y vinculación (reservado), Documentación y formación (reservado; estado derivado, archivo PDF o foto recomprimida, apertura con `people/records/:id/file`), Cuenta (solo owner: dar cuenta, enlazar o desenlazar), inactiva y papelera con restauración en un lote; aviso de caducidades en Inicio. Prueba `tests/central/people.spec.ts` (incluye edición sin red).
- 2026-10-07 · Revisión de Core (ronda 5): migración `0502` (solo el owner enlaza cuentas, también en la base).
- 2026-10-07 · **V1.1 (cumplimiento)**: migración `0510_central_compliance` (`requirements` LEG, `key_documents` DOC, `requirement_tasks`; invariantes `ORPHAN_CHILD` y `PERSON_IN_USE`; lectura `central.requirement_brief`); rutas `requirements/:id/task` y `requirements/tasks-status` hacia Tasks (`kind` `central.compliance_due`, sin área); pantallas Vencimientos, Obligaciones (ficha con «Marcar cumplido», que propone el siguiente vencimiento, y «Crear tarea en Tasks») y Documentos; aviso «Vence pronto» en Inicio; Entidad pasa a abrirse desde Inicio. Pruebas `tests/central/compliance.test.ts` y `compliance.spec.ts` (Tasks simulado).
- 2026-10-07 · **V2 (dirección), primer paso**: migración `0520_central_kpis` (`central.kpi_targets`, solo owner; `central.central_kpi_projection` con 7 KPIs de Central), contrato `<schema>.central_kpi_projection` propuesto en `API.md` §7.2 para que Core lo reparta, ruta `GET dashboard` (lee todas las fuentes, una caída no rompe el panel), panel en Inicio con objetivos y lectura sin red. Pruebas `tests/central/kpis.test.ts` y `dashboard.spec.ts`.
- 2026-10-07 · Ronda 8: indicadores en euros solo para owner y editor; copia del panel sin red por cuenta (#202).
- 2026-10-07 · **Registro de decisiones** (ronda 9): migración `0530_central_decisions` (`DEC`, tres niveles: nombre llano, descripción llana y explicación técnica; sustitución coherente), pantalla Decisiones con búsqueda y filtros, enlace desde Inicio. Pruebas `tests/central/decisions.test.ts` y `decisions.spec.ts`.
- 2026-10-07 · **Equipos** (para la medición de uso): migración `0540_central_teams` (equipos, pertenencia múltiple, permiso en Edge y base, proyección `central.common_team_projection` para el núcleo), filtro y chips en Personas, bloque en la ficha y pantalla Equipos con semilla sugerida. Pruebas `tests/central/teams.test.ts` y `teams.spec.ts`.

- 2026-10-07 · Almacenamiento (contrato §3.9): `logo_provider` en `central.common_entity_projection` (migración `0550`) y `central-api` con el mismo `createStorage` que el kit (Supabase o R2).

- 2026-10-07 · **Feedback y uso (fase 4)**: «Sugerencias y QA», revisor y lanzador; unos 400 `data-feedback-id` en todas las pantallas, `data-feedback-ignore` en datos personales; `createUsage` con aviso y 11 operaciones con `usage.run`/`track`. Pruebas `tests/central/feedback-ids.test.ts` y `feedback.spec.ts`; el servidor de pruebas acepta el aviso de uso por defecto.

## Pendiente

- Rellenar los datos reales de la entidad y subir `private/logo-ikisai.jpg`: lo hace el usuario en la app cuando esté publicada.
- V2 · Dirección: que cada app publique su `central_kpi_projection` (reparto de Core); después, revisión semanal, OKR y registro de decisiones (C01), si el usuario los quiere.

## Bloqueos

- La fusión de mis PR la ha denegado el control de permisos de la sesión; la #180 la fusionó Core.
