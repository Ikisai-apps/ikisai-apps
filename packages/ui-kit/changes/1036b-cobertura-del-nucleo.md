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
