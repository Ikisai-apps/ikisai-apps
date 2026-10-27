**Inventario de campos: «no es un campo».** `NOT_A_FIELD` (atributo `data-field-none`) marca los controles que no guardan ningún dato (buscadores, filtros, selección de filas, rangos al generar). `feature-catalog.mjs` ya no los pone en `fieldsUninstrumented`, así que el recuento de «sin anclaje» de cada app puede llegar a 0. Lo propuso Food.

**`FieldSpec.storage`**: `device` (solo en el dispositivo: una calculadora, un borrador local) o `none` (no se guarda: un cartel que se dibuja, un código de un solo uso). Sale como `data-field-storage` y en el catálogo, y el informe ya no cuenta esos campos como «sin entidad». Por omisión, `server`. Lo propuso Organizers.

**`@field-caller`**: en un ayudante genérico que recibe los atributos de quien lo llama (`...mark`), un comentario con `@field-caller` en la línea del `el()` o en la anterior hace que el extractor no lo cuente como «sin anclaje»; el campo se declara en la llamada. Lo pidió Food.
