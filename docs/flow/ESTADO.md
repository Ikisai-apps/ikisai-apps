# Flow · estado

App interna `flow` (`flow.ikisai.com`, Pages `ikisai-flow`, Edge `flow-api`, schema `flow`, migraciones 0900–0999). Publicada con la release v0.1.0-flow.2 (dominio enlazado; VG es owner). Referencia funcional: canon V1 de VG (26-10), FLOW-DIR-001 y las decisiones posteriores de VG por Core. Modelo y contratos: `docs/flow/API.md`.

## Qué está (en `main` o en PR)

| Pieza | Dónde |
|---|---|
| Carta pública en `/`: Clásicos, Gourmet y Barra; «− n +»; total; «Ver carta solo» con la carta general; imágenes de producto; alérgenos («sin confirmar» si falta la etiqueta) | #707, #714, #727, #735 |
| Número de cliente («Soy el N», guardado en el navegador): enviar pedido y ver los propios (por cobrar, preparando, entregados) | #714 |
| Personal en `/equipo` (login del kit, PWA): lista de flujos por evento, Inicio del flujo con carrusel, guías y modo pruebas, y barra de columnas desde los datos | #727 |
| Pedido y cobro: búsqueda por número, pedido manual, cobro explícito (efectivo o Bizum) con número de cobro, corrección (bajar → devolución pendiente; añadir → ampliación con su cobro, al final de la cola), anulación (owner o quien cobró) | #714 |
| Preparación y Logística: cola estable, toques con «pendiente de confirmar», una transición en vuelo por tarjeta, aviso si otra persona se adelantó, últimas 10 hechas y las anteriores desplegables, «Ir al siguiente pendiente» | #714 |
| Servicio y entrega: misma ficha desde Caja; cantidad entregada por línea; «Menú entregado» con excepción confirmada y registrada; reabrir sin tocar el dinero | #714 |
| Modo servicio: pantalla encendida (Wake Lock) con indicador; sonido y vibración opcionales | #714 |
| Acceso por proyecto (ámbitos del núcleo); outsiders: solo toques de unidades y tareas | #727 |
| Food: «Actualizar carta desde Food» (reflejo manual, congelado durante el servicio) | #735 |
| Cierre del día (owner): resumen, envío a Food y a Finance (no en modo pruebas), proyección que lee Booking | #735 |
| Ingredientes: propuestas, existencias de mesa y nevera, consumo por montadito, reposición bajo el 25 %, generación desde la previsión de Food, consumo en el cierre | #745 |
| Enlaces: evento de Booking del flujo; proyecto de Tasks y «Pedir a Tasks» (tarea o compra) desde una tarea | rama `flow/enlaces` (0905) |
| Pruebas: 40 en PGlite (conformidad, criterios §15, públicos, acceso, integraciones, ingredientes) y Playwright de la cáscara y del recorrido completo | #707–#745 |

## Qué falta para el jueves

1. **Ligar el flujo a su evento** en cuanto VG confirme la reserva del fin de semana (RSV_2026_007, «Carrera de orientación»): hoy está pre-reservada y sin evento, así que no sale para elegir. Mientras, Booking no ve el resumen del servicio.
2. **Elegir el proyecto de Tasks** del flujo (owner, una vez), para que funcione «Pedir a Tasks».
3. **Ensayo con varios móviles** (§15.13 y §15.16): concurrencia y red variable. Solo se puede hacer a mano, en el entorno real.
4. **Previsión de Food** para Ingredientes: depende de la #741 de Food. Sin ella, la columna funciona con tareas a mano.
5. **Altas de las 6 personas**: las da VG desde Central (jueves o viernes), como editoras y con el ámbito del proyecto de la barra.

## Riesgos

