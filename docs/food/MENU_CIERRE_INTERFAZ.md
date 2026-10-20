# Food · Ficha de menú y Cierre (tanda 38, MUELA-091)

Fuentes: `MUELA-091-HANDOFF_food-menu-cierre.md` (Ficha A «Portada y foco» y Cierre A «Veredicto y comprobaciones», con el
«ok» de VG), `PERDIDAS_food_091.md` (§1 a §4, aprobadas) y el ajuste de VG del 20-10-2026 («sin saturar»). Sin datos,
migraciones ni piezas nuevas del kit: `renderCover`, `createFocus`, `renderChecks` y `bindOnline`, como ya estaban.

## Qué cambió y qué se conservó

| Pantalla | Qué cambió | Qué se conservó |
|---|---|---|
| Cabecera común (las cinco pestañas) | Las restricciones pasan a **una sola línea plegada** encima de las pestañas: solo la alergia grave (si la hay) y el recuento («+3 · 8 avisos»), sin fondo rojo. Sin restricciones ni avisos, no sale. Se abre sola en un único caso: pestaña Menú, en borrador o en revisar, con avisos por aceptar, y lo dice en rojo («5 avisos por revisar antes de validar»). Si la persona la abre o la cierra, se respeta. | Al abrirla, todo lo de antes: cada restricción con las alergias destacadas, cada aviso una vez (`#menuWarnings`) y «Ninguna comunicada». Junto a la alergia que no se puede cruzar, «no se puede comprobar, revisar a mano». «← Menús», el estado, «Pendiente de sincronizar», «Cocina», el aviso de evento cambiado con sus tres botones y el de comentarios nuevos. |
| Ficha de menú · pestaña Menú (retiro) | Portada del kit (estado, servicios, platos, platos con aviso y coste por persona); «Lo siguiente» con el próximo servicio; el foco con lo que falta, de uno en uno (consumo por confirmar con el aviso de las 24 h, alérgenos sin revisar, posibles sin declarar, comentarios sin resolver, compra sin cerrar) y «Resolver». Validado, cerrado o para el lector, el menú se lee: hora y raciones en texto, medallón y el ⚠ del cruce en cada plato (`dishSafety`, los cuatro motivos); lo ya servido de cada día, plegado, con el estado del consumo (✓ solo con «Consumo anotado»; «Se está descontando solo» en ámbar). Estado, portal, comentarios y coste, plegados con su resumen en el título. | Constructor editable sin cambios (arrastre, «Añadir plato», «Añadir servicio», el selector que bloquea los rápidos en un retiro). Dentro de los plegados, todo en el DOM: `#menuActions` (botones por estado, «Borrar menú», el aviso sin red), `#menuShare` («¿Compartir igualmente?»), `#menuComments` (responder, visto, resuelto, borradores) y `#menuCost` (desglose, fecha, sin precio, precio viejo). «Ver comentarios» abre su plegado. `#cookView` en el sitio, con el coste por plato. «Confirmar consumo» sigue con el menú cerrado. |
| Coste en la portada y en el título | Dice si faltan precios («faltan precios de 3 ingredientes») o son antiguos, y «sin datos de compras» sin Invoices; nunca 0 €. | Dentro, los dos avisos de siempre. |
| Portal plegado | El título dice «Compartido con el organizador» o «Sin compartir». | Compartir y dejar de compartir, el texto del lector y la confirmación. |
| Menú de casa | Nada. | Su cabecera, semanas, «+ Comida» y «+ Cena», plato rápido; sin restricciones, portal, Organizador ni Cierre. |
| Cierre | Dos comprobaciones más: comentarios del organizador resueltos (rojo con nuevos, ámbar sin resolver, «Ver comentarios») y alérgenos revisados (rojo: sin revisar o posible sin declarar, «Abrir en el Recetario»). «Menú cerrado», la última; «Cerrar menú» también aquí, atado a la red. Con algo pendiente va en gris con «Puedes cerrarlo igualmente…», y sin nada, en verde; no se bloquea ni pide confirmar. Las notas sin guardar se guardan antes de cerrar. | Las cinco comprobaciones con sus tonos y enlaces; el ✓ de consumo solo con «Consumo anotado». Notas del menú y cierre de cocina, que guardan sin red; el lector sin acciones y con los campos apagados; «No sale en el menú del organizador»; el aviso al salir con cambios sin guardar. |
| Cocina | M1: si Booking ya nombra el alérgeno, no se repite («frutos de cáscara (pistacho)», no «… (frutos de cáscara (pistacho))»). | Todo lo demás. |
| Pestañas | 46 px de alto. | El orden y las marcas. |

## Pendiente para otra pasada

- M2 (preferencia «sin cilantro») y M3 (bebidas vegetales como lácteos) no entran: M3 avisa de más, que es el lado seguro.
- H-C5 (Compra) no es de estas pantallas.
- El foco del kit solo admite un texto para «abrir»: va «Resolver», y cada tarjeta dice dónde se arregla.
