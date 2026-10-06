# Booking · recorrido de aceptación en producción

Para hacerlo con tu cuenta en `https://booking.ikisai.com`, primero en el ordenador y después en el móvil Android. Lleva unos 20 minutos. Es el recorrido A–E e I del handoff (§32) adaptado a lo que hay construido; lo que depende de Food (F–H) no está aquí.

Usa siempre el nombre **`[PRUEBA] Retiro Test`** para distinguirlo de reservas reales, y al terminar bórralo (paso 9). Ten abierto en otra pestaña el calendario de Google «Agram Camp - Reservas».

Anota junto a cada paso: ✔ si pasa, o qué ves si no.

## 1. Entrar

1. Abre `booking.ikisai.com` e inicia sesión con tu cuenta de siempre.
2. Debes ver «Hola, …», la barra de estado «En línea» y cuatro entradas: Inicio, Reservas, Calendario, Huéspedes.

## 2. Reserva en negociación (A)

1. Reservas → **Nueva reserva**: nombre `[PRUEBA] Retiro Test`, estado **Negociación**, entrada un viernes y salida el domingo siguiente, 20 personas. Guardar.
2. Aparece en la lista con «2 noches» y un código `RSV_2026_…`.
3. En Google Calendar **no** debe haber ningún evento.

## 3. Pre-reserva (B)

1. Abre la reserva → **Editar** → estado **Pre-reserva** → Guardar.
2. En menos de un minuto, en Google Calendar aparece **un** evento `[PRE] [PRUEBA] Retiro Test`, amarillo, de día completo, que ocupa viernes, sábado **y domingo**.
3. En la cabecera de la ficha, la pastilla de Calendar dice «sincronizado».
4. Vuelve a Editar y guarda sin cambiar nada: sigue habiendo un solo evento.

## 4. Confirmación (C)

1. En la ficha pulsa **Confirmar** y acepta.
2. El estado pasa a «Confirmada» y el bloque Operación muestra un código `EVT_2026_…`.
3. En Google Calendar es el **mismo** evento, ya sin `[PRE]` y en verde.

## 5. Operación (D)

1. Bloque Operación → **Editar**: llegada 17:00, salida 12:00, 22 personas finales. Guardar.
2. En Google Calendar el evento pasa a tener horario: viernes 17:00 → domingo 12:00.
3. En la ficha, el Resumen dice «22 finales».
4. **Añadir checklist base**: aparecen 20 tareas en cinco listas. Marca una.

## 6. Restricciones y cobro (E)

1. Bloque Comidas → **Añadir restricción**: alergia, «pistacho», grave, 1 persona. Otra: vegano, 2 personas.
2. El resumen dice «1 alergia a pistacho · 2 vegano».
3. Bloque Cobro → Editar: señal requerida 300, pagada 100. Debe decir «Parcial».

## 7. Huéspedes

1. Bloque Huéspedes → **Abrir** → **Nuevo huésped** con datos inventados (por ejemplo «Persona Sintética», DNI `00000000T`). No uses datos de nadie real.
2. Mientras rellenas, el aviso «Falta para SES: …» va menguando. Con DNI debe pedir segundo apellido y número de soporte.
3. Guarda, vuelve a abrirlo y pulsa **Firmar en pantalla**: firma con el dedo o el ratón y guarda. En la lista aparece «Firmado».
4. Pon el estado de los datos en «Datos revisados», pulsa **Listo para envío** y después **Datos para SES**: cada dato tiene su botón Copiar.
5. **Registrar envío**: escribe una referencia inventada y, si quieres, adjunta un PDF cualquiera. Queda «Enviado a SES».

## 8. Sin conexión (hazlo sobre todo en el móvil)

1. Pon el móvil en modo avión.
2. Abre la reserva y cambia el teléfono de contacto. Debe guardarse con la marca «Pendiente de sincronizar» y la barra debe decir «Sin conexión · 1 cambio pendiente».
3. Cierra la app del todo y vuelve a abrirla, todavía sin red: el cambio sigue ahí.
4. Quita el modo avión: en unos segundos la marca desaparece y la barra dice «Todo sincronizado».
5. En el ordenador, recarga la reserva: el teléfono nuevo está.

## 9. Cancelación y limpieza (I)

1. Editar → estado **Cancelada** → Guardar.
2. En Google Calendar el evento **desaparece**. La reserva sigue en la app (filtro «Canceladas»).
3. Abre la reserva → **Más** → **Papelera** → confirma. Desaparece de la lista y queda en «Papelera».
4. Para quitarla del todo: en Reservas despliega «Papelera» y pulsa **Vaciar papelera** (solo lo ve el propietario). El aviso dice cuántas reservas y elementos asociados se borran; confirma. Si responde que alguna reserva aún tiene su evento en Google Calendar, espera un par de minutos y repite.

## Qué mirar con lupa

- Que en ningún momento haya **dos** eventos en Google para la misma reserva.
- Que el evento de día completo incluya el día de salida.
- Que la descripción del evento en Google no lleve nombres de huéspedes, importes ni notas internas.
- En el móvil: que nada se salga de la pantalla y que «Guardar» sea alcanzable con el teclado abierto.
