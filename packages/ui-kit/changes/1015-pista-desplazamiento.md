**K4: pista de desplazamiento en las filas horizontales** (`equipo/Revisor/KIT_PETICIONES.md`, abierta por Core el 27-10). Una fila de chips más ancha que la pantalla no decía que había más.

- **`.scrollrow`**: fila de chips o botones en una línea, con desplazamiento horizontal y sin barra.
- **La pista:** el borde que tiene contenido detrás se difumina (`data-more-start` / `data-more-end`, con máscara). Solo cuando la fila desborda, y cambia al desplazar o al cambiar el ancho o los hijos.
- **`installScrollHints(root)`** vigila `.scrollrow` y las tiras del kit (`.viewstrip`, `.daytabs`, `.lanes-tabs`, `.stk-tabs`, `.pl-tabs`, `.fb-tabs`), también las que aparecen después.
  - **`createAppShell` lo instala sola**: las apps no tienen que hacer nada; les basta con usar `.scrollrow` en sus filas de chips.
- **`watchScrollHint(nodo)`**, para una fila suelta.
- Demo: «Fila de chips con pista de desplazamiento (K4)». Pruebas: `tests/v79.spec.ts`.
=======
