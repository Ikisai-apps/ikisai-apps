**Camas con un solo modelo** (decisión de VG por Core, 27-10; petición de Central). La posición de cada cama vive solo en Booking (`booking.bed_layout_projection`, #1017) y su forma en el dibujo se deriva de la de su habitación. Así Booking, Guests, Tasks y Central pintan lo mismo.

- **`bedShape(habitación, { cols, rows }, { x, y, rot })`** (`src/spaces/bed-layout.ts`, función pura):
  - la habitación se reparte en `cols` de ancho y `rows` de fondo, sobre la caja de su forma;
  - la cama ocupa dos cuadrantes desde `(x, y)`: con `rot` 0, `x` y `x+1` a lo ancho; con `rot` 90, `y` e `y+1` a lo largo;
  - `null` si no cabe o la habitación no tiene forma.
- **`createSyncSpaceSource(client, { bedLayouts })`:** acepta las disposiciones, en lista o en una fuente con `subscribe`; las filas de Booking pasan por `bedLayoutFromRow`.
  - Cada cama con disposición toma la forma derivada, en el dibujo de su habitación, y queda fija (`SpaceRow.shapeLocked`).
  - Las camas sin disposición no se pintan.
  - Si cambian las disposiciones, se repinta.
- **`applyBedLayouts(espacios, disposiciones)`** hace lo mismo para otras fuentes.
- **`createSpaceMap().setShape`** no mueve las formas fijas, así que «Colocar» no les da asas.
- Pruebas: `tests/v81.spec.ts`.
