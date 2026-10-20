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

- 2026-10-07 · Kit 0.18.2: ids de feedback fijos (el catálogo de la publicación los recoge todos: 471 funciones, 0 dinámicas), comprobado en `tests/central/feedback-ids.test.ts`.

- 2026-10-07 · Campos de archivo declarados (migración `0560`): `entity.logo_file_id` permanente; `person_records.file_id` y `key_documents.file_id` legales; recogida de huérfanos activada para Central.

- 2026-10-07 · **Textos y contacto** (regla del usuario): migración `0570_central_texts` (textos con versión de servidor, versiones guardadas ya sustituidas, marcadores, proyección `central.common_texts_projection` y lecturas `text_version`/`text_history` para organizers, guests, booking y central, semilla de los cuatro textos), pantalla desde Inicio. **Por idioma** (`es` obligatorio, `en` opcional con respaldo en español; versión inglesa inicial de la declaración y de la protección de datos). **CE2:** textos de Guests (`guests.data_why`, `guests.signature_statement`, `guests.allergies_notice`) e información práctica (`info.*`, tipo nuevo `info`), en los dos idiomas. Pruebas `tests/central/texts.test.ts` y `texts.spec.ts`.

- 2026-10-08 · Contacto público sin sesión (C1/P9, `0580`), textos de Organizers (X2, `0590`) e **instrucciones de pago** (F3, `0595`: IBAN y Bizum en la Entidad, marcadores y `payment.instructions`).
- 2026-10-08 · **El lugar en los portales** (X3 de Organizers y CE3 de Guests, `0596`): **dirección del lugar de los retiros** (`venue_address`; los portales nunca ven el domicilio fiscal), plano del centro en la Entidad (imagen o PDF, `permanent`) servido a los portales con C8 (`central.site_plan_file`), marcadores `{{entidad.lugar}}` y `{{entidad.mapa}}`, proyección `central.portal_place_projection` para organizers y guests, `info.arrival` pasa al lugar, y los textos `portal.menu_note`, `portal.practical`, `guests.menu_notice` e `info.map_link`.
- 2026-10-08 · **Enlace exacto del mapa** (FB_2026_010, `0597`): `venue_map_url` en la Entidad (solo mapas conocidos), que manda sobre la búsqueda por dirección en `{{entidad.mapa}}` y en los portales.
- 2026-10-08 · **Un correo por público** (`0598`): `contact.<público>.email` (organizadores, huéspedes, equipo y proveedores) en la sección «Correos por público», marcadores por público, `contact.email` pasado a organizadores, `portal.privacy` con el correo de huéspedes y contacto público filtrado por `audience`.
- 2026-10-08 · Versiones nuevas con `initAppUpdates` del kit 0.23 (se aplican solas al abrir si es seguro); fuera la copia local `src/updates.ts`.
- 2026-10-08 · **Textos en español v2** revisados por el usuario (`0599`): 18 claves, sin pisar las editadas a mano; `payment.instructions` sin Bizum.
- 2026-10-08 · **Bloque condicional de Bizum** (`1500`, primer número del segundo bloque de Central) con el Bizum de vuelta en `payment.instructions`, y **protección de datos de los huéspedes sin NIF ni domicilio fiscal** (`1501`).
- 2026-10-08 · Primera prueba de **envío de feedback** (prueba común del kit 0.25.1, `feedback.spec.ts`): en Inicio (`@smoke`) y con la hoja de Entidad abierta y el teclado en pantalla; con doble toque llega un solo reporte.
- 2026-10-08 · **La ficha manda sobre el nombre de la cuenta** (FB_2026_013, opción A del usuario): alta desde la ficha, renombrado sincronizado con el núcleo (con reintento sin red), cuentas del equipo sin ficha o con otro nombre señaladas en Accesos.
- 2026-10-08 · Proyección `central.people_options` para Tasks (FB_2026_015, `1502`): personas activas, también sin cuenta, para ser responsables.
- 2026-10-08 · Playwright: un solo `vite build` para todos los specs (`tests/central/e2e-build.ts`, huella y cerrojo entre workers, patrón de Tasks).
- 2026-10-08 · **Una persona, una ficha, una cuenta:** el alta con un correo que ya tiene cuenta avisa y deja enlazar, fusionar fichas (`central.merge_people`, `1503`) o usar otro correo.
- 2026-10-13 · **Fase P1 · nivel de casa** (`1504`): `house_level` con vista previa editable para dirección, interruptor por aplicar el nivel, Relación y Cobertura conservadas, `people_options` con el nivel sin cambiar de contenido. Antes, la caracterización de Personas (PR 0).
- 2026-10-13 · **Fase P1 · oficios y capacidades** (`1505`): árbol de oficios, capacidades con la estrella del kit, pantalla Oficios, bloque en la ficha, filtro y chips en la lista, lecturas `trade_options` y `capability_options` para Tasks, kit del oficio previsto y fusión con capacidades.
- 2026-10-13 · **Fase P1 · importar oficios de Tasks** con vista previa (`tasks.action_labels`): repetidas juntas, sin duplicar, archivadas sin marcar; Tasks no cambia.
- 2026-10-13 · **O4 · caracterización (PR 0)** antes de «Convertir en outsider»: `outsider.test.ts` (hoy el nivel de casa no toca `core.memberships`; la fusión conserva el nivel de la ficha de destino) y `people-outsider.spec.ts` (filtro Outsider, ficha con su cuenta, Accesos y desenlazar). Lo marcado «hoy» cambia a propósito con O4.
- 2026-10-14 · **O4 · «Convertir en outsider»** (`1506`, núcleo 0092): el nivel de casa da los roles del outsider (Tasks `outsider`, Guests `editor`) mediante un trigger que llama a `core.apply_house_level`, y se aplica a los outsiders que ya tienen cuenta. `GET people/house-grants`. Ficha con «Convertir en outsider» (con o sin cuenta, o dándosela) y «Quitar de outsider» (Sin nivel o Staff); editor que avisa de lo que da el nivel; lista con los accesos de cada outsider, el aviso «Sin cuenta» y «Nuevo outsider»; Accesos con la marca «por nivel de casa» y el selector fijo.
- 2026-10-14 · **O4 · «Convertir y dar cuenta» sin otros accesos** (núcleo 0093, P9): solo la cuenta, con el nombre de la ficha; Tasks y Guests los da el nivel. Con su prueba e2e.
- 2026-10-18 · **R7 · caracterización (PR 0)** antes del panel nuevo: `dashboard.spec.ts` (un grupo por app en el orden de `KPI_SOURCES`, sin plegar ni subtítulos; las 7 de Central por orden de clave con su pantalla; «Objetivo» en cada tarjeta para el owner; un indicador mensual saca una tarjeta por mes) y `trades.spec.ts` (en Oficios, «N personas» cuenta solo las del propio oficio). Lo que cambia a propósito con R7 está marcado así.
- 2026-10-18 · **R7 · panel de indicadores**:
  - **Migración `1507`:** 12 indicadores de personas y oficios en `central.central_kpi_projection`. Las 7 de siempre no cambian.
  - **Recursos** (`0805`, de Core) en `KPI_SOURCES`, detrás de Central.
  - **Panel:** temas por grupo (`KPI_SECTIONS`) y grupos plegables con su resumen. Salen abiertos y el dispositivo recuerda el plegado.
  - **Oficios:** cobertura por nivel con lo que cuelga de cada oficio, chips de aviso y «Solo en riesgo». Desde el panel se llega con `?riesgo`.
