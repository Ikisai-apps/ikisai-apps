**`renderCoverage` toma la vista del núcleo** (`core.field_coverage`, #1055, 0111). Completa #1036: este cambio no llegó a entrar con ella.

- **`coverageFromCore(salida del núcleo, pasos de Flow, extra)`** cruza la vista del núcleo con los pasos y reglas de Flow:
  - un paso con el anclaje del campo es `direct`, y una regla, `automatic`;
  - un paso que invoca una capacidad que lee o escribe su dato es `indirect`;
  - sin pasos, se queda la clase parcial del núcleo, marcada «Sin cobertura de Flow».
- **Duplicados:** los del núcleo mandan, porque ya traen el modo «label».
- **Uso:** `used` sin recuento sale como «Con uso propio».
- **Capacidades:** se enseñan las que leen o escriben el campo.
- **Utilidad (decisiones de VG, vg-39):** primero el estimado de la app (`estimate`) y luego lo declarado por Dirección (`declared`).
- Pruebas: `tests/v83.spec.ts`, con un caso con la forma del núcleo.

**Cobertura por candidatos** (decisión de VG, 27-10: no se decide campo a campo). `renderCoverage` abre por defecto en los candidatos del núcleo (`candidate`), por app → pantalla (`screenLabel` si viene), con recuento, usos en 30 días y la utilidad heredada (`estimate`, frecuencia y audiencia) por campo. Cada grupo lleva Dejar · Revisar más tarde · Retirar (`onDecide(decision | null, { app, screen, fieldIds })`; Retirar pide un segundo toque; «Deshacer» envía `null`; lo ya decidido llega en `field.decision`) y «Ajustar utilidad» (`onDeclare`). «Ver todo» abre el detalle por clase (`view: 'all'`, `setView()`). `coverageFromCore` lee `candidate`, `screenLabel`, `estimate` y `activations30d`, y devuelve `usage`.
