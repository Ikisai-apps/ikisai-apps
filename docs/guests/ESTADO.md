# Guests · estado

## Hecho

- 2026-10-07 · `docs/guests/API.md` (puerta G2, fase 1 · preparación), pendiente de revisión de Core. Incluye:
  - entrada por enlace y aviso de protección de datos;
  - Inicio con lo que falta;
  - «Mis datos» con procedencia y autoguardado;
  - alimentación con consentimiento;
  - firma del parte (menores por su acompañante);
  - información práctica;
  - ayuda y sugerencias;
  - «Guarda tu acceso»;
  - español e inglés;
  - offline.

  Las fases 4 y 5, a grandes rasgos (§13).

- 2026-10-07 · Diseño aprobado por Core. Edge `guests-api` (PR 1 de API.md §12):
  - `createGuestsApp` con subidas al bucket `guests-documents` (PNG o WebP, ≤ 300 KB); la lectura de archivos solo del autor la hace el kit (C7);
  - migración `0600_guests_file_gc`;
  - `tests/guests/api.test.ts` (8 pruebas, la última sobre BG1–BG6 de Booking, #284): canje, ámbito por huésped, ficha, datos con procedencia y conflicto, aviso legal, consentimiento, restricciones, firma (propia sí, ajena no), modo operativo.

- 2026-10-07 · PWA `apps/guests` de la fase 1 (API.md §9 y §12):
  - entrada por enlace;
  - aviso de protección de datos, que bloquea Mis datos y Alimentación;
  - Inicio con lo que falta, según el momento;
  - selector si la cuenta tiene varias personas;
  - Mis datos con procedencia, validación y autoguardado campo a campo;
  - cola local sin red y conflictos con elección;
  - alimentación con «No tengo nada» y consentimiento;
  - firma con el dedo (propia o del acompañante) que caduca si cambian los datos;
  - información práctica de Central;
  - ayuda y sugerencias;
  - «Guarda tu acceso», instalación y salir del dispositivo;
  - español e inglés.

  Pruebas: 14 de nodo y 9 de Playwright (3 `@smoke`). Idiomas con el kit 0.19; textos de Central de la migración 0570.

- 2026-10-08 · Guests en producción en `guests.ikisai.com` (`ven.ikisai.com` redirige). Icono propio de UI y colores terracota; la caché del service worker incluye el contenido de `public/`; sin el filtro de archivos propio (C7 en el kit).

- 2026-10-08 · Diseño de las fases 4 y 5 (API.md §13): experiencia configurable con barra inferior, programa (Booking), menú (Food), plano e información (Central), materiales con `portal-files` (propuesta C8 para O1), preguntas del organizador y elección de habitación atómica (Booking). Peticiones BG9–BG12, FD1, O1–O7, CE3, C8, C9 y U5.

- 2026-10-08 · Fases 4 y 5 construidas con lecturas simuladas (API.md §12):
  - barra inferior por módulos;
  - programa, menú y «Hoy»;
  - materiales con `portal-files` y guardado sin conexión;
  - preguntas con autoguardado;
  - alojamiento (ver, preferir, elegir o pedir, atómico);
  - vista previa de solo lectura.

  Se conectan a la API real según publiquen Booking (BG9–BG12), Food (FD1), Organizers (O1–O3), Central (CE3) y Core (C8 y C9).

- 2026-10-08 · Fases 4 y 5 conectadas a Booking (programa y alojamiento), Food (menú) y Central (lugar y plano). Organizers sigue simulado, con normalizadores de su forma de datos.

- 2026-10-08 · Organizers conectado (#333): experiencia, materiales con `portal-files` y preguntas. Barra y días del kit 0.21, y fotos de los platos (Food #332). Pruebas de las fases 4 y 5 contra la API real.

- 2026-10-08 · Contacto por público (Central #341): Guests muestra `ven@ikisai.com` (`contact.guests.email` o el contacto público con su público); comprobado sin Central y con sus textos sembrados.

- 2026-10-08 · Versiones nuevas con `initAppUpdates` del kit 0.23 (se borra la copia `src/updates.ts`): se aplican solas al abrir si no hay cambios por confirmar.

- 2026-10-08 · K6 en main (#334): las respuestas a las preguntas del organizador se guardan; la prueba las comprueba siempre.

- 2026-10-08 · «Ayuda y sugerencias» con `id` y `requestId` estables del formulario (kit 0.25.2): el doble toque no duplica y la hoja la cierra el kit con su aviso. Prueba común `portalHelpRoundTrip` en `@smoke`, también con el teclado abierto en el móvil.

- 2026-10-08 · Un solo `vite build` para las pruebas de Playwright aunque haya varios workers (`tests/guests/build.ts`, patrón de Tasks): huella en `dist/.e2e-stamp` y cerrojo entre procesos. Probado tres veces seguidas con `--workers=2`.

- 2026-10-13 · Pruebas de caracterización antes de O4 (`tests/guests/caracterizacion.spec.ts`, RECURSOS.md §17.1): entrada y enlaces directos, cambio de retiro, alojamiento, menú y horario. Preparación de O4 (sin programar) en `coordinacion/guests/o4/O4_PREPARACION.md`.

- 2026-10-14 · Supletorias activadas en la elección de cama (BG13, Booking #491): marca «Supletoria» y recuento aparte (`extra_total` y `extra_free`); prueba real en `modules.spec.ts`.

- 2026-10-14 · **O4a: Guests por persona** (§9.12): barra «Calendario · Retiros · Más», pestañas de retiros que conservan la sección, Resumen · Programa · Menú · Alojamiento dentro del retiro, regla de entrada, la familia junta («Todos») con el selector y el calendario del kit 0.33 con «Todos tus retiros». Enlaces directos intactos. Prueba nueva `personas.spec.ts` y caracterización en verde.

- 2026-10-14 · Por enlace, ese retiro (C10, #508): el `grant` de `loginWithLink` decide el retiro de entrada aunque la cuenta tenga varios; prueba en `personas.spec.ts`.

- 2026-10-14 · **O4b, primera parte** (§9.13): pestaña Outsider (estancia, cama habitual, cómo llegar, «Sugerir un plato» y «Mis propuestas»); en el calendario, estancias (crear, cambiar fechas y quitar), «hay alguien del staff» y notas con hora. Prueba `outsider.spec.ts`.

- 2026-10-14 · **O4b, segunda parte** (§9.13): clave de persona de Booking en el selector, estancias en familia («para quién» y «Separar») y retiros abiertos en el calendario.

- 2026-10-14 · **O4b, última parte:** «Apuntarme» en los retiros abiertos (sugerencia a Booking), con su estado y «Retirar»; «Mis propuestas» junta platos y «Apuntarme». O4 completa salvo lo que espera a otros equipos.

- 2026-10-19 · **Tanda 26: alérgenos siempre visibles.** El menú muestra siempre los alérgenos declarados; si cocina no revisó la receta, añade «sin revisar por cocina» (también sin ninguno declarado). Antes, una receta sin revisar no enseñaba ninguno. Prueba en `modules.spec.ts`.

- 2026-10-20 · **G13 (seguridad alimentaria): el menú de la familia cruza a cada persona.** Antes, con «Todos», el Menú solo miraba lo registrado de la primera persona y no cruzaba los platos. Ahora cada plato se cruza con cada persona (`crossRestriction` de Food), con su nombre, y «Cocina tiene registrado…» va persona a persona. Prueba en `personas.spec.ts` (la alergia en la segunda persona).

- 2026-10-20 · **Tanda 31, rediseño de La Muela, parte A** (API.md §9.14): menú lateral del kit, portada del retiro que se pasa y se pliega con el aviso de otro retiro, Resumen por momentos, Programa «Ahora y lo siguiente», Menú «La carta» con el cruce por persona encima de la línea de #597, y Alojamiento con la lista de habitaciones, camas por color con texto y la familia. Pruebas reescritas (no borradas) en `modules`, `personas`, `caracterizacion`, `portal` y `outsider`.

- 2026-10-20 · **Tanda 31, parte B** (API.md §9.14): Guía del retiro (Información, Materiales y Preguntas en una página, con «Nuevo» y preguntas pregunta a pregunta), Tus datos pregunta a pregunta con «Antes de venir» y «Ver todos mis datos», Alimentación como pregunta, «Comprueba tus respuestas» en la firma (solo con el dedo), Ayuda en tarjetas con los estados de 071 y la Entrada con «Encuentra tu enlace» y las salidas.

- 2026-10-20 · **Tanda 31, parte C** (API.md §9.14): Outsider con «Tu estancia» y tus días en la casa con «Sugerir aquí» en cada comida (el formulario de siempre, plegado), «Ikisai» según el momento con la guía en tarjetas y el plano, y Calendario con «Tu próximo retiro», «Tu año», nueva estancia con llegada y salida, invitaciones en tarjetas y el mes plegado con todo lo de antes. Capturas a 390 px en `docs/guests/capturas/t31/`.

- 2026-10-20 · **FD2 y `audience`** (API.md §9.15): el outsider ve el menú de casa en cada hueco de «Tus días», con la línea de alérgenos de #597; el Programa enseña a cada persona solo lo suyo y, con la familia junta, el día en una columna por persona («Libre» en las demás; los menores con aro). Pruebas en `outsider.spec.ts` y `personas.spec.ts`.

- 2026-10-20 · **Mapa de zonas** (API.md §9.16): ruta `GET plans` en la Edge (dibujos firmados) y «Ver en el plano» con `createSpaceMap` y el sitio resaltado; el plano de Central, de respaldo. Pruebas en `api.test.ts` y `modules.spec.ts`.

- 2026-10-20 · **Mapa en Alojamiento y Ayuda** (API.md §9.16): las habitaciones abiertas en el plano con su estado en texto, y «Tócalo en el plano» en Ayuda, con `space_id` en el aviso. Pruebas en `modules.spec.ts` y `portal.spec.ts`.

- 2026-10-20 · **Ids de Recursos y camas en el plano** (API.md §9.16): se casa por `resource_space_id` y `resource_bed_id` de Booking (#680), con el nombre solo de respaldo; en Alojamiento, la habitación ampliada con sus camas encima (kit 0.54). Prueba en `modules.spec.ts`.

- 2026-10-27 · **Acceso que no caduca, «Mis retiros», dirección y fichas de equipo** (API.md §9.17, #730): «Mis retiros» con el estado de la reserva y los cancelados en solo lectura; dirección («todos») con todos los retiros, la vista sin ficha y «Apuntarme» con «¿Con quién?»; etiqueta «Organizas · Equipo · Dirección», sin datos de registro ni firma (G-B2), «Tu ficha de equipo no llega a cocina» (G-B1) y «La cama te la asigna el equipo». Pruebas en `accesos.spec.ts`; `modules.spec.ts` fija el mediodía de Madrid también en invierno.

- 2026-10-27 · **«Tus ofertas de hoy» en el Menú** (API.md §9.18, #754 y #778): `food.portal_offers` cruzado por `meal_group`, internas solo para el equipo, «Incluido · De pago · A cuenta», cruce de alergias por persona (G13) y la carta «a cuenta» de Flow con su número y la cuenta abierta. Pruebas en `offers.test.ts` y `ofertas.spec.ts`.

- 2026-10-27 · **Portal del visitante por QR** (API.md §9.19, #766 y #778): `/e/<código>` sin sesión ni datos (kit de visitantes, #775), el evento, sus ofertas públicas, «Apuntarme» y «Déjanos un dato» en booking-api, «Mis eventos» de este móvil y «Salir de este móvil»; el worker reenvía `X-Visitor`. Prueba en `visitantes.spec.ts`. Pendiente: «Mi pedido» de cada visitante (Flow FL2) y, en la v2, recuperar por correo y pasar a otro móvil.

- 2026-10-28 · **Finca y decoración en el portal** (API.md §9.16): la finca con sus alturas y cotas, la decoración general, las camas con su icono y la bajada de la finca al edificio; sin decoración al elegir cama.

- 2026-10-27 · «Ver en el plano» con los dibujos reales del Albergue y de Salas (`tests/guests/fixtures/planos`, trazados sin cotas ni datos del pliego): cada cama con el icono de su tipo (`bedKind` de Recursos 0816, que antes no llegaba al mapa) y prueba en el móvil (390 px) en `modules.spec.ts`.

## Pendiente

- «Mi pedido» de cada visitante: construido sobre FL2; en uso cuando Flow lo publique (hasta entonces, la carta pública).

- Visitantes, v2: recuperar el acceso por correo y pasarlo a otro móvil (C11, más adelante).

## Bloqueos

- Ninguno.
