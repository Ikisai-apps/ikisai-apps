-- Food · tanda 27: vota también quien solo lee (decisión de VG; núcleo 0099, #608, contrato §3.11). Toca solo el
-- schema food: abre al lector `food.vote_suggestion` (1103), que solo crea, cambia o quita su propio voto. La tabla
-- `food.suggestion_votes` ya admite al lector en `writable_roles`, y su trigger fija quién vota.
select core.allow_reader_procedure('food', 'food.vote_suggestion');
