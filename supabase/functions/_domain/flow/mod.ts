/**
 * Ikisai Flow · código de dominio compartido entre la Edge `flow-api` y el frontend (contrato §5.4).
 * Primer incremento sin modelo de datos: las tablas, estados y roles de negocio llegan con el documento funcional
 * (docs/flow/ESTADO.md, «Preguntas abiertas»).
 */

/** Id de la app en `core.apps`. */
export const APP = 'flow';

/** Tablas sincronizables de Flow (`flow.*`). Vacío hasta que haya modelo de datos aprobado. */
export const TABLES = {} as const satisfies Record<string, `flow.${string}`>;