- **Ingredientes** es la pieza con más lógica nueva. Con la regla de congelación, si el jueves a las 20:00 no está sólida, entra solo con tareas a mano: la generación automática y la reposición se pueden dejar sin usar sin tocar el resto.
- **Envíos reales a Food y Finance:** probados contra el contrato, no contra las apps desplegadas (la #720 de Finance aún no está en `main`). Hay que probarlos en el ensayo, con una persona que sea miembro de Food y de Finance.
- **Refresco entre móviles:** pull cada 3 s (sin Realtime). Hay que medirlo en el ensayo con 4 a 6 móviles.
- **Límite conocido del cierre:** una anulación al día siguiente de su cobro llega a Finance con importe negativo y sin detalle por producto. Se cierra la semana que viene.
- **Plan B:** las comandas de papel siguen siendo el respaldo. Ante cualquier duda entre cobrado y no cobrado, se para el cobro digital (canon V1 §17).

## Ensayo con VG (lista de comprobación)

En `flow.ikisai.com`, con el flujo «Barra · Evento de octubre» en **modo pruebas** (Inicio del flujo, owner) para que nada vaya a Finance. Al terminar se quita el modo pruebas y se repite el cierre del día.

**0. Preparación (VG, antes)**
- [ ] En Central, alta de las 6 personas en Flow como **editoras**, con el ámbito del proyecto de la barra (`scopes.projects`). Cada una entra en `flow.ikisai.com/equipo` desde su móvil y ve el flujo en la lista. *Mirar:* quien no tiene el ámbito no ve el flujo.
- [ ] Quien vaya a cerrar el día (VG o el encargado) es **owner de Flow** y **miembro (editor u owner) de Food y de Finance**; para «Pedir a Tasks», editor de Tasks.
- [ ] Inicio del flujo (owner): «Elegir proyecto de Tasks». Si ya está confirmada RSV_2026_007, «Ligar a un evento de Booking». *Mirar:* las fechas del flujo pasan a las del evento.
- [ ] Caja (owner): «Actualizar carta desde Food». *Mirar:* el resumen (nuevos, cambios, retirados) y que la carta pública enseña precios, imágenes y alérgenos de Food.
- [ ] Ingredientes (owner): «Generar tareas de ingredientes». *Mirar:* salen las propuestas «Preparar X para mesa / nevera»; si Food aún no publica la previsión, el aviso «Falta la previsión en Food».

**1. Público: número de cliente (2 móviles sin sesión)**
- [ ] Escanear el QR (o abrir `flow.ikisai.com`): carta sin login, tres bloques, «− n +» y total. *Mirar:* el total cuadra con la carta general («Ver carta solo»).
- [ ] «Enviar a barra» → «Soy el 100». Recargar: el número se conserva. Otro móvil → «Soy el 101».
- [ ] «Mis pedidos»: por cobrar. *Mirar:* el 101 no ve nada del 100.

**2. Caja (1 móvil o la tablet)**
- [ ] Buscar «100», abrir, corregir una cantidad, «Cobrado: efectivo». *Mirar:* el número de cobro y que en Preparación aparecen los montaditos al final de la cola.
- [ ] Pedido manual sin número y «Cobrado: Bizum».
- [ ] Corregir un pedido cobrado: bajar una cantidad. *Mirar:* la devolución pendiente y «Ya devuelto». Añadir un producto: ampliación con su propio cobro, al final.
- [ ] Anular un cobro como no-owner que no cobró: debe decir «Solo quien cobró o el encargado».

**3. Preparación con 4 a 6 móviles a la vez**
- [ ] Dos personas tocan la misma tarjeta a la vez. *Mirar:* solo una la toma; la otra ve el aviso localizado con el nombre, y la tarjeta no salta.
- [ ] Toques rápidos (tomar y terminar seguidos). *Mirar:* sin falsos «otra persona se adelantó».
- [ ] Mientras llegan pedidos nuevos, tocar tarjetas. *Mirar:* el toque no cae en otra tarjeta y el scroll no salta (§15.15); «Ir al siguiente pendiente» solo sale si el siguiente no se ve.
- [ ] Tiempo de propagación entre móviles (pull cada 3 s). *Mirar:* que en otro móvil se vea en menos de ~5 s; anotar si es más.
- [ ] Modo servicio en la tablet de cocina: pantalla encendida y, si se elige, sonido al llegar montaditos.

**4. Red caída**
- [ ] Modo avión en un móvil: la cabecera dice «Sin conexión»; «Cobrado» y «Menú entregado» avisan de que necesitan red y no hacen nada. Al volver la red, se sincroniza. *Mirar:* nunca se ve como confirmado algo que no lo está (§15.24).

**5. Ingredientes**
- [ ] Hacer «Preparar X para mesa». Terminar montaditos hasta bajar del 25 % de la bandeja. *Mirar:* aparece «Reponer X a mesa desde nevera» al final, una sola vez, con su cantidad; revisar la cantidad y hacerla.
- [ ] Corregir un montadito hecho: la bandeja recupera su consumo.

**6. Servicio y entrega**
- [ ] Entrega parcial (solo bebidas): el pedido sigue por entregar. Entregar el resto: «Menú entregado».
- [ ] Entregar con montaditos sin hacer: pide confirmación y queda como excepción. Reabrir: no cambia el dinero.
- [ ] El cliente 100, en «Mis pedidos», ve «n de m preparados» y luego «Entregado».

**7. Logística y Tasks**
- [ ] Crear «Reponer vasos» (prioritaria), tomar y terminar. «Pedir a Tasks» → tarea; en otra, «Pedir compra» con cantidad. *Mirar:* en Tasks aparece en el proyecto elegido; repetir no duplica.

**8. Cierre del día (owner)**
- [ ] «Calcular cierre». *Mirar:* el total cuadra con efectivo + Bizum; las devoluciones pendientes van aparte; productos y horas punta; consumo de ingredientes.
- [ ] «Enviar a Food»: «Enviado a las hh:mm». *Mirar en Food:* las ventas por línea del día.
- [ ] «Enviar a Finance» en modo pruebas: «Modo pruebas: no se envía a Finance». Quitar el modo pruebas en un día de prueba controlado y enviar. *Mirar en Finance:* el apunte con el detalle; reenviar sin cambios da «unchanged».
- [ ] Con evento de Booking ligado: *mirar en Booking* la sección «Servicio de barra» de la ficha.

**9. Plan B**
- [ ] Talonarios en la barra. Regla: ante cualquier duda entre cobrado y no cobrado, se para el cobro digital y se sigue en papel (canon V1 §17).

## Preguntas abiertas

Ninguna de producto pendiente en Flow. Las decisiones de VG están recogidas en `API.md` (§13–18).