- 2026-10-18 · **Series en una tarjeta** (aprobado por el usuario): ocupación de Booking y gasto e ingresos de Finance pasan de una tarjeta por mes a una sola, con el mes en curso, barras de la serie, aviso de otros periodos en crítico o en atención y «Ver N meses». El owner ve unas 50 tarjetas en lugar de 89.
- 2026-10-18 · **Inventario** (kit 0.37 y 0.38; tabla aprobada por el usuario):
  - `#/inventario`, con el catálogo del kit sin ámbito, y `#/inventario/<id>`, con la ficha.
  - Gastar, Entrada, Trasladar, Contar y «Recuento» para editor y owner.
  - Movimientos con quién lo hizo, por su ficha, y su origen («Finance»).
  - `?bajo-minimo` y `?caduca` desde el panel.
  - Barra de cuatro entradas para todos: Accesos se abre desde Inicio.
- 2026-10-18 · **Lecturas para Tasks P2 y O1** (`1509`, aprobadas por el usuario):
  - «Iniciales» en la ficha, opcionales, y en `people_options`.
  - `availability_options`, con la disponibilidad y su orden, para «Quién sabe hacerlo».
  - `people_options`, `trade_options` y `capability_options` abiertas al outsider de Tasks, sin nada reservado (`capability_options` se cerró en la `1513`).
- 2026-10-18 · **Herencia de capacidades** (`1510`, decisión del usuario): lo del padre baja a los hijos, nunca al revés.
  - Grado efectivo en la cobertura, los indicadores y `capability_options` (con `inherited`).
  - En la ficha, el hijo no baja del padre.
  - «Quién sabe hacerlo», «N personas» y el filtro de Personas cuentan lo heredado.
