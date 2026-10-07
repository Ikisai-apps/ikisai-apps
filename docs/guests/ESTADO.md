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
  - `createGuestsApp` con subidas al bucket `guests-documents` (PNG o WebP, ≤ 300 KB) y `GET files/:id` cerrada;
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

  Pruebas: 14 de nodo y 8 de Playwright (3 `@smoke`).

## Pendiente

- Pasar a la capa de idiomas del kit cuando se fusione la #285 (cambiar el import de `app/i18n.ts`).
- Alta de infraestructura de Core (C3): publicación, Pages y `guests.ikisai.com` con `ven.ikisai.com`.
- Fases 4 y 5 (API.md §13) cuando Organizers publique su configuración.

## Bloqueos

- Ninguno para la fase 1. Textos de Central (#281) y contacto público (C1): mientras no estén, los textos de reserva.
