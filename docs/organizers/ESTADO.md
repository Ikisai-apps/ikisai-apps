# Organizers · estado

## Hecho

- 2026-10-07 · `docs/organizers/API.md` (puerta G2), aprobado por Core.
- 2026-10-07 · Edge `organizers-api` (`portalIssuer: true`, sin tablas ni rutas propias) y `tests/organizers/api.test.ts` (ámbito, lecturas y acciones de Booking, enlaces de huésped).
- 2026-10-07 · PWA `apps/organizers`: entrada por `/i/<token>` (el token sale de la URL antes de pintar), Mis retiros (un solo retiro abre su ficha), ficha del retiro (Resumen, Asistentes, Cocina), alta con declaración, ficha del asistente según el modo (`ses` / `operativo`), «Rellenado ✓» sin valor para lo que escribió otra persona, alimentación, enlace personal con Web Share / WhatsApp / Copiar y reenvío que anula el anterior, recordatorios (persona y grupo sin nombres), baja, «Ayuda y sugerencias» por pasos, «Guarda tu acceso», caché de lecturas y borradores por persona, textos legales y de contacto desde Central con reserva.
- 2026-10-07 · Diseño conjunto PORTALES_V2: mapa de fases en `API.md` §13 (fase 1 detallada; fases 2 a 6 a grandes rasgos; borrador del modelo propio y contrato con Guests) y peticiones de las fases 2 y 3 en `PETICIONES.md`.
- 2026-10-07 · Guardado automático en la ficha del asistente (sin botón «Guardar»): por campo, con estado visible, reintento ante `VERSION_CONFLICT` y envío al recuperar la conexión.
- Pruebas: `tests/organizers/feedback-ids.test.ts` (ids literales y catálogo) y `tests/organizers/portal.spec.ts` (Playwright, 5 recorridos contra las Edge reales sobre PGlite: enlace no válido; recorrido completo; varios retiros y modo operativo; sin red; ayuda).

## Hecho (cierre de la fase 1)

- 2026-10-08 · Publicado en https://organizers.ikisai.com (y `organiza.ikisai.com`).
- 2026-10-08 · Español e inglés con `createI18n` (kit 0.19): clave = texto en español, diccionario `app/i18n-en.ts`, selector ES | EN en la cabecera y en la entrada, repintado al cambiar, fechas y países con `Intl`; textos de Central en el idioma elegido. Prueba de cobertura `tests/organizers/i18n.test.ts`.
- 2026-10-08 · Estado de guardado del kit (`createSaveState`) en la ficha del asistente; «Instala la app» (`createInstallPrompt`): hoja al entrar por enlace y tarjeta en Mis retiros.

## Hecho (fase 2)

- 2026-10-08 · Fechas (Booking B6–B8): pestaña «Fechas» con fecha definitiva (solo lectura), fechas que propone Ikisai (marcar las que vienen bien) o calendario de fines de semana libre / en opción / ocupado; guardado automático con `createSaveState`; tarjeta en el resumen. Pruebas en `api.test.ts` y `portal.spec.ts`.

- 2026-10-08 · Diseño y propuesta (Booking B7d, B9, B10 y B12):
  - pestaña «Diseño» con guardado automático, extras, precio orientativo con el dominio de Booking (`app/quote.ts`) y calculadora privada de margen;
  - pestaña «Propuesta» con «Quiero confirmar», comentarios y su estado.

  Pruebas: `quote.test.ts`, `api.test.ts` y `portal.spec.ts`.

- 2026-10-08 · Pagos y facturas (Finance F1 y F2, Central F3): pestaña «Pagos» con lo facturado, cobrado y pendiente, las facturas del retiro (la emitida, imprimible desde su copia congelada; la registrada, a pedir a Ikisai) y «Cómo pagar». Pruebas en `api.test.ts` y `portal.spec.ts`.

