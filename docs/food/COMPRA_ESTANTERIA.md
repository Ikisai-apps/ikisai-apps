# Food · Compra «Estantería» con el envase (tanda 40, MUELA-093)

Fuentes: `MUELA-093-HANDOFF_food-compra-b2.md` (con el «ok» de VG), `PERDIDAS_food_093.md` (§1–§4 y las decisiones del
20-10-2026) y el kit 0.57.0 (`Envase`, `renderTile` con `actions`, `createShelves`). Datos: `resources.item_units.usual`
y `price` (0810) y la migración de Food `20261020_1108_food_shopping_packs.sql`.

## Qué cambió y qué se conservó

| Pantalla | Qué cambió | Qué se conservó |
|---|---|---|
| Arriba | El dinero: «≈ 24,80 €», «faltan precios de N productos» y la barra de lo que usa el menú frente a lo que va a la Despensa. Las tiendas en pastillas («Mercadona · 2 de 2 · ≈ 3,30 €»), que bajan a su estantería. La leyenda del dibujo. | La chip de estado, «N por comprar / Todo comprado», «Generada el …», «la lista es provisional», el aviso de cambios con «Regenerar lista», las acciones de la lista, «Añadir línea», la barra de días y las listas de casa. |
| Cada tienda | Una estantería (`createShelves`) con medallón y color derivado del nombre (S4); «Sin tienda» al final. Al pie, el lote «Comprado lo de Mercadona · 2 · 3,30 €» con «Deshacer». | — |
| Cada producto | Una baldosa: medallón con iniciales (S3), el envase dibujado (botón para definirlo o cambiarlo), lo que se compra en grande («2 paquetes de 1 kg»), «usa 1,1 kg · sobra 900 g» o «Sin envase: lo justo», el precio o «sin precio», el carrito (46 px, «En el carro» en verde, con «Deshacer») y el «⋯». | «Necesario / Bajo mínimo / Añadido a mano», el proveedor, «Mínimo», las chips «A mano», «Compra fijada», «Ya no hace falta» y «Pendiente de sincronizar». «En casa» y «Comprar», en la hoja del «⋯», como en el diseño (la baldosa no crece y dice «En casa N»; autorizado por Core cambiar solo cómo llega a ellos la caracterización R5). |
| «⋯» | Hoja con la frase del envase, «En casa» y «Comprar» (en lo comprado, corrigen la Despensa), el estado (Pendiente, Comprado, Recibido), «Recalcular» y «Quitar». | Las mismas acciones de la fila de antes. |
| El envase | `Envase.formatSheet`: «Como en el último ticket» (si la unidad de la última compra es un envase del artículo), sugerencias, «Otro envase», precio y vista previa. «Guardar en la Despensa» crea la fila (o usa la que tiene el mismo nombre y tamaño), sin proveedor, y la deja habitual; desmarca la anterior en el mismo commit. Nunca cambia el factor de una fila existente. La lista redondea al momento. «Deshacer» devuelve la marca al envase anterior. En una línea comprada el dibujo no es botón. | Quitar un envase sigue siendo cosa de la ficha de la Despensa. |
| Lo comprado (H-C5) | Cambiar «En casa» o «Comprar» en una línea comprada corrige la Despensa con la diferencia, con la misma referencia. Regenerar no toca sus cantidades. | La línea comprada sigue editable, como hoy. |
| «Reponer» y «Ya hay en casa» | En baldosas; «Ya hay en casa», plegado. | `#restockList` y su texto. |
| Lector y sin red | El lector ve las baldosas sin carrito, lote, «⋯» ni hoja. Sin red, marcar, el lote, las cifras y el envase van por la cola; «Regenerar», apagado con su motivo. | Igual que hoy. |

## El dinero

Precio del envase: `item_units.price`; si no, la última compra de Invoices (importe ÷ cantidad); si no, el coste medio del
artículo en Recursos (como `item_costs`). Los totales llevan «≈»; un producto sin precio dice «sin precio» y se cuenta en
«faltan precios de N productos»; nunca se suma un 0 €.

## Pendiente

- «Como en el último ticket» con el tamaño exacto necesita `item_factor` de la línea de factura, que Food no puede leer
  (`invoices.food_stock_projection` no lo trae). Pedido a Core.
- Finance costea solo la entrada enlazada (`entered_movement_id`): la diferencia de H-C5 queda sin coste. Avisado a Core.
