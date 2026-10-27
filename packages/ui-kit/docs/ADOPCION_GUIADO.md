# Cómo adopta una app el Guiado del kit

El Guiado acompaña sobre los controles reales de la app. No bloquea nada: la persona puede trabajar libremente y volver a la guía.

Hay dos niveles, y los dos se montan con la misma opción de `createAppShell`:

| Nivel | Llega con | Qué hace |
|---|---|---|
| **Mínimo** | `?campo=<anclaje>&paso=<texto>` | Señala un campo con una línea que explica el paso y el «‹ Volver a…» de quien envió. No lee nada de Flow. |
| **Completo** | `?guia=<ejecución de Flow>` | Una burbuja con los pasos de esa ejecución que tocan a la app. Lee `flow.guide_read`, avanza solo cuando el campo se guarda de verdad y lo confirma con `flow.guide_confirm`. |

El código está en `src/guide/` (anclajes, enlace, guía y fuente de Flow) y en `src/fields/field-mark.ts`. Las pruebas son la v71, la v72 y la v84.

## 1. Montarlo en la cáscara

```ts
const shell = createAppShell(root, {
  // …
  // Mínimo: basta con el feedbackId (bajo `cabecera` o `guia` de la app).
  guide: { feedbackId: 'booking.guia' },
  // Completo: además, el cliente de sincronización (su `api`), para invocar las capacidades de Flow por la Edge de la app.
  guide: { feedbackId: 'booking.guia', client, app: 'booking' },
});
```

- **`app`:** es la app que pide sus pasos a Flow. Si no se da, sale del primer segmento de `feedbackId` (`booking.guia` → `booking`). Flow devuelve solo los pasos cuyo anclaje empieza por ese nombre, más los suyos propios, que no llevan anclaje.
- **Lo que hace la cáscara sola:**
  - instala «‹ Volver a…» (`returnTo`);
  - lee `?campo=`, `?paso=` y `?guia=`, los guarda en la sesión de la pestaña y los quita de la URL, así que recargar no repite el salto;
  - monta el nivel que toque.
- **Sin `createAppShell`**, como en Tasks: se monta lo mismo a mano con `readGuideLink()`, `createFieldPointer(link)` y, para el completo, `createGuide({ load, onConfirmed, onSkipped })` con `flowGuideSource(client, { app })`. Ver `apps/tasks/public/guia-ui.js`.

## 2. Anclajes: un id estable por campo o control

Un anclaje es un id del inventario, nunca un selector CSS: `^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$`, y el primer segmento es la app.

- **Campos:** `data-field-id` con `fieldAttrs(spec)`. El mismo spec alimenta el inventario de campos (core 0100) y la cobertura del Revisor, así que hay que poner siempre `entity` y `prop`:
  - `entity` = «schema.tabla» (`booking.guests`);
  - `prop` = «columna» (`document_number`);
  - las capacidades declaran `reads`/`writes` como «schema.tabla.columna»;
  - el núcleo los compara como cadena exacta.
- **Botones y secciones:** `data-feedback-id`, que ya llevan para el feedback.
- **`confirm`** del spec: cómo se da por hecho un paso que señala ese campo.
  - `save`: el campo se guarda con `createSaveState` usando su id como clave, y el aviso sale solo.
  - `event`: la app llama a `announceSaved(id)` cuando la base lo acepta.
  - `none`: solo informa y no se confirma.
  - Un paso sin anclaje es `manual` («Hecho»).

```ts
// Guests · lodge.ts: los datos del viajero
el('input', { id: 'tvDoc', ...fieldAttrs({ id: 'guests.visitante.alojate.viajero.document_number',
  entity: 'booking.guests', prop: 'document_number', type: 'text', required: true, sensitivity: 'personal', confirm: 'event' }) })
```

**Lo escondido se enseña con `registerReveal(prefijo, fn)`.** Si el anclaje no está a la vista:
1. el kit abre los `<details>` cerrados que lo contienen;
2. si no basta, llama a la función del prefijo más largo con `(id, nodo)` y espera a que aparezca (4 s).
3. Si sigue sin aparecer, la guía dice «No encuentro este paso en esta pantalla» y ofrece «Ir allí» con la ruta del paso.

```ts
// Booking · Recepción: los botones viven en carriles; en el móvil solo está montado el carril elegido
const off = registerReveal('booking.recepcion', (id) => lanes.select(
  id.endsWith('.llega') ? 'entradas' : id.endsWith('.sale') ? 'estancia' : 'confirmar'));
// …y al desmontar la pantalla: off();
```

