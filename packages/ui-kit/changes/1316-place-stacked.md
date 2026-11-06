### Añadido
- `createPlacePicker({ layout: 'stacked' })`: dos planos a la vez. Arriba está el del edificio o planta, donde se toca la estancia; debajo, la retícula de cuadrantes de 1 m² de la estancia elegida. Al tocar otra arriba, cambia la de abajo. Sin `layout`, todo sigue igual que antes.

### Arreglado
- `createPlacePicker`: al elegir un cuadrante, el foco se queda en él (antes se perdía al repintar).
