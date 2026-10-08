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

## Pendiente

- Alta de infraestructura de Core (C3): publicación, Pages y `guests.ikisai.com` con `ven.ikisai.com`.

## Bloqueos

- Ninguno para la fase 1. Mientras no exista el contacto público (C1), la pantalla de enlace no válido usa el contacto de reserva o la última copia guardada.
