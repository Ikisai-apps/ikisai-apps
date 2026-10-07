-- Ikisai Booking · el enlace tipado de un turno a la ficha de personal apunta a la app Central (`person_ref_app = 'central'`),
-- no a `encarna`, que es solo su alias de dominio (Core, ronda 22, a petición de Central). La interfaz no ofrecía todavía
-- este enlace; por si alguna fila lo tuviera, se convierte.

alter table booking.staff_assignments drop constraint if exists staff_assignments_person_ref_app_check;

update booking.staff_assignments set person_ref_app = 'central' where person_ref_app = 'encarna';

alter table booking.staff_assignments add constraint staff_assignments_person_ref_app_check
  check (person_ref_app is null or person_ref_app = 'central');
