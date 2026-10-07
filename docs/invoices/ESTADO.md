# Invoices · estado

Actualizado: 6 de octubre de 2026 (tanda 6). Equipo Invoices (agente de backend). Worktree `ikisai-apps-invoices`.

## Hecho

- `docs/invoices/API.md` (G2) revisión 2, cotejado con el handoff V3: schema `ikisai.invoice.v1` exacto, nombre canónico `AAAA_MM_DD_(empresa)_objeto[_pNN][_NN].ext`, estados `pendiente_datos / pendiente_revision / validada / archivada / anulada`, asignación por línea con destinos `area/project/task`, `reservation/event`, `ingredient/equipment`, `general`, ZIP `IKISAI_COMPRAS_AAAA_TN/` con `facturas/`, tres CSV y `manifest.json` sin cerrar registros. Aprobado de forma provisional por Core.
- `docs/invoices/PETICIONES.md` con las peticiones resueltas y las abiertas (fase 2).

- PR #2 (API.md) y PR #26 (dominio compartido `_domain/invoices`: schema `ikisai.invoice.v1`, recálculo con tolerancia, nombre canónico, validación de campos, resúmenes; 10 pruebas) fusionadas.
- Migraciones `20261006_0200_invoices_model.sql` (tablas, triggers de bloqueo y nombre canónico, proyecciones para Booking y Food) y `20261006_0201_invoices_rules.sql` (recálculo SQL, hook `check_invariants`, `import_v1`, `validate`, `annul`, `create_export`, `mark_delivered`, `archive_period`, lecturas `fiscal_summary`, `items`, `export_bundle`, `export_preview`) con 8 pruebas contra PGlite a través de `invoices-api` (paridad con el dominio TS).

