# Tasks · adopción del `ui-kit`

Fecha: 6 de octubre de 2026. Para el agente de UI, que hace las PR de adopción en `apps/tasks`, y para quien las revise. Tasks da el visto bueno con los criterios de §4.

## 1. Cómo es hoy `apps/tasks`

- La interfaz son **scripts clásicos** en `apps/tasks/public/` que se copian tal cual a `dist/`. Comparten globales léxicos (`Sync`, `state`) y funciones globales que otros módulos reasignan (`render`, `save`, `setMode`, `taskRow`, `closeSheet`, `toast`…): un módulo no puede convertirse a ES module sin romper a los demás.
- Lo único compilado es `src/core.ts` → `dist/sync-core.js` (IIFE, `window.IkisaiTasks`), el adaptador sobre `@ikisai/sync-client`.
- La dirección visual «Taller» ya está aplicada con `taller.css` y `taller-ui.js`, y las fuentes están en `public/fonts/`. Adoptar el kit es **sustituir implementaciones propias por las del kit**, no cambiar el aspecto.

## 2. Puente (como quedó en la PR #75)

- `src/kit.ts` → `dist/kit.js` + `dist/kit.css` (`window.IkisaiKit`), en una segunda pasada del mismo `vite.config.ts` (un IIFE solo admite una entrada). `index.html` los carga después de `/sync-core.js`.
- **Regla de la convivencia:** el CSS del kit va acotado a `.ikisai-kit` (plugin PostCSS del build), porque comparte nombres de clase con el heredado (`.topbar`, `.field`, `.chip`, `.card`, `.toast`…). Cada trozo pintado con el kit se envuelve en un elemento con esa clase; los tokens y las fuentes son globales y los del CSS heredado ganan por orden. Cuando un módulo entero esté en el kit se retira su CSS heredado; cuando no quede ninguno, se retira el acotado.
- **Todo archivo estático nuevo va también a la lista `SHELL` de `public/sw.js`**; si falta, la app no abre sin red. El nombre de la caché lo renombra el despliegue con el hash.

## 3. Lo que no puede cambiar sin tocar a la vez su otra mitad

| Pieza | Depende de |
|---|---|
| Entrada (hecha) | `loginSheet(note)` en `sync.js`. Ids que usan las pruebas y el propio adaptador: `accountLoginForm` (su presencia evita reabrir la hoja cuando caduca la sesión), `loginUsername`, `loginPassword`, `accountLogin`. El envío debe seguir siendo: `sameAccountOrNothingPending(email, password)` → `Sync.core.login` → `enterSession(boot)` → `syncNow()`; con `NO_MEMBERSHIP`, «Tu cuenta no tiene acceso a Tareas». |
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

## 5. Orden

1. Entrada: **hecha** (PR #75).
2. Tarjeta de proyecto (`renderProjectCard`, PR #90): en revisión. Conserva `data-open-project`, `data-drop-project`, `data-project-pin`, `data-project-drag` y `data-project-order`. Al sustituir una cadena de funciones (aquí `projectCard`), la PR retira también los envoltorios que quedan sin uso y el CSS heredado que ya no se aplica.
3. Cáscara en dos pasos (§6): primero la barra y el menú con el aspecto del kit, manteniendo los ganchos; después se retira el CSS heredado.
4. Hoja, diálogo y avisos (`openSheet`, `confirmDialog`, `toast`), paleta y selector de etiquetas.
5. Fecha y lista reordenable, si encajan con los gestos actuales (arrastre entre proyectos y niveles).

## 6. Cáscara, paso 1: qué se conserva

`render()` repinta todo en cada cambio: `#app.innerHTML = topbar() + main() + bottomnav() + fab()`, y después `bind()`. En el paso 1 eso no cambia: la cáscara se sigue pintando como HTML en cada `render()`, con el marcado y las clases del kit dentro de `.ikisai-kit`. Montar una cáscara con estado (`createAppShell`) exige cambiar `render()`, que `sync.js` y `updates.js` envuelven; eso es un paso posterior y se acuerda antes con Tasks.

`topbar` es una cadena de envoltorios que sustituyen texto del HTML anterior, igual que lo era `projectCard`. El módulo nuevo se carga el último, pinta la barra completa y **reproduce lo que añadían los envoltorios**, que se retiran en la misma PR:

| Envoltorio | Qué añade | Estado |
|---|---|---|
| `scope-ui.js` | pastilla «General» al principio de `.tabstrip` | vivo |
| `filters-ui.js` | tira de vistas guardadas (`viewStrip()`) justo después de `.tabstrip` | vivo |
| `cards-ui.js` | color de cada área en su `.tabpill` (busca `<button class="tabpill…" data-tab="id"`) | vivo |
| `theme-ui.js` | botón de tema (`#themeToggle`) en lugar de «Tu espacio» en `.menuheader` | vivo |
| `extras-ui.js` | alias de la persona («Yo») en la cabecera del menú | vivo |
| `access-ui.js`, `accounts-ui.js`, `csv-ui.js`, `features.js`, `history-ui.js` | botones que se insertaban junto a `<button data-action="backup">` o `import` | inertes desde `navigation-ui.js` (el menú sale de `navigationGroups()`); se pueden retirar |

Ganchos que deben seguir existiendo, con el mismo id, clase o atributo (entre paréntesis, quién los usa además de `navigation-ui.js`):

- **Barra:** `.brandrow` y, dentro, `.spacer` (`sync.js` inserta `#syncBadge` antes de `.spacer`; `updates.js` añade `#appUpdate` al final de `.brandrow`). `#moreBtn` con `aria-controls="kebab"` y `aria-expanded` (pruebas, `theme-ui.js`).
- **Estado:** `#syncBadge` lo crea `setMode()` con `data-mode` y los textos «Al día», «N pendientes», «Sincronizando», «Sin conexión», «Revisar cambios», «Revisar guardado», «Sin acceso» y «Otra pestaña activa»; al pulsarlo abre `showSync()`. Las pruebas leen el id y esos textos. Si pasa a ser la pastilla del kit, conserva id, `data-mode`, textos y acción, o cambia interfaz y pruebas en la misma PR.
- **Áreas:** `.tabstrip` con `button.tabpill[data-tab]` y `.active` (pruebas, `scope-ui.js`, `palette-ui.js`, `home-ui.js`, `sync.js`).
- **Menú:** `nav#kebab` con la clase `show` al abrirse, `#menuBackdrop`, `#closeMenu`, `details[data-menu-group]` (su estado abierto vive en `expandedMenuGroups`), `button[data-menu-view]` y `button[data-action]` (los atiende `handleTopAction`, que también envuelven varios módulos), `.menuheader`.
- **Navegación inferior:** `nav.bottomnav` con `button[data-nav]` (pruebas, `home-ui.js` añade «Inicio» y la clase `five`, `sync.js`). `#fab`.
- **Escritorio:** `--sidebar-width` lo usan `#moveRail`, `#batchBar` y `.undotoast` para centrarse; `#app` deja ese margen salvo en la entrada.

El menú sale de `navigationGroups()` (grupos, elementos y permisos): es la fuente para pintarlo con el kit y no cambia.
