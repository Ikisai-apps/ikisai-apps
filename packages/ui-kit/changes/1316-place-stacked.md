### Añadido
- `createPlacePicker({ layout: 'stacked' })`: dos planos a la vez, como en el borrador de la ficha de Tasks que aprobó VG.
  - Encima, la altura y el lado en chips («Interior · Albergue»), siempre a la vista. Al elegir la altura se abre ya su edificio.
  - Debajo, el plano del edificio, donde tocar la estancia ya da el valor, y a su lado (en pantallas anchas) o debajo, la estancia con su retícula de 1 m².
  - Los cuadrantes van nombrados («B3»). Tocar el elegido, o «Toda la estancia», lo quita.
  - Sin migas: la app pinta `path()`. Sin `layout`, el selector se comporta igual que antes.
- `cellName(x, y)`: el nombre del cuadrante («B3»).

### Cambiado
- `placePath` y las migas nombran el cuadrante como el borrador: «Altura 3 › Interior · Albergue › Hab 1 › cuadrante B3». El lado solo sale si la altura tiene más de una zona.

### Arreglado
- `createPlacePicker`: al elegir un cuadrante, el foco se queda en él.
