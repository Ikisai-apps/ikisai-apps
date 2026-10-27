-- Ikisai Tasks · qué lee y qué escribe cada capacidad del catálogo (encargo de Core; núcleo 0111, cobertura de campos):
-- `reads` y `writes` como `esquema.tabla.columna`, como Finance (0258) y Food (1120). Vuelve a registrar las capacidades de
-- Tasks tal y como están (la última definición de cada una) con esas dos listas; nada más cambia. `tasks.project_design` las
-- declara en su propia migración (0359).

select core.register_capability($cap${
  "id": "tasks.complete",
  "app": "tasks",
  "kind": "execute",
  "title": "Marcar una tarea de Tasks como hecha",
  "description": "Marca hecha una tarea que la persona ve. Si ya estaba hecha, devuelve lo que hay sin cambiar nada. No marca sus hijas.",
  "route": "POST tasks/complete",
  "roles": [
    "editor",
    "owner"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": [
      "taskId"
    ],
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
      },
      "taskId": {
        "type": "string",
        "format": "uuid"
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "taskId",
      "done",
      "changed"
    ],
    "properties": {
      "taskId": {
        "type": "string",
        "format": "uuid"
      },
      "done": {
        "type": "boolean"
      },
      "changed": {
        "type": "boolean"
      },
      "revision": {
        "type": "integer"
      }
    }
  },
  "anchors": [
    "tasks.lista.tarea.completar"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.tasks.done",
    "tasks.tasks.project_id"
  ],
  "writes": [
    "tasks.tasks.done"
  ]
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.project_production",
  "app": "tasks",
  "kind": "read",
  "title": "La producción de un proyecto de Tasks",
  "description": "Un proyecto que la persona ve, con sus fases (hechas, abiertas, bloqueadas y la siguiente acción), sus tareas con oficios, espacios, personas, materiales, compras y bloqueo, y los carriles por oficio, espacio, fase y persona (ids y recuentos). Sin nombres de Central ni de Recursos.",
  "route": "GET projects/production",
  "roles": [
    "reader",
    "editor",
    "owner",
    "outsider"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "required": [
      "projectId"
    ],
    "additionalProperties": false,
    "properties": {
      "projectId": {
        "type": "string",
        "format": "uuid"
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "project",
      "phases",
      "tasks",
      "lanes",
      "next"
    ],
    "properties": {
      "project": {
        "type": "object",
        "required": [
          "id",
          "title",
          "status"
        ]
      },
      "phases": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "name",
            "status",
            "total",
            "open",
            "done",
            "blocked"
          ],
          "properties": {
            "id": {
              "type": "string",
              "format": "uuid"
            },
            "name": {
              "type": "string"
            },
            "status": {
              "enum": [
                "pending",
                "active",
                "done"
              ]
            },
            "total": {
              "type": "integer"
            },
            "open": {
              "type": "integer"
            },
            "done": {
              "type": "boolean"
            },
            "blocked": {
              "type": "integer"
            },
            "nextTaskId": {
              "type": [
                "string",
                "null"
              ]
            }
          }
        }
      },
      "tasks": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "title",
            "done",
            "blocked"
          ],
          "properties": {
            "id": {
              "type": "string",
              "format": "uuid"
            },
            "parentId": {
              "type": [
                "string",
                "null"
              ]
            },
            "phaseId": {
              "type": [
                "string",
                "null"
              ]
            },
            "title": {
              "type": "string"
            },
            "done": {
              "type": "boolean"
            },
            "container": {
              "type": "boolean"
            },
            "trades": {
              "type": "array"
            },
            "spaces": {
              "type": "array"
            },
            "people": {
              "type": "array"
            },
            "materials": {
              "type": "array"
            },
            "purchases": {
              "type": "array"
            },
            "blocked": {
              "type": "object",
              "properties": {
                "by": {
                  "enum": [
                    "dependency",
                    "step",
                    null
                  ]
                },
                "ids": {
                  "type": "array"
                }
              }
            }
          }
        }
      },
      "lanes": {
        "type": "object",
        "properties": {
          "byTrade": {
            "type": "object"
          },
          "bySpace": {
            "type": "object"
          },
          "byPhase": {
            "type": "object"
          },
          "byPerson": {
            "type": "object"
          }
        }
      },
      "next": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "phaseId",
            "taskId"
          ]
        }
      }
    }
  },
  "anchors": [
    "tasks.fases.fase"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.project_deliverables.name",
    "tasks.project_deliverables.quantity",
    "tasks.project_deliverables.space_id",
    "tasks.project_deliverables.status",
    "tasks.project_phases.closed_note",
    "tasks.project_phases.due",
    "tasks.project_phases.name",
    "tasks.project_phases.position",
    "tasks.project_phases.start",
    "tasks.project_phases.status",
    "tasks.projects.due",
    "tasks.projects.status",
    "tasks.projects.title",
    "tasks.purchase_requests.item_id",
    "tasks.purchase_requests.status",
    "tasks.task_dependencies.depends_on_id",
    "tasks.task_materials.consumed",
    "tasks.task_materials.item_id",
    "tasks.task_materials.quantity",
    "tasks.task_people.house_level",
    "tasks.task_people.person_id",
    "tasks.task_spaces.space_id",
    "tasks.task_trades.trade_id",
    "tasks.task_units.unit",
    "tasks.tasks.deliverable_id",
    "tasks.tasks.done",
    "tasks.tasks.due",
    "tasks.tasks.parent_id",
    "tasks.tasks.phase_id",
    "tasks.tasks.position",
    "tasks.tasks.priority",
    "tasks.tasks.step_free",
    "tasks.tasks.steps_in_order",
    "tasks.tasks.title",
    "tasks.tasks.unit_count"
  ],
  "writes": []
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.projects_open",
  "app": "tasks",
  "kind": "read",
  "title": "Proyectos abiertos de Tasks",
  "description": "Los proyectos abiertos que ve la persona, con su área, para elegir dónde pedir una tarea o una compra. Sin «Entrada», sin archivados y sin papelera.",
  "route": "GET requests/projects",
  "roles": [
    "editor",
    "owner"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  },
  "output": {
    "type": "object",
    "required": [
      "projects"
    ],
    "properties": {
      "projects": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "title",
            "tabId",
            "tabName"
          ],
          "properties": {
            "id": {
              "type": "string",
              "format": "uuid"
            },
            "title": {
              "type": "string"
            },
            "tabId": {
              "type": "string",
              "format": "uuid"
            },
            "tabName": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "anchors": [
    "tasks.navegacion.proyectos"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.projects.status",
    "tasks.projects.tab_id",
    "tasks.projects.title",
    "tasks.tabs.name"
  ],
  "writes": []
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.request_purchase",
  "app": "tasks",
  "kind": "execute",
  "title": "Pedir una compra a Tasks",
  "description": "Crea en un proyecto de Tasks, una sola vez por referencia, una solicitud de compra pedida desde otra app: nace «pedida», con la procedencia en la nota y un enlace de vuelta. Sale en Suministros › «Compras del evento»; al recibirla, el stock entra por Recursos. Con `task_id`, ligada a esa tarea del proyecto (p. ej. «Pedir» lo que le falta). Repetir con la misma referencia devuelve la que ya hay.",
  "route": "POST requests/purchase",
  "roles": [
    "editor",
    "owner"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": [
      "source",
      "external_ref",
      "title",
      "project_id"
    ],
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
      },
      "source": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9_-]{1,30}$"
      },
      "external_ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 150
      },
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 300
      },
      "project_id": {
        "type": "string",
        "format": "uuid"
      },
      "task_id": {
        "type": "string",
        "format": "uuid"
      },
      "item_id": {
        "type": "string",
        "format": "uuid"
      },
      "quantity": {
        "type": "number",
        "exclusiveMinimum": 0,
        "exclusiveMaximum": 1000000000
      },
      "unit": {
        "type": "string",
        "maxLength": 20
      },
      "note": {
        "type": "string",
        "maxLength": 4000
      },
      "due": {
        "type": "string",
        "format": "date"
      },
      "priority": {
        "enum": [
          "normal",
          "high",
          "critical"
        ]
      },
      "external_url": {
        "type": "string",
        "maxLength": 500,
        "pattern": "^https://([a-z0-9-]+\\.)*ikisai\\.com(/|$)"
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "created",
      "purchase"
    ],
    "properties": {
      "created": {
        "type": "boolean"
      },
      "purchase": {
        "type": "object",
        "properties": {
          "kind": {
            "const": "purchase_request"
          },
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "tabId": {
            "type": "string"
          },
          "projectId": {
            "type": "string"
          },
          "taskId": {
            "type": [
              "string",
              "null"
            ]
          },
          "itemId": {
            "type": [
              "string",
              "null"
            ]
          },
          "status": {
            "type": "string"
          },
          "quantity": {
            "type": [
              "number",
              "null"
            ]
          },
          "unit": {
            "type": [
              "string",
              "null"
            ]
          },
          "externalRef": {
            "type": "string"
          },
          "externalUrl": {
            "type": [
              "string",
              "null"
            ]
          }
        }
      }
    }
  },
  "anchors": [
    "tasks.suministros.evento.abrir",
    "tasks.suministros.evento.siguiente",
    "tasks.compras.lista.solicitud"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.projects.status",
    "tasks.projects.title",
    "tasks.tasks.project_id"
  ],
  "writes": [
    "tasks.purchase_requests.due",
    "tasks.purchase_requests.item_id",
    "tasks.purchase_requests.note",
    "tasks.purchase_requests.priority",
    "tasks.purchase_requests.project_id",
    "tasks.purchase_requests.quantity",
    "tasks.purchase_requests.source_app",
    "tasks.purchase_requests.source_ref",
    "tasks.purchase_requests.source_url",
    "tasks.purchase_requests.task_id",
    "tasks.purchase_requests.title",
    "tasks.purchase_requests.unit"
  ]
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.request_task",
  "app": "tasks",
  "kind": "execute",
  "title": "Pedir una tarea a Tasks",
  "description": "Crea en Tasks, una sola vez por referencia, una tarea pedida desde otra app, con sus hijas si las trae. Va donde diga la regla del usuario para su tipo, o al proyecto sugerido si quien pide lo ve, o a «Por clasificar». Repetir con la misma referencia devuelve la que ya hay; las hijas se mandan enteras cada vez y las que dejan de venir se retiran a la papelera (salvo las hechas).",
  "route": "POST requests/task",
  "roles": [
    "editor",
    "owner"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": [
      "source",
      "external_ref",
      "title"
    ],
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
      },
      "source": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9_-]{1,30}$"
      },
      "external_ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 150
      },
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
      },
      "note": {
        "type": "string",
        "maxLength": 20000
      },
      "due": {
        "type": "string",
        "format": "date"
      },
      "priority": {
        "enum": [
          "normal",
          "high",
          "critical"
        ]
      },
      "kind": {
        "type": "string",
        "maxLength": 100
      },
      "kind_label": {
        "type": "string",
        "maxLength": 100
      },
      "external_url": {
        "type": "string",
        "maxLength": 500,
        "pattern": "^https://([a-z0-9-]+\\.)*ikisai\\.com(/|$)"
      },
      "project_id": {
        "type": "string",
        "format": "uuid"
      },
      "tab_id": {
        "type": "string",
        "format": "uuid"
      },
      "space_id": {
        "type": "string",
        "format": "uuid"
      },
      "children": {
        "type": "array",
        "maxItems": 100,
        "items": {
          "type": "object",
          "required": [
            "external_ref",
            "title"
          ],
          "additionalProperties": false,
          "properties": {
            "external_ref": {
              "type": "string",
              "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 120
            },
            "note": {
              "type": "string",
              "maxLength": 1000
            },
            "due": {
              "type": "string",
              "format": "date"
            },
            "priority": {
              "enum": [
                "normal",
                "high",
                "critical"
              ]
            }
          }
        }
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "created",
      "task"
    ],
    "properties": {
      "created": {
        "type": "boolean"
      },
      "routed": {
        "type": [
          "string",
          "null"
        ],
        "enum": [
          "rule",
          "hint",
          "pending",
          null
        ]
      },
      "task": {
        "type": "object",
        "properties": {
          "kind": {
            "const": "task"
          },
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "projectId": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "done": {
            "type": "boolean"
          },
          "deleted": {
            "type": "boolean"
          },
          "request": {
            "type": "string"
          }
        }
      },
      "children": {
        "type": [
          "array",
          "null"
        ],
        "items": {
          "type": "object",
          "properties": {
            "ref": {
              "type": "string"
            },
            "taskId": {
              "type": "string"
            },
            "status": {
              "enum": [
                "open",
                "done",
                "deleted",
                "missing"
              ]
            }
          }
        }
      },
      "childrenCounts": {
        "type": "object",
        "properties": {
          "created": {
            "type": "integer"
          },
          "updated": {
            "type": "integer"
          },
          "retired": {
            "type": "integer"
          }
        }
      }
    }
  },
  "anchors": [
    "tasks.entradas.lista.regla",
    "tasks.entradas.nueva_regla",
    "tasks.editor_tarea.origen.abrir"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.request_routes.kind",
    "tasks.request_routes.project_id",
    "tasks.request_routes.trade_id"
  ],
  "writes": [
    "tasks.requests.due",
    "tasks.requests.external_ref",
    "tasks.requests.external_url",
    "tasks.requests.kind",
    "tasks.requests.kind_label",
    "tasks.requests.note",
    "tasks.requests.priority",
    "tasks.requests.space_id",
    "tasks.requests.title",
    "tasks.tasks.due",
    "tasks.tasks.external_kind",
    "tasks.tasks.external_ref",
    "tasks.tasks.external_url",
    "tasks.tasks.note",
    "tasks.tasks.priority",
    "tasks.tasks.project_id",
    "tasks.tasks.title"
  ]
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.review_item_result",
  "app": "tasks",
  "kind": "execute",
  "title": "Marcar un ítem de una revisión de Tasks",
  "description": "Apunta el resultado de un ítem de una revisión (p. ej. la de apertura antes de un evento): funciona o no, la cantidad, la lectura, la foto o la observación. Un fallo crea en Tasks la tarea para arreglarlo y la de volver a comprobar; solo un nuevo «ok» lo verifica. La revisión queda lista para abrir cuando todos sus críticos están verificados.",
  "route": "POST reviews/result",
  "roles": [
    "editor",
    "owner"
  ],
  "risk": "low",
  "idempotent": false,
  "reversible": false,
  "input": {
    "type": "object",
    "required": [
      "itemId",
      "result"
    ],
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
      },
      "itemId": {
        "type": "string",
        "format": "uuid"
      },
      "result": {
        "enum": [
          "ok",
          "fail"
        ]
      },
      "value": {
        "type": "number"
      },
      "text": {
        "type": "string",
        "maxLength": 2000
      },
      "fileId": {
        "type": "string",
        "format": "uuid"
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "itemId",
      "state",
      "reviewId",
      "reviewStatus"
    ],
    "properties": {
      "itemId": {
        "type": "string",
        "format": "uuid"
      },
      "state": {
        "enum": [
          "pending",
          "ok",
          "failed",
          "verified"
        ]
      },
      "reviewId": {
        "type": "string",
        "format": "uuid"
      },
      "reviewStatus": {
        "enum": [
          "open",
          "ready",
          "opened"
        ]
      },
      "correctiveTaskId": {
        "type": [
          "string",
          "null"
        ],
        "format": "uuid"
      },
      "recheckTaskId": {
        "type": [
          "string",
          "null"
        ],
        "format": "uuid"
      }
    }
  },
  "anchors": [
    "tasks.revision.item.resultado"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.review_items.answer",
    "tasks.review_items.critical",
    "tasks.review_items.expected",
    "tasks.review_items.state"
  ],
  "writes": [
    "tasks.review_items.checked_at",
    "tasks.review_items.checked_by",
    "tasks.review_items.corrective_task_id",
    "tasks.review_items.file_id",
    "tasks.review_items.first_failure",
    "tasks.review_items.recheck_task_id",
    "tasks.review_items.state",
    "tasks.review_items.text",
    "tasks.review_items.value",
    "tasks.tasks.done",
    "tasks.tasks.title"
  ]
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.review_projection",
  "app": "tasks",
  "kind": "read",
  "title": "Revisión de Tasks (lista de comprobación)",
  "description": "Una revisión de Tasks (p. ej. la de apertura antes de un evento) por su id o por el evento: sus zonas e ítems con el estado, el último valor, quién y cuándo, la tarea para arreglarlo y la de volver a comprobar, y si está lista para abrir. Solo la que ve la persona.",
  "route": "GET reviews/projection",
  "roles": [
    "reader",
    "editor",
    "owner"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "reviewId": {
        "type": "string",
        "format": "uuid"
      },
      "eventRef": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9_.:/-]{1,150}$"
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "review",
      "zones",
      "totals"
    ],
    "properties": {
      "review": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid"
          },
          "status": {
            "enum": [
              "open",
              "ready",
              "opened"
            ]
          },
          "ready": {
            "type": "boolean"
          }
        }
      },
      "zones": {
        "type": "array"
      },
      "totals": {
        "type": "object"
      }
    }
  },
  "anchors": [
    "tasks.revision.lista"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.review_items.answer",
    "tasks.review_items.checked_at",
    "tasks.review_items.critical",
    "tasks.review_items.expected",
    "tasks.review_items.state",
    "tasks.review_items.text",
    "tasks.review_items.title",
    "tasks.review_items.value",
    "tasks.review_items.zone",
    "tasks.reviews.event_ref",
    "tasks.reviews.open_note",
    "tasks.reviews.open_override",
    "tasks.reviews.opened_at",
    "tasks.reviews.status",
    "tasks.reviews.title"
  ],
  "writes": []
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.today_projection",
  "app": "tasks",
  "kind": "read",
  "title": "Lo de hoy del equipo en Tasks",
  "description": "Las tareas de hoy en lo que ve la persona: lo que vence ese día o antes y sigue abierto, y lo hecho ese día. Con proyecto, prioridad, estado, si está bloqueada, y las personas, oficios y espacios (ids). Sin el Plan de hoy de cada cual, que es privado.",
  "route": "GET today/projection",
  "roles": [
    "reader",
    "editor",
    "owner",
    "outsider"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "date": {
        "type": "string",
        "format": "date"
      },
      "projectId": {
        "type": "string",
        "format": "uuid"
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "date",
      "items"
    ],
    "properties": {
      "date": {
        "type": "string",
        "format": "date"
      },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "required": [
            "id",
            "projectId",
            "title",
            "status",
            "blocked"
          ],
          "properties": {
            "id": {
              "type": "string",
              "format": "uuid"
            },
            "projectId": {
              "type": "string",
              "format": "uuid"
            },
            "project": {
              "type": "string"
            },
            "parentId": {
              "type": [
                "string",
                "null"
              ]
            },
            "title": {
              "type": "string"
            },
            "priority": {
              "enum": [
                "normal",
                "high",
                "critical"
              ]
            },
            "due": {
              "type": [
                "string",
                "null"
              ]
            },
            "status": {
              "enum": [
                "open",
                "done"
              ]
            },
            "overdue": {
              "type": "boolean"
            },
            "blocked": {
              "type": "boolean"
            },
            "people": {
              "type": "array"
            },
            "trades": {
              "type": "array"
            },
            "spaces": {
              "type": "array"
            }
          }
        }
      }
    }
  },
  "anchors": [
    "tasks.hoy.lista"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.projects.title",
    "tasks.task_dependencies.depends_on_id",
    "tasks.task_people.house_level",
    "tasks.task_people.person_id",
    "tasks.task_spaces.space_id",
    "tasks.task_trades.trade_id",
    "tasks.task_units.unit",
    "tasks.tasks.done",
    "tasks.tasks.done_at",
    "tasks.tasks.due",
    "tasks.tasks.parent_id",
    "tasks.tasks.priority",
    "tasks.tasks.project_id",
    "tasks.tasks.title"
  ],
  "writes": []
}$cap$::jsonb);

