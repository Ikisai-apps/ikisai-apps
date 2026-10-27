-- Organizers · capacidad `organizers.github_evidence` del catálogo (0097), para Flow 6 «Avance por aplicaciones» (traspaso
-- v0.3 §8.4 y §8.5; diseño en MUELA/equipo/feedback/organizers/GITHUB_EVIDENCE.md). La sirve organizers-api en
-- `GET github/evidence` con un token de GitHub de solo lectura que solo vive en la Edge (GITHUB_TOKEN). Solo el personal:
-- owner o editor de Organizers sin `scopes.grants` (la ruta lo comprueba; quien organiza un retiro no la ve).

select core.register_capability($cap${
  "id": "organizers.github_evidence",
  "app": "organizers",
  "kind": "read",
  "title": "Evidencia de GitHub de una tarjeta",
  "description": "Dada una referencia estable (número de PR, rama, tarjeta con «Tarjeta: <id>» en la PR, o commit), la evidencia automática por separado: PR, CI (la comprobación obligatoria y lo que esté en rojo), fusión, release (si el commit fusionado está en el tag `released`) y despliegue (el version.json de cada app afectada), más el paso más avanzado demostrado. Nunca dice «aceptada»: eso lo decide Dirección.",
  "route": "GET github/evidence",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "properties": {
      "pr": { "type": "integer", "minimum": 1 },
      "branch": { "type": "string", "maxLength": 200 },
      "card": { "type": "string", "maxLength": 64 },
      "sha": { "type": "string", "pattern": "^[0-9a-f]{7,40}$" },
      "fresh": { "type": "string", "enum": ["1"] }
    },
    "minProperties": 1
  },
  "output": {
    "type": "object",
    "required": ["ref", "at", "prs", "summary"],
    "properties": {
      "summary": { "type": "string", "enum": ["sin_pr", "pr_abierta", "ci_verde", "fusionada", "publicada", "desplegada"] },
      "stale": { "type": "boolean" },
      "prs": { "type": "array", "items": { "type": "object", "required": ["number", "url", "state", "ci", "merge", "release", "apps", "deploy", "summary"] } }
    }
  },
  "since": "0.1.0"
}$cap$::jsonb);
