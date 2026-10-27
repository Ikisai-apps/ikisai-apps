-- Food · qué campos lee y escribe cada capacidad del catálogo (0111, encargo de Core del 27-10-2026): `reads` y `writes` como
-- `entity.prop` (entidad `food.<tabla>`, como el inventario de campos del kit). Sin eso no hay cobertura indirecta: un paso de
-- Flow que usa la capacidad cubre esos campos aunque no los pinte. Vuelve a registrar las cinco de la 1113 tal cual, con las
-- dos listas; nada más cambia. Toca solo el dato de Food (la función de registro es del núcleo).

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
  "reads": ["food.menus.kind", "food.menus.prep_split", "food.menus.expected_attendance", "food.carta_lines.menu_id", "food.carta_lines.recipe_id", "food.carta_lines.item_id", "food.carta_lines.active", "food.carta_lines.expected_units", "food.carta_lines.per_person", "food.recipes.base_servings", "food.recipe_ingredients.quantity", "food.recipe_ingredients.unit", "food.recipe_ingredients.station", "food.ingredients.name", "food.ingredients.item_id", "food.ingredients.purchase_unit", "food.ingredients.prep_unit", "food.ingredients.yield"],
  "writes": [],
  "since": "0.1.0"
}$cap$::jsonb);

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
  "reads": ["food.menus.kind", "food.menus.prep_split", "food.carta_lines.menu_id", "food.carta_lines.scope", "food.carta_lines.code", "food.carta_lines.recipe_id", "food.carta_lines.item_id", "food.carta_lines.active", "food.carta_lines.expected_units", "food.carta_lines.per_person", "food.recipes.base_servings", "food.recipe_ingredients.quantity", "food.recipe_ingredients.unit", "food.recipe_ingredients.station", "food.ingredients.name", "food.ingredients.item_id", "food.ingredients.yield"],
  "writes": [],
  "since": "0.1.0"
}$cap$::jsonb);

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
  "reads": ["food.event_offers.event_id", "food.event_offers.menu_id", "food.event_offers.name", "food.event_offers.audience", "food.event_offers.meal_groups", "food.event_offers.days", "food.event_offers.services", "food.event_offers.place", "food.event_offers.payer", "food.event_offers.charge_when", "food.event_offers.public", "food.menus.kind", "food.carta_lines.active"],
  "writes": [],
  "since": "0.1.0"
}$cap$::jsonb);

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
  "reads": ["food.event_offers.event_id", "food.event_offers.menu_id", "food.event_offers.audience", "food.menus.kind", "food.menus.expected_attendance", "food.menu_services.menu_id", "food.menu_items.service_id", "food.menu_items.recipe_id", "food.menu_items.servings", "food.carta_lines.menu_id", "food.carta_lines.recipe_id", "food.carta_lines.item_id", "food.carta_lines.active", "food.carta_lines.expected_units", "food.recipes.base_servings", "food.recipe_ingredients.quantity", "food.recipe_ingredients.unit", "food.ingredients.name", "food.ingredients.item_id"],
  "writes": [],
  "since": "0.1.0"
}$cap$::jsonb);

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
  "reads": ["food.menus.kind", "food.menus.name", "food.menus.prep_split", "food.menus.expected_attendance", "food.carta_lines.scope", "food.carta_lines.code", "food.carta_lines.recipe_id", "food.carta_lines.item_id", "food.carta_lines.name", "food.carta_lines.description", "food.carta_lines.sale_price_cents", "food.carta_lines.active", "food.carta_lines.position", "food.carta_lines.image_key", "food.carta_lines.expected_units", "food.carta_lines.per_person"],
  "writes": ["food.menus.kind", "food.menus.name", "food.menus.event_id", "food.menus.prep_split", "food.menus.expected_attendance", "food.carta_lines.menu_id", "food.carta_lines.scope", "food.carta_lines.code", "food.carta_lines.recipe_id", "food.carta_lines.item_id", "food.carta_lines.name", "food.carta_lines.description", "food.carta_lines.sale_price_cents", "food.carta_lines.active", "food.carta_lines.position", "food.carta_lines.image_key", "food.carta_lines.expected_units", "food.carta_lines.per_person", "food.event_offers.event_id", "food.event_offers.menu_id", "food.event_offers.name", "food.event_offers.audience", "food.event_offers.payer", "food.event_offers.charge_when"],
  "since": "0.1.0"
}$cap$::jsonb);