- PR #33 (migraciones) fusionada.
- Edge `invoices-api` completa (PR #37): `beforeCommit` con el dominio compartido, documentos comprobados en `core.files`, destinos `tasks` validados con el token del usuario contra `read/tasks.targets`, destinos `food` por las proyecciones de Food, `booking` deshabilitado hasta fase 2; rutas `dashboard`, `imports/preview`, `targets/*`, `exports/accountant`, `exports/:id/{manifest.json,*.csv,download}` (ZIP «store» en streaming con escritor propio). 8 pruebas (`tests/invoices/api.test.ts`).
- Pantallas sobre `@ikisai/ui-kit` (PR #37): **Inicio** (tarjetas de estado, trimestre, «Nueva factura»), **Facturas** (lista por mes con filtros; ficha en hoja con documento, artículos, impuestos, asignación por línea, pago, fiscal, importación; alta con documento y vista previa del nombre canónico; importar JSON con cuadre; validar, anular, archivar), **Compras** (por categoría, destino, proveedor o artículos; periodo; «solo validadas»; totales), **Gestoría** (resumen fiscal, alertas, entregas con ZIP/manifest/CSV, preparar entrega, marcar entregada, archivar periodo). Todo calculado en local con el dominio compartido; hoja de asignación con destinos de Tareas y Cocina (buscador con red, recientes sin red) y generales.
- `tests/invoices/fake-api.ts` ampliada (todas las tablas, recálculo y procedimientos mínimos) y `smoke.spec.ts` con factura a mano, Compras, Gestoría e Inicio.

- PR #37 fusionada y publicada en `invoices.ikisai.com` (`v0.1.0-build.47`).
- Tanda 2 (`invoices/aceptacion`): `tests/invoices/acceptance.spec.ts` automatiza el recorrido A1–A13 y A18 (documento con nombre canónico y lectura firmada, importación del ejemplo del handoff con proveedor por NIF, cuadre y REVISAR IMPORTES, validar y editar tras validar, asignación a Tareas y Cocina con el token del usuario, sobreasignación, Compras, Gestoría, anulación) y los escenarios offline O1–O6 (cola con PDF y JSON, recarga sin red, reconexión con subida y verificación, fusión de campos disjuntos, conflicto solapado, destino desaparecido → rechazado, subida que no verifica). La API falsa de Playwright reproduce la superficie de `invoices-api` (subidas, destinos, `import_v1`, `validate`, `annul`, hook de estados).
- La importación desde la app se envía como operaciones de fila (`importOperations` del dominio) para que funcione sin red con espejo optimista; `invoices.import_v1` queda para la API.
- Proveedores: formulario con alias e «inversión por defecto». Compras y ficha: indicador de obsolescencia de destinos («destino cambiado / desaparecido») comparando revisiones con red.

- PR #53 fusionada. Humo real de Core contra `invoices.ikisai.com` (importación del ejemplo y ZIP): 10 de 10.
- Tanda 3 (`invoices/tanda3`): escenarios O7–O9 (Compras y resumen fiscal idénticos sin red tras recargar; `reader` solo lee, también sin red, sin botones de escritura; cerrar sesión vacía el espejo), filtros de Compras por destino (retiro, ingrediente, maquinaria, proyecto…), tipo de artículo y «solo sin asignar»; `[hidden]` fuerza `display:none` sobre las clases del kit.

- PR #68 fusionada.
- Tanda 4 (`invoices/tanda4`): prompt de extracción para ChatGPT copiable dentro de «Importar JSON» (`_domain/invoices/extraction-prompt.ts`, con el schema resumido y un ejemplo, porque quien lo pega no tiene el archivo del handoff); capturas a 390 px y 1440 px con `tests/invoices/shots.ts` (`npx tsx tests/invoices/shots.ts`, salida en `App/capturas-invoices-2026-10-06`) y ajustes: pestañas cortas en Compras, casillas sin estirar, hueco para el botón flotante, chip «Desde JSON», el aviso «se sincronizará cuando haya red» solo sin red.

- PR #72 (tanda 4) fusionada.
- Tanda 5 (`invoices/tanda5`): contrato e implementación de `POST imports/extract` (extracción automática V2; llama al helper `extractInvoice` de `_kit` cuando Core lo publique, mientras tanto `EXTRACTION_UNAVAILABLE 503`; documento validado contra el schema; pruebas con un extractor simulado), botones «Extraer» en la factura pendiente de datos y «Extraer pendientes» en Facturas que llevan el resultado a la vista previa de importación; medida de `loadMirror` con 500 facturas sintéticas (`tests/invoices/perf.ts`) y agrupación de las recargas del espejo.

- PR #79 (tanda 5) fusionada.
- Tanda 6 (`invoices/tanda6`): destinos de Reservas activos en la hoja de asignación (buscador «Reservas (eventos: retiros)» contra `targets/booking`, que lee `booking.food_event_projection` registrada para `invoices` por la migración 0402 de Booking, PR #80); ajuste de `tests/invoices/api.test.ts` empujado a la rama de Booking a petición de Core.

- PR #82 (tanda 6) fusionada.
- Tanda 7 (`invoices/tanda7`): artículos de la ficha reordenables a mano con `createSortableList` del kit (guarda `position`; decisión del usuario «orden manual»); extracción automática conectada al helper `createDocumentExtractor` de `_kit/extract.ts` (PR #91 de Core) con el JSON Schema del handoff (salida estructurada) y el prompt sin prosa; coste de cada extracción (`usage`) visible en la hoja de importación; `EXTRACTION_INVALID` abre la importación manual con los motivos y avisos del modelo. Enlaces estables para otras apps (`API.md` §9.6): `#/facturas/<código>` y `#/compras?destino=<app>:<kind>:<id>`. Prueba O7–O9 estabilizada antes (PR #96).

- PR #103 (tanda 7) fusionada.
- Tanda 8 (`invoices/tanda8`): agentes de IA. `invoices.import_v1` seguro para agentes; hook `agentRisk` que exige aprobación al tocar facturas ya entregadas a la gestoría o validadas (salvo asignar destinos); cada importación cuenta para el umbral de 10 (migración 0202, `API.md` §4.4).

- PR #105 (tanda 8) fusionada.
- Tanda 9 (`invoices/tanda9`): unidad normalizada en `invoices.food_stock_projection` para Food (`unit_normalized` kg/l/ud y `quantity_normalized`; migración 0203).

- PR #110 (tanda 9) fusionada.
- Tanda 10 (`invoices/tanda10`): herramientas MCP de dominio (`invoices_import_json`, `invoices_purchases`, `invoices_fiscal_summary`; `API.md` §6.6) y puerto libre pedido al sistema en los arneses de Playwright (`tests/invoices/free-port.ts`, receta de Booking).

- PR #118 (tanda 10) fusionada.
- Tanda 11 (`invoices/tanda11`): extracción con `createDocumentExtractorFromEnv` (OpenAI si hay `OPENAI_API_KEY`, si no Anthropic); registro de extracciones con su coste en `invoices.extractions` y límite de una extracción por documento de factura pendiente para los agentes, con propuesta aprobada para repetir (migración 0204, `API.md` §6).

- PR #125 (tanda 11) fusionada.
- Tanda 12 (`invoices/tanda12`), incidencias de la aceptación del usuario en Android: proveedor nuevo desde la hoja «Nueva factura» («+ Nuevo proveedor…» con nombre y NIF) y bloque «Extraer con ChatGPT» (copiar prompt, pegar JSON) junto al documento, en la hoja nueva y en la ficha pendiente de datos.
- PR #138 (tanda 12) fusionada y publicada.
- Tanda 13 (`invoices/emitidas-propuesta`, PR #141): facturas emitidas registradas, preparadas para Verifactu (API.md §13). Migración 0205 con series, cabecera, líneas, desglose, documentos y destino del ingreso; columnas `vf_*` reservadas y vacías; sin papelera y número único sobre todas las filas; recálculo de totales en el hook `invoices.check_issued`; `invoices.annul_issued`; proyección `invoices.booking_income_projection` para Booking. Pestaña «Recibidas · Emitidas» en Facturas con lista, ficha (cobro, anular) y alta manual.

- Tanda 14 (misma rama y PR #141, CI bloqueada): IVA repercutido (`invoices.issued_summary` y `issuedSummary`, iguales en SQL y en el dominio) en Gestoría y en el MCP; emitidas en la entrega a la gestoría (migración 0206: manifest, carpeta `emitidas/`, `facturas_emitidas.csv`, filas repercutidas en `resumen_impuestos.csv`, desfase por emitidas); asignar una emitida a una reserva o un evento desde su ficha.

- Tanda 15 (misma rama y PR #141): importación de emitidas desde CSV del Google Sheet con mapeo de columnas recordado, prompt de emitidas para ChatGPT con el PDF adjunto, y categorías de ingreso nuevas (tienda, artesanía, consultoría) con IVA sugerido editable. Nombre de la app: pasa a Finance (lo coordina Core; aquí no se cambia nada interno hasta su aviso).

- PR #141 (tandas 13–15) fusionada y publicada.
- Fase 1 de la extracción sin API de pago (ronda 29, `invoices/ia-compartir`): «Analizar con IA» comparte el documento y `ikisai_invoice_contract.txt` con la app de IA del usuario; vuelve por `share_target` o pegando; sobre `source` con nombre y hash del documento; JSON extraído del texto y validado como no confiable (API.md §6.7).

- PR #153 (fase 1) fusionada y publicada.
- Fase 2 de la extracción sin API de pago (`invoices/ia-pdf-texto`): «Leer PDF» con PDF.js bajo demanda; extractor determinista con NIF/CIF con control, fechas, número, IVA por tipo, retención, total e IBAN; procedencia por campo; duplicado blando; PDF escaneado remitido a «Analizar con IA» (API.md §6.8). Corregido el enlace `#/facturas?vista=emitidas`, roto por un carácter de control.

- PR #155 (fase 2) fusionada.
- Invoices pasa a llamarse **Finance** (ronda 31, fase B): `https://finance.ikisai.com` en `INVOICES_ORIGINS` (el antiguo se quita tras la fase C de Core) y nombre visible «Ikisai Finance» en la app y el manifiesto. Nada interno cambia: schema `invoices`, app id, `invoices-api`, proyecto Pages.

- Fase 3, PR 1 de 3 (`invoices/fase3-modelo`): migración 0207 con `invoices.supplier_templates` (sincronizada) e `invoices.document_texts` (solo Edge, no se copia al dispositivo, se borra con su documento); hook `invoices.check_templates` (una plantilla solo se escribe en un lote donde una factura de ese proveedor pasa a validada; el owner puede retirarla); ruta `POST documents/:fileId/text` y lectura `invoices.document_text`.

- Fase 3, PR 2 de 3 (`invoices/fase3-motor`): motor de plantillas en `_domain/invoices/supplier-templates.ts` (huella y Jaccard, aprender de una confirmación, aplicar con confianza según la evidencia, aciertos y fallos, variantes, retirar una regla tras 3 fallos, versión nueva con otro formato, operación para el lote de `invoices.validate`) y `extractWithTemplates` («Leer PDF» con la plantilla del proveedor y reglas genéricas para el resto).

- Fase 3, PR 3 de 3 (`invoices/fase3-app`): las plantillas en la app. «Leer PDF» usa la plantilla del proveedor (`extractWithTemplates`) y guarda el texto leído en el servidor; «Validar» aprende o actualiza la plantilla en el mismo lote; la ficha del proveedor muestra sus plantillas y el owner puede retirarlas. Fase 3 completa.

- Compras de Tasks (ronda 34, migración 0208): destino `tasks` / `purchase_request` en la hoja de asignación y lecturas `invoices.allocations_by_target` e `invoices.supplier_options` para Tasks (API.md §7.4).

- Fecha y objeto del documento frente a lo escrito al subir (ronda 35): discrepancia visible con «Usar la del documento»; preselección solo si la escrita era la de hoy por defecto (en hora local); la plantilla no cuenta como fallo un valor que no está en el documento.

- Emisor de las emitidas (ronda 37, migración 0209): copia de `central.common_entity_projection` al registrar (`issuer_tax_id`, `issuer_name`, `issuer`), ruta `GET entity` con el logotipo firmado sin guardarlo, bloque «Emisor» y aviso «Faltan los datos de la entidad en Central» en la ficha y en «Nueva emitida», y «Imprimir copia» marcada «COPIA DE REGISTRO» (API.md §13).

## En curso

- Extracción sin API de pago: fases 1–3 hechas; la fase 4 (OCR con Google Drive) espera la autorización de Google del usuario.

## Pendiente

- Aceptación manual en Android: la hace el usuario con facturas reales del negocio; sus incidencias llegan por el buzón de Core.
- Extracción automática real: falta que Core deje `ANTHROPIC_API_KEY` como secreto del proyecto; hasta entonces la ruta responde `EXTRACTION_UNAVAILABLE` y la app ofrece pegar el JSON.
- Fase 2: las lecturas de `invoices.booking_cost_projection` (para `booking`) y `invoices.food_stock_projection` (para `food`) ya están registradas en la migración 0200; falta que Booking y Food las consuman.
- Humo real contra `invoices-api` publicada tras la fusión (lo publica Core).

## Bloqueos

- Ninguno.
