-- Tasks · lo que Tasks ofrece a otras apps en el catálogo de capacidades del núcleo (0097, contrato §8; encargo de Core del
-- 27-10-2026, para el editor y los recorridos de Flow). Toca solo el schema tasks (la función es del núcleo; el dato, de Tasks).
-- docs/tasks/API.md §19, §39, §42 y §43.

select core.register_capability($cap${
  "id": "tasks.request_task",
  "app": "tasks",
  "kind": "execute",
  "title": "Pedir una tarea a Tasks",
  "description": "Crea en Tasks, una sola vez por referencia, una tarea pedida desde otra app, con sus hijas si las trae. Va donde diga la regla del usuario para su tipo, o al proyecto sugerido si quien pide lo ve, o a «Por clasificar». Repetir con la misma referencia devuelve la que ya hay; las hijas se mandan enteras cada vez y las que dejan de venir se retiran a la papelera (salvo las hechas).",
  "route": "POST requests/task",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": ["source", "external_ref", "title"],
    "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "source": { "type": "string", "pattern": "^[a-z][a-z0-9_-]{1,30}$" },
      "external_ref": { "type": "string", "minLength": 1, "maxLength": 150 },
      "title": { "type": "string", "minLength": 1, "maxLength": 500 },
      "note": { "type": "string", "maxLength": 20000 },
      "due": { "type": "string", "format": "date" },
      "priority": { "enum": ["normal", "high", "critical"] },
      "kind": { "type": "string", "maxLength": 100 },
      "kind_label": { "type": "string", "maxLength": 100 },
      "external_url": { "type": "string", "maxLength": 500, "pattern": "^https://([a-z0-9-]+\\.)*ikisai\\.com(/|$)" },
      "project_id": { "type": "string", "format": "uuid" },
      "tab_id": { "type": "string", "format": "uuid" },
      "space_id": { "type": "string", "format": "uuid" },
      "children": { "type": "array", "maxItems": 100, "items": {
        "type": "object", "required": ["external_ref", "title"], "additionalProperties": false,
        "properties": {
          "external_ref": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
          "title": { "type": "string", "minLength": 1, "maxLength": 120 },
          "note": { "type": "string", "maxLength": 1000 },
          "due": { "type": "string", "format": "date" },
          "priority": { "enum": ["normal", "high", "critical"] }
        } } }
    }
  },
  "output": {
    "type": "object",
    "required": ["created", "task"],
    "properties": {
      "created": { "type": "boolean" },
      "routed": { "type": ["string", "null"], "enum": ["rule", "hint", "pending", null] },
      "task": { "type": "object", "properties": { "kind": { "const": "task" }, "id": { "type": "string", "format": "uuid" }, "projectId": { "type": "string" }, "title": { "type": "string" }, "done": { "type": "boolean" }, "deleted": { "type": "boolean" }, "request": { "type": "string" } } },
      "children": { "type": ["array", "null"], "items": { "type": "object", "properties": { "ref": { "type": "string" }, "taskId": { "type": "string" }, "status": { "enum": ["open", "done", "deleted", "missing"] } } } },
      "childrenCounts": { "type": "object", "properties": { "created": { "type": "integer" }, "updated": { "type": "integer" }, "retired": { "type": "integer" } } }
    }
  },
  "anchors": ["tasks.entradas.lista.regla", "tasks.entradas.nueva_regla", "tasks.editor_tarea.origen.abrir"],
  "since": "0.1.0"
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.request_purchase",
  "app": "tasks",
  "kind": "execute",
  "title": "Pedir una compra a Tasks",
  "description": "Crea en un proyecto de Tasks, una sola vez por referencia, una solicitud de compra pedida desde otra app: nace «pedida», con la procedencia en la nota y un enlace de vuelta. Sale en Suministros › «Compras del evento»; al recibirla, el stock entra por Recursos. Repetir con la misma referencia devuelve la que ya hay.",
  "route": "POST requests/purchase",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": ["source", "external_ref", "title", "project_id"],
    "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "source": { "type": "string", "pattern": "^[a-z][a-z0-9_-]{1,30}$" },
      "external_ref": { "type": "string", "minLength": 1, "maxLength": 150 },
      "title": { "type": "string", "minLength": 1, "maxLength": 300 },
      "project_id": { "type": "string", "format": "uuid" },
      "quantity": { "type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1000000000 },
      "unit": { "type": "string", "maxLength": 20 },
      "note": { "type": "string", "maxLength": 4000 },
      "due": { "type": "string", "format": "date" },
      "priority": { "enum": ["normal", "high", "critical"] },
      "external_url": { "type": "string", "maxLength": 500, "pattern": "^https://([a-z0-9-]+\\.)*ikisai\\.com(/|$)" }
    }
  },
  "output": {
    "type": "object",
    "required": ["created", "purchase"],
    "properties": {
      "created": { "type": "boolean" },
      "purchase": { "type": "object", "properties": { "kind": { "const": "purchase_request" }, "id": { "type": "string", "format": "uuid" }, "tabId": { "type": "string" }, "projectId": { "type": "string" }, "status": { "type": "string" }, "quantity": { "type": ["number", "null"] }, "unit": { "type": ["string", "null"] }, "externalRef": { "type": "string" }, "externalUrl": { "type": ["string", "null"] } } }
    }
  },
  "anchors": ["tasks.suministros.evento.abrir", "tasks.suministros.evento.siguiente", "tasks.compras.lista.solicitud"],
  "since": "0.1.0"
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.projects_open",
  "app": "tasks",
  "kind": "read",
  "title": "Proyectos abiertos de Tasks",
  "description": "Los proyectos abiertos que ve la persona, con su área, para elegir dónde pedir una tarea o una compra. Sin «Entrada», sin archivados y sin papelera.",
  "route": "GET requests/projects",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": { "type": "object", "additionalProperties": false, "properties": {} },
  "output": {
    "type": "object",
    "required": ["projects"],
    "properties": {
      "projects": { "type": "array", "items": { "type": "object", "required": ["id", "title", "tabId", "tabName"], "properties": { "id": { "type": "string", "format": "uuid" }, "title": { "type": "string" }, "tabId": { "type": "string", "format": "uuid" }, "tabName": { "type": "string" } } } }
    }
  },
  "anchors": ["tasks.navegacion.proyectos"],
  "since": "0.1.0"
}$cap$::jsonb);
