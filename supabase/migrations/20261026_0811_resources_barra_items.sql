-- Ikisai Recursos · artículos de la barra del evento del 31-10-2026 (carta de Food «Barra · Evento de octubre», RELEVO-001).
-- Ids fijos acordados con Food para que su semilla (recetas de los 8 montaditos, bebidas y palomitas) enlace cada artículo.
-- «Tomate fresco» no va aquí: ya existe «Tomate» (3a3d080c-417e-4174-a87f-9f28fc62ec90) y Food lo reutiliza.
-- Unidades: kg, l o ud; «Café / infusión» = un servicio; «Palomitas» = una ración. Sin precios: llegan con las facturas
-- (Finance) o a mano en la ficha. Si ya existiera un artículo con el mismo nombre, no se pisa (Food lo enlazará a mano).
insert into resources.items (id, name, kind, base_unit, category, source_refs) values
  ('74545d77-5a6d-45c8-bced-3c23cabdb31f', 'Pan de montadito', 'ingrediente', 'ud', 'Panadería', array['food:carta:barra-octubre-2026']),
  ('1adffdcf-2981-409e-9341-42f2f9a965b1', 'Jamón serrano', 'ingrediente', 'kg', 'Charcutería', array['food:carta:barra-octubre-2026']),
  ('ff5b3629-2241-451d-a4d2-e3930b02a60b', 'Aceite de oliva', 'ingrediente', 'l', 'Aceites', array['food:carta:barra-octubre-2026']),
  ('5520b406-e3d9-4fd3-aa9b-d8ead2dcc0b5', 'Atún preparado', 'ingrediente', 'kg', 'Conservas', array['food:carta:barra-octubre-2026']),
  ('3dfb175a-c610-4218-be00-a12faaf1490a', 'Mayonesa', 'ingrediente', 'kg', 'Salsas', array['food:carta:barra-octubre-2026']),
  ('4517133e-aa0f-44c6-abf0-e5cf90f51453', 'Hummus', 'ingrediente', 'kg', 'Salsas', array['food:carta:barra-octubre-2026']),
  ('014ad81f-fa01-4f85-b580-e402b1ab5d4d', 'Tomate seco en aceite', 'ingrediente', 'kg', 'Conservas', array['food:carta:barra-octubre-2026']),
  ('6866fc2f-c9fb-4481-a1a6-cf967a83fb9e', 'Rúcula', 'ingrediente', 'kg', 'Verduras', array['food:carta:barra-octubre-2026']),
  ('073894c4-5a8e-4315-8726-7efb86b0d07b', 'Queso crema', 'ingrediente', 'kg', 'Lácteos', array['food:carta:barra-octubre-2026']),
  ('75db942c-7514-42a8-98fb-5bf3cc3f9959', 'Pesto', 'ingrediente', 'kg', 'Salsas', array['food:carta:barra-octubre-2026']),
  ('fbd2d944-9aec-4263-9bfc-bca1bdb8d8b8', 'Albahaca fresca', 'ingrediente', 'kg', 'Hierbas', array['food:carta:barra-octubre-2026']),
  ('0bf532b6-eb3f-4a0e-bb86-84541e81a6d5', 'Paté de campaña', 'ingrediente', 'kg', 'Charcutería', array['food:carta:barra-octubre-2026']),
  ('00656f8a-8d68-424c-8b94-efc2ac0c0320', 'Cebolla caramelizada', 'ingrediente', 'kg', 'Conservas', array['food:carta:barra-octubre-2026']),
  ('34d445e9-e9f2-4b0c-a126-d936d1e64642', 'Tomillo', 'ingrediente', 'kg', 'Hierbas', array['food:carta:barra-octubre-2026']),
  ('1f4cabf9-29ed-4fee-a033-cdf2947443f8', 'Queso payoyo', 'ingrediente', 'kg', 'Lácteos', array['food:carta:barra-octubre-2026']),
  ('b090e0e8-1195-40cf-af82-4e55b7f17eb1', 'Miel', 'ingrediente', 'kg', 'Dulces', array['food:carta:barra-octubre-2026']),
  ('8955a89a-e23c-4d4c-b493-0c441aaa9f66', 'Nueces troceadas', 'ingrediente', 'kg', 'Frutos secos', array['food:carta:barra-octubre-2026']),
  ('330baf65-1bc3-4d90-be95-b4517865e8c4', 'Queso de cabra', 'ingrediente', 'kg', 'Lácteos', array['food:carta:barra-octubre-2026']),
  ('15c1535b-164c-4f8d-9d0d-90e74c058bbb', 'Mermelada de tomate', 'ingrediente', 'kg', 'Dulces', array['food:carta:barra-octubre-2026']),
  ('008b2489-7740-451b-ae2a-2ab54ed726f2', 'Salmón ahumado', 'ingrediente', 'kg', 'Pescado', array['food:carta:barra-octubre-2026']),
  ('039c4efc-49fb-4f9f-a157-486dc3828e3e', 'Eneldo', 'ingrediente', 'kg', 'Hierbas', array['food:carta:barra-octubre-2026']),
  ('fbd86e16-3bef-4dc0-b9a8-a4c9f139b72a', 'Agua, botella pequeña', 'bebida', 'ud', 'Bebidas', array['food:carta:barra-octubre-2026']),
  ('426bcf0c-d1ae-4e4c-bc67-b7bf35be6776', 'Refresco, lata', 'bebida', 'ud', 'Bebidas', array['food:carta:barra-octubre-2026']),
  ('9a49b68d-fbcd-4270-8043-9cfc2441dd34', 'Cerveza, lata', 'bebida', 'ud', 'Bebidas', array['food:carta:barra-octubre-2026']),
  ('cf2b0ff7-21e1-4f61-8b93-a007fdb611c2', 'Café / infusión', 'bebida', 'ud', 'Bebidas', array['food:carta:barra-octubre-2026']),
  ('2268636f-6764-40e6-a703-9ed13aad8ee4', 'Palomitas', 'consumible', 'ud', 'Snacks', array['food:carta:barra-octubre-2026'])
on conflict (lower(btrim(name))) where deleted_at is null do nothing;
