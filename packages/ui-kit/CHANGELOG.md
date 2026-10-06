# Cambios de @ikisai/ui-kit

## 0.2.1 · 6 de octubre de 2026

- Listas: los fragmentos de `.row-meta` se separan con un punto medio (antes dependía de que la app lo pusiera).

## 0.2.0 · 6 de octubre de 2026

- `openSheet` / `closeSheet`: hoja inferior (diálogo centrado en escritorio) con una sola instancia, foco atrapado, Escape y fondo, `beforeClose` para cambios sin guardar, pie ocultable y foco devuelto al abrir.
- `confirmDialog` / `alertDialog`: diálogo modal que resuelve una promesa; variante `danger` enfoca «Cancelar».
- `renderConflict` / `renderConflicts` sobre `PendingConflict`: tabla campo a campo, «Mantener la mía», «Tomar la del servidor» y «Combinar campo a campo» (contrato §6.3); `SYSTEM_COLUMNS`.
- `renderRejected` / `renderRejectedList` sobre `RejectedBatch` (sync-client 0.2): resumen de operaciones, error del servidor, «Reintentar» y «Descartar».
- Barra de estado: cuenta `rejected` (`data-rejected`, «N rechazados» en el texto) y banner de rechazados con «Ver», «Reintentar» y «Descartar»; aviso `USER_CHANGED` como banner informativo sin tratarlo como error.
- `listRow` / `renderList`: lista con filete y chip «Pendiente de sincronizar», papelera, selección y filas pulsables accesibles.
- `createThemeToggle` (sol/luna para la cabecera) y `createThemeSelect` (Sistema / Claro / Oscuro).
- `createCommandPalette` (Ctrl K): grupos, búsqueda sin acentos, teclado, `hiddenWhenEmpty`; `filterPaletteItems` y `foldText` exportados.
- Utilidades de foco: `trapFocus`, `focusFirst`, `focusables`, `lockScroll`.
- Demo y 12 pruebas nuevas (6 escenarios × 2 tamaños).

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
