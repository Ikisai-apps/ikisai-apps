### Añadido
- Icono por oficio (VG 06-11): `TRADE_ICONS`, las 12 claves que guarda Central en `central.trades.icon` (fontaneria, electricidad, pintura, jardineria, limpieza, cocina, albanileria, carpinteria, cerrajeria, climatizacion, piscina, mantenimiento), y `tradeIcon(clave, nombre)`, que sin clave deduce el icono del nombre.
- Iconos nuevos `brick`, `fan` y `pool`, dibujados por Tasks en el trazo del kit.
- `createTradePicker` pinta el icono del oficio en el árbol, la búsqueda y las chips; cada especialidad lleva el de su oficio. Con `icons: false` no pinta ninguno, y `icons` también acepta una función propia.
- `createSpacePicker({ iconOf })`: un icono del kit delante de cada nombre.
