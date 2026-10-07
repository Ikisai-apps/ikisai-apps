# Central · estado

## Hecho

- 2026-10-07 · Puerta G2: `docs/central/API.md` aprobado por Core (ronda 1) y preguntas de producto respondidas por el usuario (ronda 2).
- 2026-10-07 · **V1-a (accesos)** y base de **V1-b (personas)**:
  - Migración `0500_central_people`: `central.people`, `central.person_private` y `central.person_records` (reservadas: owner o editor con ámbito `people`), invariantes (`ORPHAN_CHILD`, nunca un agente como persona), lecturas `central.app_catalog` (owner) y `central.record_file`.
  - `central-api` (`createApp({ admin: true })`): conformidad del núcleo sobre `central.people`, hook `visible`, `beforeCommit` con `_domain/central`, rutas `catalog/apps` y `people/records/:id/file`.
  - `apps/central` (PWA): Inicio (resumen para owner), Accesos con Cuentas (rol por app, ámbito `people` de Central, contraseña temporal nueva, desactivar/reactivar), Alta con contraseña temporal una vez, Agentes (revocar) y Registro (filtro por app, paginado), Conflictos; lanzador del kit; icono propio.
  - Pruebas: `tests/central/*.test.ts` (24: conformidad, API, dominio) y `tests/central/access.spec.ts` (Playwright contra la `central-api` real sobre PGlite).

## Pendiente

- **Entidad** (configuración común, ronda 3): razón social, NIF/CIF, domicilio fiscal y logotipo; proyección para Booking y Finance.
- V1-b · pantallas de Personas (ficha, datos reservados, documentación con archivos, «Dar cuenta»).
- V1.1 · Cumplimiento: migración `0510_central_compliance`; tareas en Tasks con `POST tasks/api/v1/requests/task` (con `kind`, sin área).
- V2 · Dirección: contrato de KPIs y panel.

## Bloqueos

- La fusión de mis PR la ha denegado el control de permisos de la sesión: la decide el usuario.
