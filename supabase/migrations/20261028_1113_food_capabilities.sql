-- Food · lo que Food ofrece a otras apps en el catálogo de capacidades del núcleo (0097; encargo de Core del 27-10-2026;
-- docs/food/API.md §2.14). Toca solo el schema food (la función de registro es del núcleo; el dato es de Food).
-- Las rutas `read/<schema.fn>` las admite el núcleo desde la 0102 (#816).

-- Lo que hace falta para copiar una carta desde la API (`POST carta/:id/use-in-event`): la carta y sus líneas vivas.
create or replace function food.carta_copy_source(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_menu food.menus;
begin
  begin v_menu.id := (p->'args'->>'menu_id')::uuid; exception when others then v_menu.id := null; end;
  select * into v_menu from food.menus where id = v_menu.id and deleted_at is null and kind = 'carta';
  if v_menu.id is null then perform core.fail('CARTA_NOT_FOUND', 422, jsonb_build_object('menu_id', p->'args'->>'menu_id')); end if;
  return jsonb_build_object('menu', to_jsonb(v_menu), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.scope, l.position, l.code)
    from food.carta_lines l where l.menu_id = v_menu.id and l.deleted_at is null), '[]'::jsonb));
end $$;
select core.allow_read('food', 'food.carta_copy_source', 'function', '{editor,owner}');

-- 1. Previsión de la carta por componente (Flow: tareas de preparación y «Comprar X»).
select core.register_capability($cap${
  "id": "food.carta_prep",
  "app": "food",
  "kind": "read",
  "title": "Previsión de la carta (por ingrediente)",
  "description": "Lo que pide una carta según sus unidades a cubrir, sumado por ingrediente o artículo: total en la unidad del inventario, reparto en bandeja en mesa, en nevera y en fresco, estación, si la cantidad se puede calcular, y el rendimiento (unidad de preparación, total en piezas, unidad de compra y cuántas piezas da cada una) para decir «Comprar 3 tomates».",
  "route": "GET read/food.carta_prep_totals_projection",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "properties": {
      "where": { "type": "object", "properties": { "menu_id": { "type": "string", "format": "uuid" }, "component_key": { "type": "string" } }, "additionalProperties": false },
      "limit": { "type": "integer", "minimum": 1, "maximum": 2000 }
    }
  },
  "output": {
    "type": "object",
    "properties": { "rows": { "type": "array", "items": { "type": "object",
      "required": ["menu_id", "component_key", "name", "unit", "need_total", "convertible"],
      "properties": {
        "menu_id": { "type": "string", "format": "uuid" }, "component_key": { "type": "string" },
        "item_id": { "type": ["string", "null"] }, "ingredient_id": { "type": ["string", "null"] },
        "name": { "type": "string" }, "unit": { "type": "string" },
        "need_total": { "type": ["number", "string", "null"] }, "mesa": { "type": ["number", "string", "null"] },
        "nevera": { "type": ["number", "string", "null"] }, "fresco": { "type": ["number", "string", "null"] },
        "convertible": { "type": "boolean" }, "station": { "type": ["integer", "null"] },
        "prep_unit": { "type": ["string", "null"] }, "prep_need_total": { "type": ["number", "string", "null"] },
        "purchase_unit": { "type": ["string", "null"] }, "yield": { "type": ["number", "string", "null"] }
      } } } }
  },
  "anchors": ["food.carta.prevision.bandejas", "food.carta.prevision.unidades", "food.carta.prevision.rendimiento"],
  "since": "0.1.0"
}$cap$::jsonb);

-- 2. Previsión de la carta por línea y componente (lo que gasta cada montadito).
select core.register_capability($cap${
  "id": "food.carta_prep_lines",
  "app": "food",
  "kind": "read",
  "title": "Previsión de la carta (por línea)",
  "description": "Por cada línea de la carta y cada componente: lo que gasta una unidad vendida, las unidades a cubrir, el total, el reparto mesa, nevera y fresco, la estación y el rendimiento.",
  "route": "GET read/food.carta_prep_projection",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "properties": {
      "where": { "type": "object", "properties": { "menu_id": { "type": "string", "format": "uuid" }, "line_id": { "type": "string", "format": "uuid" } }, "additionalProperties": false },
      "limit": { "type": "integer", "minimum": 1, "maximum": 2000 }
    }
  },
  "output": {
    "type": "object",
    "properties": { "rows": { "type": "array", "items": { "type": "object",
      "required": ["menu_id", "line_id", "scope", "code", "component_key", "name", "unit", "expected_units", "convertible"],
      "properties": {
        "menu_id": { "type": "string" }, "line_id": { "type": "string" }, "scope": { "type": "string" }, "code": { "type": "string" },
        "component_key": { "type": "string" }, "name": { "type": "string" }, "unit": { "type": "string" },
        "per_unit": { "type": ["number", "string", "null"] }, "expected_units": { "type": "integer" },
        "need_total": { "type": ["number", "string", "null"] }, "convertible": { "type": "boolean" }, "station": { "type": ["integer", "null"] }
      } } } }
  },
  "anchors": ["food.carta.prevision.unidades", "food.carta.prevision.bandejas"],
  "since": "0.1.0"
}$cap$::jsonb);