Un anclaje que se repite (el mismo botón en cada ficha) señala el primero visible. Si el paso es de una persona concreta, que el reveal deje solo su ficha a la vista, por ejemplo rellenando el buscador.

## 3. El aviso de guardado: `announceSaved(id)`

La guía avanza **solo con un guardado de verdad**, nunca al escribir.

- **Cuándo se avisa:** después de que la base acepte el guardado (`settleBatch` del lote sin rechazo), no al hacer el `commit`.
- **Qué lleva el aviso:** **nunca valores**, solo el id.
- **Sin conexión:**
  1. Se avisa con `announceSaved(id, { pending: true })`. El paso avanza y Flow recibe un recibo «pendiente», que no lo da por hecho.
  2. **Cuando la cola lo sube**, se repite `announceSaved(id)` sin `pending`. La guía lo vuelve a confirmar sola, una vez.
  3. Sin ese segundo aviso, Flow nunca cierra el paso.
- **Atajo:** `createSaveState().track(id, promesa)` hace las dos cosas por sí solo cuando el id del campo es la clave.

```ts
// Booking · Recepción: alojado de verdad
if (await run(ops, `Alojado el ${c.number}.`)) announceSaved('booking.recepcion.cobrar');

// Una hoja que guarda en bloque: la hoja y cada campo cambiado
const rejected = await settleBatch(client, requestId);
if (!rejected) for (const id of [`${base}.guardar`, ...changed.map((k) => `${base}.${k}`)]) announceSaved(id, { pending: !navigator.onLine });
```

## 4. Enlazar desde otra app: `withGuideLink`

```ts
// Flow · «Trabajos de hoy»: abre la tarea en Tasks con la guía de su ejecución y vuelve aquí
withGuideLink(`https://tasks.ikisai.com/#/t/${id}`, { run: executionId, from: 'flow', title: 'Trabajos de hoy', url: location.href });
// Nivel mínimo: un campo y una línea
withGuideLink('https://booking.ikisai.com/#/reservas/123', { field: 'booking.reserva.llegada', step: 'Pon la hora de llegada', from: 'flow', title: 'Flow' });
```

Parámetros que añade:
- `campo`: un anclaje válido.
- `paso`: como mucho 140 caracteres.
- `guia`: el id de la ejecución.
- La vuelta: `desde`, `volver` y `titulo`.

**Los pasos nunca viajan en la URL:** el completo los lee de Flow.

## 5. Lo que hace la guía en el móvil

- **Al llegar:** la burbuja va abajo con el paso, la explicación y las acciones. El campo se lleva arriba, bajo la cabecera, y se resalta.
- **Mientras se escribe** (foco en un campo que la persona ha tocado, o teclado abierto): la burbuja pasa a una tira arriba con el paso y su título. No tapa el campo, ni el teclado, ni «Guardar». El foco que pone la guía al llegar no la pliega.
- **El resto de la pantalla se puede tocar:** el foco no captura nada.
- **«Ocultar»** la deja en una píldora («Guía · paso 2 de 5»).
- **Modo práctica** (`learn`): dice «Practicando» y no confirma nada en Flow.

## 6. Lista para una app

1. `createAppShell({ guide: { feedbackId: '<app>.guia', client, app: '<app>' } })`.
2. Cada campo del recorrido con `fieldAttrs({ id, entity: 'schema.tabla', prop: 'columna', confirm })`.
3. Cada guardado avisa con `announceSaved(id)` tras la aceptación de la base, y otra vez sin `pending` al sincronizar.
4. Un `registerReveal('<app>.<pantalla>', …)` por cada pantalla con hojas, pestañas o carriles que escondan anclajes. Se quita al desmontar.
5. Probarlo con una ejecución de Flow en un móvil de 390 px:
   - cada paso encuentra su anclaje;
   - el paso avanza al guardar, y no antes;
   - «Volver a…» lleva a Flow.

Ejemplos completos:
- **Booking:** `apps/booking/src/ui/shell.ts` (guide), `reception.ts` (reveal por carril y avisos tras la base, #1130) y `form.ts` (hojas con `fieldAttrs` y aviso por campo).
- **Guests:** `apps/guests/src/ui/lodge.ts` (los datos del viajero con `fieldAttrs` y `announceSaved` al guardar).
