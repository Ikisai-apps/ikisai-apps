/**
 * Puerto libre pedido al sistema (receta de Booking, `tests/booking/harness.ts`): en Windows un puerto al azar puede caer
 * en un rango reservado y fallar con `listen EACCES` de forma intermitente.
 */
import { createServer } from 'node:net';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
