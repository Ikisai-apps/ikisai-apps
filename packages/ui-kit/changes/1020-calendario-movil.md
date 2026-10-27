**K19 + K23: el calendario en el móvil y su contraste en oscuro** (`equipo/Revisor/KIT_PETICIONES.md`, abiertas por Core el 27-10).

- **K23, el día entero es el objetivo:** en pantallas táctiles y sin `agenda`, tocar un día con eventos abre una hoja con ellos.
  - Cada evento mide al menos 46 px y lleva el color de su capa, su texto entero y el nombre de la capa.
  - Tocar uno llama a `onSelectEvent` y cierra la hoja. `onSelectDay` se sigue llamando como antes.
  - Las barras del mes (de pocos píxeles) dejan de recibir toques.
  - Con ratón, con `agenda`, o con `daySheet: false`, todo queda como antes.
  - Nueva marca: `evento_dia`. Solo se cataloga si la llamada usa `onSelectEvent`.
- **K19, contraste en oscuro:** el texto de los eventos lleva el 45 % del color de la capa, antes el 70 %. Con colores de capa habituales pasa de 3,7–4,5:1 a 5,5:1 o más; en claro no cambia.
- `v03` comprueba ahora la hoja con el dedo y la barra con ratón. Pruebas: `tests/v80.spec.ts`.
=======
