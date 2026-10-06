-- Ikisai Booking · la proyección de eventos también la lee Invoices, para asignar líneas de compra a un evento
-- (decisión de Core, ronda 5; docs/booking/API.md §7.2). La vista no lleva huéspedes ni datos personales.
select core.allow_read('invoices', 'booking.food_event_projection', 'view');
