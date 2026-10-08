/**
 * Capa global del kit para todo lo flotante: avisos (toast), hojas, diálogos, paleta, composer, pines, barra y tarjeta
 * del Revisor, barra de señalar y fantasma de arrastre.
 *
 * Por defecto es `document.body`. Las apps que acotan el CSS del kit a `.ikisai-kit` (Tasks, Finance) la fijan **una vez
 * al arrancar** con su capa: `setKitLayer(() => document.getElementById('kitLayer'))`. Fuera de ella, lo flotante sale
 * sin los estilos del kit (fallo del usuario en PC: el aviso «Enviado · FB_…» salía como una columna crema enorme).
 * El `container` que se pase a cada pieza manda sobre la capa global.
 */
let provider: (() => HTMLElement | null | undefined) | null = null;

export function setKitLayer(fn: (() => HTMLElement | null | undefined) | null): void {
  provider = fn;
}

/** Donde montar lo flotante: el `container` dado, la capa global o `document.body`. */
export function kitLayer(container?: HTMLElement | null): HTMLElement {
  return container ?? provider?.() ?? document.body;
}
