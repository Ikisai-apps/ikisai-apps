-- Food · campos de archivo y recogida de huérfanos (contrato §3.9, ALMACENAMIENTO.md fase 2). Toca solo el schema food.
--
-- La foto de la receta y su miniatura son `operational`: se pueden volver a hacer, y al reemplazar o quitar la foto
-- el archivo anterior queda huérfano (P6). Con la recogida activada, un huérfano espera 30 días y se borra.

select core.register_file_field('food', 'food', 'recipes', 'photo_file_id', 'operational');
select core.register_file_field('food', 'food', 'recipes', 'photo_thumb_file_id', 'operational');

select core.enable_file_gc('food');
