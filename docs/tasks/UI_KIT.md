# Tasks · adopción del `ui-kit`

Fecha: 6 de octubre de 2026. Para el agente de UI, que hace las PR de adopción en `apps/tasks`, y para quien las revise. Tasks da el visto bueno con los criterios de §4.

## 1. Cómo es hoy `apps/tasks`

- La interfaz son **scripts clásicos** en `apps/tasks/public/` que se copian tal cual a `dist/`. Comparten globales léxicos (`Sync`, `state`) y funciones globales que otros módulos reasignan (`render`, `save`, `setMode`, `taskRow`, `closeSheet`, `toast`…): un módulo no puede convertirse a ES module sin romper a los demás.
- Lo único compilado es `src/core.ts` → `dist/sync-core.js` (IIFE, `window.IkisaiTasks`), el adaptador sobre `@ikisai/sync-client`.
- La dirección visual «Taller» ya está aplicada con `taller.css` y `taller-ui.js`, y las fuentes están en `public/fonts/`. Adoptar el kit es **sustituir implementaciones propias por las del kit**, no cambiar el aspecto.

## 2. Puente recomendado

Vite en modo biblioteca IIFE solo admite una entrada, así que el kit entra por el mismo paquete:

- `src/core.ts` reexporta lo que se adopte (`export * as ui from '@ikisai/ui-kit'`, o solo las funciones usadas para no engordar `sync-core.js`): los scripts clásicos lo llaman como `IkisaiTasks.ui.renderLogin(…)`. Alias en `vite.config.ts` y `tsconfig.json` como indica el README del kit.
- Los estilos del kit, como archivo estático enlazado desde `index.html` **antes** de `taller.css`, para que lo propio de Tasks siga ganando mientras dure la convivencia. `base.css` da estilo a elementos sin clase: comprobar que no cambia nada fuera del módulo adoptado antes de incluirlo entero; si lo hace, empezar por `tokens.css` y las reglas del componente.
- **Todo archivo estático nuevo va también a la lista `SHELL` de `public/sw.js`**; si falta, la app no abre sin red. El nombre de la caché lo renombra el despliegue con el hash; no hace falta tocarlo.

## 3. Lo que no puede cambiar sin tocar a la vez su otra mitad

| Pieza | Depende de |
|---|---|
| Entrada | `loginSheet()` en `sync.js`. Ids que usan las pruebas y el propio adaptador: `accountLoginForm` (su presencia evita reabrir la hoja cuando caduca la sesión), `loginUsername`, `loginPassword`, `accountLogin`. El envío debe seguir siendo: `sameAccountOrNothingPending(email, password)` → `Sync.core.login` → `enterSession(boot)` → `syncNow()`; con `NO_MEMBERSHIP`, «Tu cuenta no tiene acceso a Tareas». |
| Sesión caducada | La entrada se pide **sin perder la cola ni el modelo en memoria** (escenario en `app.spec.ts` y `ui.spec.ts`): si `renderLogin` sustituye `#app`, al volver a entrar hay que repintar con `enterSession`, y la cola de `Sync.record.queue` debe seguir intacta. |
| Hoja y diálogo | `openSheet`/`closeSheet` son globales reasignables y los usan todos los módulos; `#sheetBack.show` y `#sheet` aparecen en `updates.js` (veto de actualización), `batch-ui.js` y las pruebas. |
| Paleta | `#palette`, `#paletteInput`; `updates.js` la considera un borrador abierto. |
| Estado de sincronización | `setMode(mode)` lo envuelve `updates.js` para mostrar «Nueva versión disponible» (`#appUpdate`, en `.brandrow`). `Sync.mode`, `Sync.busy`, `Sync.ready`, `Sync.updateLocked` los leen las pruebas. |
| Actualización de la PWA | `safeToUpdate()` en `updates.js` mira `.inlineedit`, `#paletteInput`, `.task.selected`, `#sheetBack.show` y el campo con foco (salvo `#searchInput`). Si un componente del kit sustituye a uno de estos, hay que actualizar ese selector en la misma PR. |
| Navegación | No hay rutas por hash: `navigateView(view)` y `state.view`; el shell del kit debe recibir `navigate` propio. |

## 4. Criterio para fusionar una PR de adopción

1. Un módulo por PR, empezando por la entrada y el shell. Sin cambios de comportamiento.
2. `npx playwright test tests/tasks --repeat-each 2` en verde en local (los escenarios de no regresión, sincronización y actualización del service worker), además de `npm run check` y la CI.
3. Las pruebas no se reescriben para acomodar la adopción; si un id o una clase tiene que cambiar, se cambia en la interfaz y en la prueba en la misma PR y se dice en la descripción.
4. Probada sin red tras recargar (lista `SHELL`).
5. Cada fusión en `apps/tasks` llega a `tasks.ikisai.com` con la siguiente release: nada a medias.
6. El visto bueno de Tasks se pide anotando la PR en `coordinacion/ui/SALIDA.md`; Tasks la revisa en su siguiente tanda y responde en `coordinacion/tasks/SALIDA.md`.

## 5. Orden propuesto

1. Entrada (`renderLogin` con sus `ids` configurables) y cabecera con la barra de estado.
2. Hoja, diálogo y avisos (`openSheet`, `confirmDialog`, `toast`), que es donde más código propio se retira.
3. Paleta, selector de etiquetas (`createLabelPicker`) y tarjeta de proyecto (`renderProjectCard`).
4. Fecha y lista reordenable, si encajan con los gestos actuales (arrastre entre proyectos y niveles).
