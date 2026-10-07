# Guests · peticiones a Core

Detalle en `API.md` §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Id | Para | Petición | Estado |
|---|---|---|---|
| BG1 | Booking | `sources` por campo y `source` por restricción en `portal_my_guest` | abierta |
| BG2 | Booking | `revision` nueva en la respuesta de las acciones del huésped | abierta |
| BG3 | Booking | `diet_reviewed_at`: alimentación revisada, también con la lista vacía | abierta |
| BG4 | Booking | `status`, `arrival_time` y `departure_time` en `portal_my_guest.reservation` | abierta |
| BG5 | Booking | la firma deja de valer si cambia un dato del registro después de firmar; versión del texto firmado | abierta |
| BG6 | Booking | parentesco: ¿códigos del catálogo de SES en el dominio? | abierta |
| CE1 | Central | textos por idioma (`es`, `en`) con alternativa en español | abierta |
| CE2 | Central | claves `guests.data_why`, `guests.signature_statement`, `guests.allergies_notice` e `info.*` | abierta |
| C1 | Core | lectura pública del contacto para las pantallas sin sesión | abierta |
| C2 | Core | firma (`app = 'guests'`, columna de Booking) y recogida de huérfanos | abierta |
| C3 | Core | alta de infraestructura con la primera PR de `apps/guests` | abierta |
| C4 | Core | varias entradas de ámbito por cuenta con la #278 | abierta |
| C5 | Core | comentarios «Mi retiro» antes de la bandeja de Organizers | abierta |
| C6 | Core | cuentas internas de huésped al vencer la conservación | abierta |
| U1 | UI | capa de traducción y catálogos del feedback por idioma | abierta |
| U2 | UI | recuadro de firma en el kit | abierta |
| U3 | UI | estado de guardado por campo y global | abierta |
| U4 | UI | icono de Guests y `nav: []` sin barra | abierta |
