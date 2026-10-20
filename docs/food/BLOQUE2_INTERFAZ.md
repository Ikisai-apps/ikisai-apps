# Bloque 2 · Inicio, ficha de receta, «Casa» y barra (MUELA-077)

Aprobado por VG el 20-10-2026 con `coordinacion/ampliacion/revision-muela/PERDIDAS_food_bloque2.md`:
- §1: conservar;
- §2: obligatorio;
- §3: conservar;
- §4: lo hace Food.

El kit 0.50 trae `createItemCatalog({ layout: 'baldosas' })`.

**Regla de la pasada:** cero regresiones.
- Las pruebas de caracterización (`caracterizacion.spec.ts` y `caracterizacion-r5.spec.ts`) no se tocan y siguen en verde.
- Lo que el diseño cambia se reescribe en las demás pruebas (`pantry.spec.ts`, `resources.spec.ts`, `smoke.spec.ts` y `feedback-ids.test.ts`); no se borra ninguna.
- Pruebas nuevas: `stock-need.test.ts` (dominio) y `bloque2.spec.ts` (navegador, 390 px).

## Pantalla · qué cambió · qué se conservó

| Pantalla | Qué cambió | Qué se conservó (y cómo) |
|---|---|---|
| **Barra** (C) | Cinco entradas: Inicio · Eventos · Menús · Recetario · **Casa** (icono `grid`). A 390 px caben enteras. | `#/despensa` y `#/maquinaria` siguen vivas: abren su pestaña dentro de Casa. Inicio se ilumina en `#/conflictos` y `#/cocina`, y Menús en Sugeridos. Las secciones del menú lateral no cambian. |
| **Casa** (`#/casa`, nueva) | Una pantalla con dos pestañas (`segmented`): **Despensa** y **Maquinaria**. `#/casa` abre la última que se usó en el dispositivo. | Cada pestaña es la pantalla de siempre, con su `data-feedback-id` (`food.despensa` y `food.maquinaria`). |
| **Inicio** (C) | **Abierto:**<br>• «Ahora en cocina»;<br>• las máquinas que fallan y hacen falta en un menú que viene;<br>• «Hoy en casa» y «Consumo por confirmar»;<br>• **«Lo que falta en la despensa»**: hasta seis filas, en este orden: lo ya **caducado**, lo que caduca en dos días, lo bajo mínimo con **«A la compra»** y lo que caduca esa semana;<br>• los próximos eventos.<br><br>**Plegado:** «Cocina y este dispositivo» (Recetario, Maquinaria, Sincronización, Instalar y Cuenta). Su título dice **«n máquinas fallan»** en rojo. | «Ahora en cocina» con sus alergias, y las tarjetas de evento con su coste y lo que falta. Los ids `#upcoming`, `#houseToday`, `#consumeDue`, `#pantryCard`/`#pantry` y `#logoutHome`. Las cifras de Equipos y Averiados. Las cifras «Bajo mínimo» y «Caducan en 7 días», con su enlace filtrado, ahora de 46 px. «A la compra» solo para editor y owner, con el aviso sin red que ya traía. |
| **Ficha de receta** (B) | **Portada:**<br>• «Para el viernes 23, comida · 24 raciones · 2/3 en casa · 1 falta · 1 bajo mínimo»;<br>• sin revisar, la píldora dice «Alérgenos sin revisar».<br><br>**«Seguridad»**, justo después.<br><br>**Foco:** lo que falta o está bajo mínimo, de uno en uno.<br><br>**Cada ingrediente:**<br>• la cantidad del **servicio** en grande y, debajo, la de la **receta** («Receta, 10 raciones: 50 ml»);<br>• el estado en palabras («Hay bastante», «Faltan 3,6 unidades», «No hay en casa», «Sin seguimiento en Recursos»);<br>• la fila entera lleva a la Despensa.<br><br>**«Hay bastante» solo si nada lo pone en duda.** Si no: «En casa 1,5 l · también lo usa puré de patata del mismo servicio» o «· falta descontar lo gastado el sáb 17». | El bloque «Seguridad» tal cual (alérgenos declarados, «ninguno declarado», «Alérgenos sin revisar», el aviso de alérgeno sin declarar). El coste por ingrediente, **plegado** (decisión de VG), y el total, que dice a qué raciones se refiere. El aviso de plato rápido, el nombre público, «Foto sin descargar», «hacen falta n y hay m», la conservación y `?receta=`. «En casa: 3 kg» sigue y ahora va en unidad legible. |
| **Despensa** (B) | Las baldosas son las del kit (`layout: 'baldosas'`), la misma pieza que el Inventario de Central, y se quitan las propias de Food. «A la compra», en las baldosas que llevan mínimo. | La vista «Lista» a un toque, con buscador, filtros, chips de sitio, alta y sus acciones. «Contar» en la cabecera. El origen de cada movimiento. El filtro que llega por enlace se devuelve al salir. El aviso sin sitios de cocina y el de sin red. `toShopping` sin cambios: pasa de `pantry.ts` a `app/to-shopping.ts` para usarla también desde Inicio. |
| **Maquinaria** (A) | **Fila:** una sola línea de sitio: la ruta corta («Cocina › Office»), el texto escrito o «Sin sitio».<br><br>**Ficha con artículo:**<br>• un solo «Dónde está» (antes salía «Espacio» dos veces);<br>• el texto de antes, en solo lectura («Antes: “Office”») hasta que se elige un espacio;<br>• el stock antes de guardar: «No cuadra: la ficha dice 2 · en Recursos hay 1» y «Al guardar, en Recursos pasa de 0 a 3 (entra 3 en Cocina › Office)».<br><br>**El aviso a Tasks** manda el espacio. | Sin artículo, el texto libre «Ubicación» sigue editable (lo pide la caracterización R5). No se borra ningún texto. El recorrido con «En reparación» solo con Tasks, la chip de estado, la papelera, revisión y fecha, cambios sin guardar, las respuestas de Tasks y el lector sin «Nueva máquina». |

## Dominio

`_domain/food/stock-need.ts`, con sus pruebas en `stock-need.test.ts`:
- `readableQuantity`;
- `nextRecipeService`: no cuenta los menús cerrados; un servicio con hora vale hasta 90 min después;
- `serviceShares`;
- `pendingConsumption`: por confirmar o descontándose solo;
- `ingredientNeeds`, `needText` y `stockText`;
- `pantryAlerts`: lo urgente de Inicio, un artículo una vez.

## Lo que queda fuera

- La migración de los textos de «Ubicación» a espacios es de Sevilla y no va en esta PR.
- **Etiqueta «Ubicación» del texto libre:** sigue llamándose así porque `caracterizacion-r5.spec.ts:109` la pide. Para llamarla «Dónde está» hay que cambiar esa prueba, y eso necesita permiso.
- **Kit:**
  - la ruta corta del sitio la calcula Food con la misma regla que el selector, porque el kit no la exporta;
  - el foco del kit dice «Abrir»; el traspaso pedía «Ver en la Despensa»;
  - `focusAction` y `setFilter(f, { persist: false })` no están en el kit 0.50, así que Food sigue devolviendo el filtro al salir.