- 2026-10-19 · **K3 para miembros** (`uploads.membersK3`, núcleo #585; encargo aprobado por el usuario). Cierra la P1:
  - `GET files/:id` ya no firma un archivo ajeno solo por conocer su id: hace falta ver una fila viva que lo referencia.
  - La documentación de personas, solo el owner y el editor con `scopes.people`; logotipo, plano y documentos clave, todos los miembros.
  - Sin cambios en pantalla.
- 2026-10-19 · **Tanda 27 · datos y servidor del rediseño** (`1512`, aprobada por el usuario):
  - **Votos de Decisiones:** `central.decision_votes` (un voto por persona, solo el suyo y solo en vigentes) y la decisión final del owner en `central.decisions`, con quién, cuándo y la votación.
  - **Revisión:** `central.review_screens`, con los diez pasos del cuadro; el feedback se une por prefijo o por ruta.
  - Reglas puras en el dominio para las pantallas (lo que te toca decidir, por votar, recientes, rastro, avance y feedback por pantalla).
  - El lector vota desde el 19-10 (núcleo #608, P10). La interfaz llega cuando el kit publique los lotes A y B.
- 2026-10-20 · **Tanda 27 · la interfaz, de una pasada** (MUELA-069 y los traspasos 004, 007, 013, 014, 017, 019, 022 y 027, con las recomendaciones de `PERDIDAS_central.md` aprobadas por VG), con las piezas del kit 0.42–0.48:
  - **Menú lateral común** (013, Central es la primera): la marca abre el cajón; en el ordenador, columna fija y la barra de pestañas abajo. Perfil y rol con la línea de sincronización, tema, recientes (por cuenta y dispositivo), secciones con sus recuentos («Cuentas y accesos» arriba para el owner, Bloque 2), apps, comentarios y ayuda, y «Cerrar sesión» también en el móvil. Búsqueda en la cabecera (Ctrl K) con lo vigente primero (K1). «‹ Volver a…» (K9).
  - **Inicio:** lo que vence, una cosa cada vez, y debajo las 4 siguientes con su fecha; las tarjetas del owner, las tres últimas decisiones y los enlaces de siempre; sin red, el panel dice «Indicadores del …» sin rojo.
  - **Cumplimiento:** Vencimientos con «Una cosa cada vez» (quien edita), la lista de siempre y «Por semanas»; Obligaciones y Documentos agrupados por tipo con lo peor (chips de tipo y `?tipo=`); ficha de obligación con portada, recorrido (No aplica y Cerrada como etiqueta; Bloqueada, parada y con aviso), foco y los datos plegados con «Editar», «Añadir documento» y la papelera; fechas sin hora y con el año cuando no es el actual; «Deshacer» de «Marcar cumplido».
  - **Decisiones:** portada, lo que te toca decidir, la baraja para votar (también quien solo lee), lista en «Lo que vale hoy» y «Ya no valen» con etiquetas de estado y de app, y la ficha entera (`#/decisiones/<id>`) con «Sustituida por» y «Sustituye a», historia, votos y la decisión final del owner.
  - **Entidad:** paso a paso con los seis datos que se notan fuera y la ficha con dónde sale cada dato; hoja corta de un dato (el NIF y el domicilio fiscal, solo en el editor completo, que se conserva y es obligatorio la primera vez).
  - **Textos y contacto:** tablero por destino con cuatro cifras, el texto tal cual lo lee la persona, «Crear aquí» para lo que falta y «Así lo ve tu huésped / quien organiza» en un teléfono (mapa `PORTAL_TEXTS` en el dominio, con prueba contra los portales).
  - **Conflictos:** la bandeja por áreas del kit (K20), con nombres de verdad, quién lo cambió, «Lo mío / Lo de …» y «Deshacer» de 8 s; los rechazados con «Corregir en …», «Descartar» y «Reintentar» solo si el fallo fue pasajero.
  - **Revisión** (nueva, `#/revision`): lo que te toca (owner), cuánto se ha hecho, tablero de los diez pasos y hoja de ruta por app; «Importar pantallas» (JSON pegado o subido, upsert por app y nombre) y «Nueva pantalla», solo el owner.
  - **Oficios:** grupos por oficio principal con el resumen de lo peor y el árbol dentro.
  - Pruebas: `menu-review.spec.ts` y `pasada27.test.ts` nuevas; reescritas `compliance`, `decisions`, `entity`, `texts`, `feedback`, `dashboard` y `people`.
- 2026-10-20 · **Tanda 30 · los siete defectos que midió La Muela sobre #630** (MUELA-086, revisados por Core):
  - **Vencimientos, lector:** también tiene «Una cosa cada vez», con «Abrir y siguiente» y «Ver todo», sin acciones de escribir (069). En Inicio, igual.
  - **Revisión:** quien no administra ve su parte de «Lo que te toca»: los arreglos de lo que comentó, por comprobar. Las acciones del owner siguen siendo suyas.
  - **Revisión sin red:** «Aprobar», «Descartar», «Funciona» y «Sigue fallando» quedan `aria-disabled` con el motivo (`bindOnline`), no apagados sin decir nada. Al volver la red, los comentarios se leen solos.
  - **Accesos sin red:** el aviso sustituye al vacío (085, C6): ni «Todavía no hay cuentas» ni «No hay claves» cuando no se han podido leer. Las fichas salen del espejo también sin red, y la lista guardada ya no marca «Sin ficha» en todas.
  - **`app.css`:** `.note.warn` y `.chip.warn` con la tinta de aviso del kit (5,52:1 en claro y 7,76:1 en oscuro), `.backlink` a 46 px y fuera las compensaciones `color-mix(ink …)`: el `--muted` del kit da 4,56:1 sobre el fondo y más sobre el papel.
  - **Menú:** recuentos en «Cuentas y accesos» (cuentas, por revisar y claves en uso); sin red, «se leen con red».
- 2026-10-20 · **Privacidad · capacidades fuera del alcance del outsider de Tasks** (`1513`, revisión de Tasks): `central.capability_options` queda para lector, editor y owner de Tasks, como la disponibilidad. Los grados de habilidad del personal son datos internos de personas. El outsider sigue viendo quién hace sus tareas y su oficio (`people_options` y `trade_options`).

- 2026-10-20 · **Bloque 2, de una pasada** (MUELA-076, 085 y 089, con `PERDIDAS_central_bloque2.md` aprobado por VG; kit 0.50 y P12 del núcleo):
  - **Cuentas y accesos (085):** cuadrícula cuentas × apps con hoja por casilla y «Deshacer», propietario único avisado, «Nunca ha entrado» y «Desactivada», arreglos en la fila; alta persona primero con «Como {compañero}» y un solo envío; agentes por app con las revocadas plegadas; registro por persona con «Lo grave», día y hora en cada línea, y «Por fecha» a un toque.
  - **Personas (085):** directorio de caras; anillo y «Requiere atención» solo con datos reservados; chips de nivel; equipo y relación en «Filtros»; «Ordenar». **Equipos:** tablero con «Añadir a…» y quitar con «Deshacer».
  - **Ficha de persona (076):** portada con cifras y foco con lo que caduca, solo con datos reservados.
  - **Oficios (076):** buscador, barras de cobertura y chips En riesgo, Sin experto y Solo outsiders.
  - **Inventario (076):** baldosas con «Lista» a un toque, Trasladar, Contar de uno y chips de sitio; ficha con portada y foco.
  - **Inicio (004 y 089):** una sola cola de lo que urge en el orden de `centralAttention` (función pura con pruebas); en el panel, regla de ceros, chips de estado, «Ajustar objetivos», «Meses pasados» y «Previsión».
  - Pruebas: `attention.test.ts` nueva; ampliadas `access`, `inventory`, `people`, `teams`, `trades` y `dashboard`; ajustadas las que usaban los selectores de antes. Fuera `tests/central/menu-helpers.ts` (P11 hecha en el kit 0.50).

- 2026-10-20 · **Tanda 36 · Planos del centro y «Colocar»** (MUELA-024 con sus adendas; núcleo #655 y kit 0.52): pantalla `#/entidad/planos` con el mapa de zonas para todos y, para el owner en el ordenador, subir, sustituir y quitar dibujos, colocar solo con un SVG con nombres (DOMPurify, perfil SVG, sin meterlo en la página), colocar a mano con ratón y teclado, y «Por revisar». El plano en imagen o PDF de la Entidad sigue igual para los portales. Prueba nueva `plans.spec.ts`; el servidor de pruebas reescribe también las subidas de Recursos.

## Pendiente

- Rellenar los datos reales de la entidad y subir `private/logo-ikisai.jpg`: lo hace el usuario en la app cuando esté publicada.
- V2 · Dirección: que cada app publique su `central_kpi_projection` (reparto de Core); después, revisión semanal, OKR y registro de decisiones (C01), si el usuario los quiere.

## Bloqueos

- La fusión de mis PR la ha denegado el control de permisos de la sesión; la #180 la fusionó Core.
