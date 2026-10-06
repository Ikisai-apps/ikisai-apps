-- Food · retirada de la proyección de pruebas de eventos. food-api lee booking.food_event_projection desde la PR 29;
-- la vista y su tabla quedaron vacías y sin uso. Toca solo el schema food.
select core.disallow_read('food', 'food.event_projection_stub');
select core.unregister_table('food', 'food', 'stub_events');
drop view if exists food.event_projection_stub;
drop table if exists food.stub_events;
