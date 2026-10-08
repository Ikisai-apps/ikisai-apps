/** Utilidades de red para las pruebas de cualquier app (antes vivía en tests/food/helpers.ts y lo importaban otras apps). */
import { createServer } from 'node:net';

/** Un puerto TCP libre en 127.0.0.1 (lo abre y lo cierra enseguida). */
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
