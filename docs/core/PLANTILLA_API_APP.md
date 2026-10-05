# Plantilla · `docs/<app>/API.md` (puerta G2)

Cada equipo de app escribe este documento antes de repartirse el trabajo. Core lo revisa. Mientras no esté aprobado, no se crean migraciones ni rutas.

## 1. Dominio y límites

Qué resuelve la app, qué no hace, y qué datos son de otra app (se leen por proyección o API, nunca se copian como fuente de verdad).

## 2. Tablas sincronizables (`<schema>.*`)

Por tabla: nombre, propósito, columnas con tipo y restricciones, `writable_columns`, roles de lectura y escritura, `never_purge`, índices, FK dentro del schema (y a `booking.events` solo desde `food`). Todas llevan las columnas del contrato §2.1. Estados cerrados como `check`.

Códigos humanos: prefijos que registra la app (`core.next_code`).

## 3. Procedimientos (`call`)

Transacciones de dominio que no caben en operaciones de fila (confirmar reserva, importar factura, regenerar lista de compra). Por cada uno: nombre `<schema>.<proc>`, `args`, qué filas toca (siempre vía `core.apply_row_op`), resultado, errores.

## 4. Hooks de validación

Reglas de `beforeCommit` (tipos, obligatorios, coherencias) y `validate_hooks` SQL (invariantes globales, por ejemplo ciclos).

## 5. Visibilidad

Si la app tiene ámbitos (`memberships.scopes`): su formato y la función `visible(table, row, ctx)`.

## 6. Rutas propias (`/api/v1/...`)

Lecturas compuestas, paneles, exportaciones, integraciones. Método, ruta, entrada, salida, errores, rol mínimo.

## 7. Proyecciones y enlaces

Vistas `*_projection` que publica para otras apps (columnas exactas, sin datos personales) y destinos tipados que acepta o consume (`target_app`, `target_kind`, `target_id`).

## 8. Archivos

Bucket, tipos aceptados, límites, tratamiento en cliente (recompresión de fotos), tablas que referencian `core.files`.

## 9. Pantallas y navegación

Máximo cuatro o cinco entradas. Por pantalla: qué muestra en lectura, qué edita, bloques plegables, comportamiento móvil. Referencia: canon funcional del handoff.

## 10. Offline

Qué tablas van al espejo local, qué acciones son posibles sin red, qué pasa con adjuntos, cómo se muestran pendientes y conflictos.

## 11. Aceptación

Recorrido de aceptación numerado (del handoff, adaptado) y escenarios offline que se automatizan en Playwright.

## 12. Reparto entre agentes

Quién hace backend (SQL + Edge + dominio), quién frontend, por qué verticales se divide después, y qué archivos son de cada uno.
