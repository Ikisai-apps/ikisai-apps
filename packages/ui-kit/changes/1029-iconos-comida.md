**K13: iconos de comida en el kit** (`equipo/Revisor/KIT_PETICIONES.md`). Son 19 iconos de trazo, con el estilo de siempre (24 × 24, trazo 1,9). Salen del prototipo de Food (Recetario y Menús, elegidos por VG); el pescado es nuevo.

- **Momentos:** `cup` (desayuno), `bowl` (entrante), `plate` (principal), `leaf` (guarnición), `cake` (postre), `basket` (picnic), `cookie` (merienda), `glass` (bebida), `jar` (base o se puede adelantar).
- **Colecciones:** `timer` (rápidas), `pot` (para muchos).
- **«Sin»:** `noGluten`, `noLactose`, `noNuts`.
- **Tipos de menú:** `vegan`, `cheese` (vegetariano), `drumstick` (mixto), `chefHat` (otro), `fish` (pescetariano).
- Food ya no tiene que registrarlos con `registerIcons`; Booking y Guests pueden usarlos para el régimen de comidas.
- Lámina para revisarlos: `MUELA/equipo/feedback/ui-kit/K13_iconos_comida.png`. Pruebas: `tests/v82.spec.ts`.
