# Guests · peticiones a Core

Detalle en `API.md` §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Id | Para | Petición | Estado |
|---|---|---|---|
| BG1 | Booking | `sources` por campo y `source` por restricción en `portal_my_guest` | hecha (#284) |
| BG2 | Booking | `revision` nueva en la respuesta de las acciones del huésped | hecha (#284) |
| BG3 | Booking | `diet_reviewed_at`: alimentación revisada, también con la lista vacía | hecha (#284) |
| BG4 | Booking | `status`, `arrival_time` y `departure_time` en `portal_my_guest.reservation` | hecha (#284) |
| BG5 | Booking | la firma deja de valer si cambia un dato del registro después de firmar; versión del texto firmado | hecha (#284) |
| BG6 | Booking | parentesco: ¿códigos del catálogo de SES en el dominio? | hecha (#284) |
| CE1 | Central | textos por idioma (`es`, `en`) con alternativa en español | hecha (#281) |
| CE2 | Central | claves `guests.data_why`, `guests.signature_statement`, `guests.allergies_notice` e `info.*` | hecha (#281) |
| C1 | Core | lectura pública del contacto para las pantallas sin sesión | la hace Core |
| C2 | Core | firma (`app = 'guests'`, columna de Booking) y recogida de huérfanos | respondida: migración 0600 |
| C3 | Core | alta de infraestructura con la primera PR de `apps/guests` | abierta |
| C4 | Core | varias entradas de ámbito por cuenta con la #278 | confirmada |
| C5 | Core | comentarios «Mi retiro» antes de la bandeja de Organizers | respondida: los ve Booking |
| C6 | Core | cuentas internas de huésped al vencer la conservación | la hace Core con Booking |
| C7 | Core | `uploads`: lectura y verificación solo del autor (hoy `guests-api` cierra `files/:id`) | abierta |
| O1 | Organizers | URL firmadas de los materiales publicados para el huésped | abierta |
| U1 | UI | capa de traducción y catálogos del feedback por idioma | hecha (#285), en uso |
| U2 | UI | recuadro de firma en el kit | opcional: Guests tiene el suyo en `ui/sign.ts` |
| U3 | UI | estado de guardado por campo y global | opcional: Guests tiene el suyo (`writer.ts`) |
| U4 | UI | icono de Guests y `nav: []` sin barra | abierta |