select core.register_capability($cap${
  "id": "tasks.unit_step",
  "app": "tasks",
  "kind": "execute",
  "title": "Marcar una unidad de una tarea de Tasks",
  "description": "En una tarea con unidades («Montar bastidor · 2 de 4»), marca o desmarca una unidad. La tarea queda hecha cuando lo están todas sus unidades. Repetir no cambia nada.",
  "route": "POST tasks/unit-step",
  "roles": [
    "editor",
    "owner"
  ],
  "risk": "low",
  "idempotent": true,
  "reversible": true,
  "input": {
    "type": "object",
    "required": [
      "taskId",
      "unit"
    ],
    "additionalProperties": false,
    "properties": {
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_.:-]{1,100}$"
      },
      "taskId": {
        "type": "string",
        "format": "uuid"
      },
      "unit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "done": {
        "type": "boolean"
      }
    }
  },
  "output": {
    "type": "object",
    "required": [
      "taskId",
      "unit",
      "done",
      "unitsDone",
      "units",
      "taskDone"
    ],
    "properties": {
      "taskId": {
        "type": "string",
        "format": "uuid"
      },
      "unit": {
        "type": "integer"
      },
      "done": {
        "type": "boolean"
      },
      "unitsDone": {
        "type": "integer"
      },
      "units": {
        "type": "integer"
      },
      "taskDone": {
        "type": "boolean"
      }
    }
  },
  "anchors": [
    "tasks.lista.tarea.completar"
  ],
  "since": "0.1.0",
  "reads": [
    "tasks.tasks.done",
    "tasks.tasks.unit_count"
  ],
  "writes": [
    "tasks.task_units.done_by",
    "tasks.task_units.marked_at",
    "tasks.task_units.unit",
    "tasks.tasks.done"
  ]
}$cap$::jsonb);
