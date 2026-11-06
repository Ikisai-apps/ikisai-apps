### Cambiado
- `createPlacePicker`: la ruta se ve entera y se lee como tal: «Alturas › Altura 3 › Interior › Albergue › Hab 1 › Cuadrante 2, 3». El lado solo aparece si la altura tiene interior y exterior, y el cuadrante en columna y fila de la habitación. Cada paso se toca para volver.

### Añadido
- `placePath(rows, plans, value)` y `picker.path()`: la misma ruta en texto para la ficha («Altura 3 › Albergue › Hab 1 · 1 m²: 2, 3»).
