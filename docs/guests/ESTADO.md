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
  - `tests/guests/api.test.ts` (7 pruebas): canje, ámbito por huésped, ficha, datos con procedencia y conflicto, aviso legal, consentimiento, restricciones, firma (propia sí, ajena no), modo operativo.

## Pendiente

- PWA `apps/guests` (PR 2 a 4 de API.md §12), en cuanto entre la #278 (`loginWithLink`).

## Bloqueos

- Ninguno para empezar la Edge. La PWA necesita `loginWithLink` (#278) y, para los textos, la #281 de Central.
- La marca de procedencia, el autoguardado sin relecturas y «Alimentación revisada» necesitan BG1–BG3 de Booking. Mientras no estén, hay alternativas provisionales (API.md §9.3 y §9.4).
- El inglés completo necesita la capa de traducción del kit (U1).