- 2026-10-08 · Lo contratado y el saldo en «Pagos» (Booking #312): total, pagado según Finance, saldo pendiente, forma de pago y vencimientos con su estado.

- 2026-10-08 · G2 de las fases 4 y 5 en `API.md` §15 y §16 (solo diseño): experiencia de Guests, materiales, preguntas y respuestas, programa (Booking), menú (Food), alojamiento delegable, ofertas y cartel. Peticiones B16, B17, Fd2, Fd3, X3 y K3–K5; respuesta a O1 de Guests.

- 2026-10-08 · Fases 4 y 5, primera parte (lo que depende solo de Organizers):
  - tablas `organizers.*` con ámbito por reserva (`visible`, `beforeCommit` y gancho en la base de datos), biblioteca del organizador y archivos en `organizers-materials`;
  - lecturas y acción para Guests (O1, O2, O3, O5 y O7) y resolutor de `portal-files` (C8);
  - pestaña «Experiencia»: qué ven los asistentes, mensaje, alojamiento, materiales, preguntas con aviso de datos sensibles, respuestas y CSV;
  - pestaña «Ofertas»: ofertas, calculadora con lo contratado y cartel en PDF o JPG.

  Pruebas en `experience.test.ts`, `quote.test.ts` y `portal.spec.ts`.

- 2026-10-08 · Fases 4 y 5, segunda parte, con Booking #328, Food #327 y #332 y Central #326:
  - apartados de «Experiencia»: programa por días, menú con fotos y comentarios, alojamiento (ajustes en los dos lados, habitaciones abiertas, reparto de camas, aprobaciones y preferencias) y vista previa de solo lectura;
  - lugar de Central en el cartel;
  - escritura de las respuestas desde Guests (K6) y su borrado a los 6 meses del fin (B18).

  Pruebas en `experience.test.ts` y `portal.spec.ts`.

- 2026-10-08 · Correo de contacto por público (Central #341): el portal lee `contact.organizers.email` de los textos y del contacto público; `contact.email` queda como alias mientras exista.

- 2026-10-08 · Versiones nuevas con `initAppUpdates` del kit 0.23 (sin `src/updates.ts` propio): se aplican solas al abrir o al volver si no hay una hoja abierta ni cambios por enviar; si no, el aviso.

- 2026-10-08 · Condiciones de la propuesta: el texto de Booking (#358) llega con las cifras resueltas y se pinta tal cual (párrafos, saltos de línea y negritas, sin HTML); la lista de tramos del portal queda solo de reserva cuando no hay texto.

- 2026-10-08 · «Ayuda y sugerencias» con `result.id` y `result.requestId` estables del formulario progresivo (kit 0.25.2): un doble toque no duplica el reporte; el aviso y el cierre los pone el kit. Prueba común `portalHelpRoundTrip` en `@smoke`, también con el teclado del móvil.

- 2026-10-08 · Playwright: un solo `vite build` aunque haya varios workers (`buildOrganizersApp()` en `tests/organizers/server.ts`, con huella en `dist/.e2e-stamp` y cerrojo entre procesos, como Tasks); solo se recompila si cambian las fuentes.

- 2026-10-13 · Supletorias por retiro (tanda de Booking): caracterización de Alojamiento y Presupuesto antes del cambio (`tests/organizers/lodging.test.ts` y un recorrido en `portal.spec.ts`); capturas y bocetos en `coordinacion/organizers/capturas/2026-10-13-supletorias`. `freePort` desde el test-kit.

- 2026-10-14 · Supletorias por habitación (Booking #491): contador «N de M» con − / + y su precio en Experiencia › Alojamiento, aviso de pendiente con la propuesta aceptada y supletorias activadas en el reparto. Pruebas en `lodging.test.ts` (5) y `portal.spec.ts`.
- 2026-10-14 · Solicitudes para apuntarse (Booking O2, #518, §26.3): en Asistentes, las que Ikisai pasa al organizador, con nombres, mensaje, Aceptar y Descartar con mensaje opcional para la persona; aviso en Resumen y número en la pestaña. Pruebas en `joins.test.ts` (4) y `portal.spec.ts`.
- 2026-10-19 · K3 para miembros (`uploads.membersK3`, núcleo #585) activado tras revisar campos de archivo, hook `visible` y papelera. Prueba en `experience.test.ts`.
- 2026-10-19 · Menú: los alérgenos se muestran siempre con su nombre (no el código) y con «sin revisar por cocina» si la receta no tiene `allergens_checked`. Recorrido e2e en `portal.spec.ts`.
- 2026-10-19 · Logotipo del retiro para Booking: vista `organizers.booking_logo_projection` (0702) con `core.allow_read` para Booking (API.md §16.6). Prueba en `experience.test.ts`.
- 2026-10-19 · **Rediseño de una pasada (tanda 27, La Muela, consolidado MUELA-072)**, hecho con las piezas del kit 0.42–0.45. Detalle en API.md §18.
  - **Mis retiros:** la lista con portada o iniciales, el recorrido y «Te toca», y «Pasados» y «Cancelados» plegados.
  - **Ficha:** portada, pestañas de 46 px y el Resumen paso a paso.
  - **Diseño:** «Lo que te falta por rellenar» (en la tanda 30 vuelve el veredicto con «Siguiente») y la calculadora «¿Cuánto ganas?», que solo se guarda en el dispositivo.
  - **Propuesta:** las versiones, con «Comparar versiones» (Booking #610).
  - **Pagos:** el extracto.
  - **Asistentes:** por grupos, con la acción en la fila.
  - **Ficha del asistente:** «Lo que le falta».
  - **Cocina:** contra el menú, sin «apto».
  - **Experiencia:** portada por momentos y una ruta por apartado.
  - **Ofertas:** el cartel arriba y los −/+ agrupados.
  - **Cabecera:** «Cerrar sesión» en el móvil.
  - **Botones que necesitan red:** desactivados, con el motivo.
- 2026-10-19 · Menú lateral común (kit 0.47) y «‹ Volver a…» (0.48).
  - **Cajón:** la marca abre el cajón con «Este retiro» (las pestañas visibles de la ficha, con las solicitudes por decidir), tus retiros, las apps de Ikisai con «Ayuda y sugerencias» y «Cerrar sesión». La línea de sincronización sale del cliente.
  - **Cabecera:** se queda el «Cerrar sesión» propio, visible en el móvil. El del kit, que solo se ve en escritorio y no está traducido, se retira hasta la tanda 29 del kit.
  - **`--muted`:** sin el `color-mix`, porque ya da 4,56:1.
- 2026-10-20 · Tanda 30 (MUELA-084, decisión de VG):
  - **Diseño y Fechas:** vuelven al veredicto con «Siguiente: …» de la MUELA-072, con lo que falta debajo (API.md §18.2).
  - **Señal:** «hasta el {fecha}» en lugar de «antes del {fecha}» (Booking): el mismo día del plazo, «antes del» ya parecía tarde.
  - **Comentarios del código:** lo que no decidió VG pone «decisión de Core Sevilla (19-10)».
- 2026-10-20 · Apaños fuera con el kit 0.49 y 0.50:
  - «Cerrar sesión» del kit en la cabecera, también en el móvil;
  - título de la portada como `h2` (`headingLevel`);
  - Intro en las filas de Asistentes y los 46 px de `renderChecks`, del kit; «Rellenar» con nombre propio;
  - una sola línea «sin red» en Asistentes y Alojamiento;
  - «Cómo pagar» entre «Próximamente» y «Movimientos» (`afterUpcoming`);
  - ids literales en los grupos de Asistentes y en los pasos del Resumen;
  - sin `color-mix` en la hoja de estilos.
  - El velo de las portadas de Mis retiros se queda: el del kit es claro en la franja media, y ahí va el texto.
- 2026-10-20 · Portadas de Mis retiros con el velo completo del kit (`veil: 'full'`, 0.51); fuera el refuerzo propio.
- 2026-10-20 · «Para quién» en Experiencia › Programa (MUELA-065, Booking #664): todos, solo adultos, solo menores o algunas personas, con la etiqueta en la lista del día (API.md §18.3).

- 2026-10-26 · **Acceso que no caduca, dirección como coorganizadora y «Verlo como huésped»** (encargo de VG; PR #718, en borrador hasta que estén Booking 0481, Core 0095 y Guests Gu1):
  - **Entrada:** «Este enlace ya no está activo» en lugar de «si tu retiro sigue en marcha».
  - **Ámbito «todos»** (`{"all": true}`) en `_domain/organizers` (`hasAllReservations` e `inReservationScope`). El gancho de la base de datos lo cubre K8.
  - **Mis retiros:** buscador, «Coorganizas» y portadas diferidas con «todos».
  - **Ficha:** la línea de coorganización y «Verlo como huésped».
  - **Propuestas del equipo de Ikisai** (respuesta de VG, migración 0703): dirección sin permiso propio propone en lugar de escribir, y quien organiza acepta o descarta desde su ficha (PETICIONES, respuestas de VG). En Mis retiros, «N propuestas del equipo» en la tarjeta. Detalle en API.md §19.

  Pruebas en `scope.test.ts`, `proposal-draft.test.ts` y `team-proposals.test.ts` (PGlite).

- 2026-10-27 · **Propuestas del equipo con archivos** (VG por Core): dirección sube el archivo del material al momento (`app/upload-now.ts`) y la propuesta lleva su `file_id`. Quien organiza lo lee al aceptarla. Prueba en `team-proposals.test.ts`.
- 2026-10-27 · **Comida que se ofrece** (VG por Core; Food Fd4, `food.portal_offers`, migración 1111): en Experiencia › Menú, el menú cerrado y las cartas con quién paga, cuándo, dónde y sus líneas con precio; lo interno no se ve (API.md §20). Prueba en `food-offers.test.ts`.
- 2026-10-27 · **Notas de Central en Fechas, Diseño y Propuesta** (X2, central 0590): `organizers.dates_note`, `organizers.quote_note` y `organizers.proposal_note` se leen de Central como los demás textos comunes, con reserva en los dos idiomas.

## Pendiente

- Fase 1: cerrada salvo la cuenta permanente (Workspace). Icono propio de la PWA (de UI) desde el 8-10-2026.
- Fase 2: cerrada (B14 hecha en #310: tipo de reserva, montaje, apoyo técnico y notas en el diseño).
- Fase 3: abrir el PDF de una factura registrada. K2 está reabierta con propuesta en PETICIONES: Finance o Core da la función de servicio y Organizers hace la ruta y el botón.

- Alta de infraestructura (C5): publicación, Pages y `organizers.ikisai.com` con `organiza.ikisai.com`.
- Puntos abiertos que decide el usuario: API.md §13.
- Bandeja «Comentarios del retiro» (fase posterior del feedback).

## Bloqueos

- Ninguno.