-- 3. Ofertas de comida de un evento (sin las internas).
select core.register_capability($cap${
  "id": "food.event_offers",
  "app": "food",
  "kind": "read",
  "title": "Ofertas de comida del evento",
  "description": "Las ofertas de comida de un evento para los huéspedes: qué se ofrece (menú cerrado o carta), para qué grupos, qué días y servicios, dónde, quién paga y cuándo se cobra. Nunca las internas.",
  "route": "GET read/food.event_offers_projection",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "properties": {
      "where": { "type": "object", "properties": { "event_id": { "type": "string", "format": "uuid" }, "menu_id": { "type": "string", "format": "uuid" } }, "additionalProperties": false },
      "limit": { "type": "integer", "minimum": 1, "maximum": 2000 }
    }
  },
  "output": {
    "type": "object",
    "properties": { "rows": { "type": "array", "items": { "type": "object",
      "required": ["offer_id", "event_id", "name", "menu_kind", "menu_id", "payer", "active"],
      "properties": {
        "offer_id": { "type": "string" }, "event_id": { "type": "string" }, "name": { "type": "string" },
        "meal_groups": { "type": "array", "items": { "type": "string" } },
        "days": { "type": ["array", "null"], "items": { "type": "string", "format": "date" } },
        "services": { "type": ["array", "null"], "items": { "type": "string" } },
        "place": { "type": ["string", "null"] }, "payer": { "enum": ["organizador", "huesped"] },
        "charge_when": { "enum": ["barra", "cuenta", null] }, "menu_kind": { "enum": ["cerrado", "carta"] },
        "menu_id": { "type": "string" }, "active": { "type": "boolean" }, "public": { "type": "boolean" }
      } } } }
  },
  "anchors": ["food.eventos.ficha.ofertas", "food.eventos.ficha.oferta_nueva"],
  "since": "0.1.0"
}$cap$::jsonb);

-- 4. Lo que pide un evento: la suma por ingrediente de todas sus ofertas.
select core.register_capability($cap${
  "id": "food.event_needs",
  "app": "food",
  "kind": "read",
  "title": "Lo que pide el evento",
  "description": "La suma por ingrediente de lo que piden todas las ofertas de un evento: los menús cerrados por raciones y las cartas por unidades a cubrir.",
  "route": "POST read/food.event_needs",
  "roles": ["reader", "editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object", "required": ["event_id"], "additionalProperties": false,
    "properties": { "event_id": { "type": "string", "format": "uuid" } }
  },
  "output": {
    "type": "object", "required": ["event_id", "offers", "items"],
    "properties": {
      "event_id": { "type": "string" }, "offers": { "type": "integer" },
      "items": { "type": "array", "items": { "type": "object",
        "required": ["ingredient_id", "name", "quantity", "unit", "menus"],
        "properties": { "ingredient_id": { "type": "string" }, "name": { "type": "string" }, "item_id": { "type": ["string", "null"] },
          "quantity": { "type": "number" }, "unit": { "type": "string" }, "menus": { "type": "integer" } } } }
    }
  },
  "anchors": ["food.eventos.ficha.lo_que_pide"],
  "since": "0.1.0"
}$cap$::jsonb);

-- 5. «Usar en otro evento»: copia una carta (con su previsión y su reparto; sin ventas) y, con evento, le crea su oferta.
select core.register_capability($cap${
  "id": "food.use_carta_in_event",
  "app": "food",
  "kind": "execute",
  "title": "Usar una carta en otro evento",
  "description": "Copia una carta con sus líneas, precios, disponibilidad, unidades a cubrir y reparto (las ventas no se copian), con otro nombre si se da, ligada a un evento o guardada sin él. Con evento, le crea su oferta para los huéspedes, cobrada en barra. Repetir con el mismo requestId devuelve la misma copia.",
  "route": "POST carta/:id/use-in-event",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object", "required": ["requestId"], "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "eventId": { "type": ["string", "null"], "format": "uuid" },
      "name": { "type": ["string", "null"], "minLength": 1, "maxLength": 120 }
    }
  },
  "output": {
    "type": "object", "required": ["menuId", "name", "lines", "offerId", "replayed"],
    "properties": {
      "menuId": { "type": "string", "format": "uuid" }, "name": { "type": "string" }, "lines": { "type": "integer" },
      "eventId": { "type": ["string", "null"] }, "offerId": { "type": ["string", "null"] }, "replayed": { "type": "boolean" }
    }
  },
  "anchors": ["food.carta.cabecera.usar_en_evento", "food.eventos.ficha.carta_usar"],
  "since": "0.1.0"
}$cap$::jsonb);
