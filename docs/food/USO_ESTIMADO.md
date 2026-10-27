# Food · primer estimado de utilidad de sus funcionalidades

UX-Food, 27-10-2026. Encargo de Core sobre la decisión de VG: cada app da un primer estimado de la audiencia y la frecuencia de sus funcionalidades. Con eso, Dirección decide desde Central sobre algo y no sobre el valor por defecto («normal», sin audiencia).

- **Origen de los ids:** son los de `usage.run` y `usage.track` del código, los mismos que sube `feature-catalog.json`.
- **Frecuencia:** usa los valores de la 0071:
  - `frequent`: todos los días de servicio;
  - `normal`: cada semana o cada evento;
  - `occasional`: algunas veces al mes o a la temporada;
  - `rare_critical`: rara, pero tiene que funcionar cuando hace falta.
- **Audiencia:** son equipos con nombre descriptivo, hasta que Central tenga sus ids:
  - `cocina`: quien cocina y prepara;
  - `jefatura_cocina`: quien planifica menús, cartas y compras;
  - `direccion`;
  - `sala`: barra y servicio.
- **Es una estimación**, no una decisión: la decisión es de Dirección.
- **Cómo llega al núcleo:** `core.usage_catalog_ingest` no lee estos campos; hoy solo los pone `core.usage_decide`, que es del dueño del ecosistema. Este archivo es el dato. El cauce para cargarlo lo decide Core.

| Funcionalidad | Qué es | Audiencia | Frecuencia |
|---|---|---|---|
| `food.cocina.marcar_hecho` | Marcar un paso hecho en Cocina | cocina | frequent |
| `food.preparacion.marcar_hecho` | Marcar un paso hecho en Preparación | cocina | frequent |
| `food.menu.consumo.confirmar` | Confirmar el consumo de un servicio | cocina | frequent |
| `food.preparacion.guardar_paso` | Añadir o editar un paso de preparación | cocina, jefatura_cocina | normal |
| `food.preparacion.generar` | Generar la propuesta de preparación | jefatura_cocina | normal |
| `food.menu.anadir_plato` | Añadir un plato a un servicio | jefatura_cocina | normal |
| `food.menu.anadir_servicio` | Añadir un servicio a un menú | jefatura_cocina | normal |
| `food.menu.validar` | Validar un menú | jefatura_cocina | normal |
| `food.menu.compartir` | Compartir el menú con el organizador | jefatura_cocina | normal |
| `food.menu.responder_comentario` | Responder al organizador | jefatura_cocina | occasional |
| `food.menu.borrar` | Borrar un menú | jefatura_cocina | rare_critical |
| `food.menu.casa.crear` | Crear el menú de casa | jefatura_cocina | rare_critical |
| `food.menu.casa.anadir_servicio` | Añadir comida o cena en casa | cocina, jefatura_cocina | frequent |
| `food.menu.casa.plato_rapido` | Plato rápido en el menú de casa | cocina | frequent |
| `food.menu.casa.personas` | Personas del menú de casa | cocina | normal |
| `food.menus.sugeridos.votar` | Votar un plato sugerido | cocina, direccion | occasional |
| `food.menus.crear_carta` | Crear una carta | jefatura_cocina | occasional |
| `food.carta.anadir` | Añadir una línea a la carta | jefatura_cocina | occasional |
| `food.carta.precio` | Cambiar el precio de una línea | jefatura_cocina, direccion | occasional |
| `food.carta.disponible` | Marcar una línea agotada o disponible | sala, cocina | frequent |
| `food.carta.copiar` | Usar la carta en otro evento | jefatura_cocina | occasional |
| `food.carta.prevision.unidades` | Unidades a cubrir de la carta | jefatura_cocina | occasional |
| `food.carta.prevision.asistentes` | Asistentes esperados de la carta | jefatura_cocina | occasional |
| `food.carta.prevision.rellenar` | Rellenar la previsión por persona | jefatura_cocina | occasional |
| `food.carta.prevision.reparto` | Reparto mesa, nevera y fresco | jefatura_cocina | occasional |
| `food.carta.prevision.rendimiento` | Rendimiento del ingrediente | jefatura_cocina | occasional |
| `food.carta.prevision.imprimir` | Imprimir la previsión | cocina | occasional |
| `food.eventos.crear_menu` | Crear el menú de un evento | jefatura_cocina | normal |
| `food.eventos.oferta` | Oferta de comida del evento | jefatura_cocina | occasional |
| `food.eventos.compra.comprado` | Marcar comprado en la compra del evento | jefatura_cocina | normal |
| `food.eventos.compra.pedir` | Pedir a Tasks desde la compra del evento | jefatura_cocina | normal |
| `food.eventos.compra.ver_tasks` | Ver el pedido en Tasks | jefatura_cocina | occasional |
| `food.eventos.compra.imprimir` | Imprimir la compra del evento | jefatura_cocina | occasional |
| `food.compra.generar` | Generar la lista de la compra | jefatura_cocina | normal |
| `food.compra.anadir_linea` | Añadir una línea a la compra | jefatura_cocina | normal |
| `food.compra.envase` | Ver el envase en la estantería | jefatura_cocina | normal |
| `food.compra.envase_guardar` | Guardar el envase de un artículo | jefatura_cocina | occasional |
| `food.despensa.a_la_compra` | Pasar de la Despensa a la compra | cocina, jefatura_cocina | normal |
| `food.recetario.guardar` | Guardar una receta | jefatura_cocina | normal |
| `food.recetario.foto` | Foto de una receta | cocina, jefatura_cocina | occasional |
| `food.maquinaria.guardar` | Guardar una máquina | jefatura_cocina | occasional |
| `food.maquinaria.avisar_averia` | Avisar a Tasks de una avería | cocina | rare_critical |
| `food.organizador.imprimir` | Imprimir la hoja del organizador | jefatura_cocina | normal |
| `food.cierre.cerrar` | Cerrar el menú tras el evento | jefatura_cocina | normal |
| `food.cierre.guardar_notas` | Notas del cierre | jefatura_cocina | normal |
| `food.conflictos.resolver` | Resolver un conflicto de sincronización | cocina, jefatura_cocina | rare_critical |
