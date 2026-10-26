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

## Preguntas abiertas

Ninguna de producto pendiente en Flow. Las decisiones de VG están recogidas en `API.md` (§13–18).
