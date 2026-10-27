Guiado listo para un recorrido real en el móvil y encajado con Flow (0940):
- `createGuide`: en el móvil, mientras la persona escribe en la app (foco en un campo tocado o teclado abierto), la burbuja queda en una tira arriba que no tapa el campo, el teclado ni «Guardar». El foco que pone la guía al llegar no la pliega. Lo guardado sin red (`pending`) se reconfirma al guardarse de verdad.
- `flowGuideSource`: «Saltar» va como `how: 'none'` (`requestId` `…:skip`); `pending` lleva `requestId` propio (`…:p`); en modo `learn` no se confirma.
- `createAppShell({ guide })`: si no se da `app`, sale del primer segmento de `feedbackId`.
