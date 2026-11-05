/**
 * `crypto.randomUUID` solo existe en contextos seguros (https o localhost). Al abrir la app desde la red de casa
 * (`http://192.168…`, corrección en caliente con VG) no está y ningún guardado salía del dispositivo. Aquí se pone uno
 * equivalente (UUID v4 con `getRandomValues`, que sí existe) solo cuando falta: en https no cambia nada.
 */
const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
if (c && typeof c.randomUUID !== 'function' && typeof c.getRandomValues === 'function') {
  Object.defineProperty(c, 'randomUUID', {
    configurable: true,
    value: (): string => {
      const b = c.getRandomValues(new Uint8Array(16));
      b[6] = (b[6]! & 0x0f) | 0x40;
      b[8] = (b[8]! & 0x3f) | 0x80;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  });
}
export {};
