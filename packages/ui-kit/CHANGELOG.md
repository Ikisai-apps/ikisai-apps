# Cambios de @ikisai/ui-kit

## 0.1.1 · 6 de octubre de 2026

- Barra de estado: «Todo sincronizado» (en vez de «Todo guardado») cuando hay red y la cola está vacía, como ya mostraba Invoices.
- `apps/invoices` consume el kit: tokens, login, shell, barra de estado, DOM, iconos y toast.

## 0.1.0 · 6 de octubre de 2026

Primera entrega: tokens + barra de estado + shell de login.

- Tokens «Taller» (`tokens.css`): color, Fraunces + Inter alojadas, espaciado, radios, sombras, capas, movimiento; modo oscuro cálido automático y manual (`data-theme`); acento derivado de `--accent` que la app puede fijar con el color elegido por la persona.
- `base.css`: reinicio, tipografía, foco visible, utilidades, `prefers-reduced-motion`.
- `components.css`: botones, campos, chips (incluido pastel por `--chip`), tarjetas (incluida `.colored`), listas con fila pendiente, secciones, vacíos, esqueletos, FAB, banners, toast, pastilla de estado, marca, shell (cabecera, navegación inferior/lateral, contenido), login, hoja inferior, diálogo y conflictos (solo CSS).
- `dom.ts`, `icons.ts` (46 iconos de trazo, registrables), `theme.ts`, `toast.ts`.
- `createStatusBar` y `statusBanners` sobre `SyncStatus` (contrato §6.4).
- `renderLogin` y `createAppShell` comunes.
- Demo `demo/index.html` y pruebas Playwright (`tests/demo.spec.ts`) a 390 px y 1440 px.
