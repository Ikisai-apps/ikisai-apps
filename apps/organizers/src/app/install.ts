/**
 * Promoción de la instalación (PORTALES_V2: «promoción fuerte de la PWA», API.md §13.1) con `createInstallPrompt` del kit
 * 0.20: hoja «Instala la app» la primera vez que se entra por enlace y tarjeta en Mis retiros mientras convenga.
 * «Ahora no» se recuerda 7 días en el dispositivo.
 */
import { createInstallPrompt } from '@ikisai/ui-kit';

export const install = createInstallPrompt({ appName: 'Ikisai Organizers', app: 'organizers', markIcon: 'organizer', snoozeDays: 7 });
