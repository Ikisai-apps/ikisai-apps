/**
 * Estado de la persona en pantalla (una entrada del ámbito): su ficha de Booking y su cola de guardado (`writer.ts`).
 * Las vistas se suscriben con `onChange` y se repintan por partes, sin perder el foco de lo que se está escribiendo.
 */
import type { GuestApi, MyGuest } from './api.ts';
import { createWriter, type Conflict, type Op, type Writer } from './writer.ts';

export interface GuestContext {
  guest(): MyGuest;
  /** Hora de la copia local si la ficha viene de la caché sin red; null si es del servidor. */
  staleAt(): string | null;
  writer: Writer;
  /** Conflictos por decidir (otra persona cambió un dato mientras el huésped lo editaba). */
  conflicts(): Conflict[];
  settle(conflict: Conflict, choice: 'mine' | 'theirs'): void;
  /** La firma dejó de valer por un cambio en los datos (BG5): la pantalla lo avisa una vez. */
  signatureReset(): boolean;
  /** El aviso de protección de datos ya se aceptó (en el servidor o pendiente de enviar). */
  privacyAcked(version: string): boolean;
  ackPrivacy(version: string): void;
  onChange(listener: (reason: 'guest' | 'state' | 'conflict' | 'rejected') => void): () => void;
  lastRejected(): { op: Op; error: unknown } | null;
  destroy(): void;
}

export async function openGuest(api: GuestApi, userId: string, guestId: string): Promise<GuestContext> {
  const loaded = await api.myGuest(guestId);
  let guest = loaded.value;
  let staleAt: string | null = loaded.stale ? loaded.at : null;
  let conflicts: Conflict[] = [];
  let reset = false;
  let acked: string | null = null;
  let rejected: { op: Op; error: unknown } | null = null;
  const listeners = new Set<(reason: 'guest' | 'state' | 'conflict' | 'rejected') => void>();
  const emit = (reason: 'guest' | 'state' | 'conflict' | 'rejected') => { for (const l of listeners) l(reason); };

  const writer: Writer = createWriter({
    api, userId, guest,
    onGuest(fresh) { guest = fresh; staleAt = null; emit('guest'); },
    onState() { emit('state'); },
    onConflict(found) { conflicts = [...conflicts.filter((c) => !found.some((f) => f.field === c.field)), ...found]; emit('conflict'); },
    onRejected(op, error) { rejected = { op, error }; emit('rejected'); },
    onSignatureReset() { reset = true; emit('guest'); },
  });

  return {
    guest: () => guest,
    staleAt: () => staleAt,
    writer,
    conflicts: () => conflicts,
    settle(conflict, choice) {
      conflicts = conflicts.filter((c) => c.field !== conflict.field);
      writer.resolve(conflict, choice);
      emit('conflict');
    },
    signatureReset: () => reset,
    privacyAcked: (version) => acked === version || guest.privacy_ack_version === version,
    ackPrivacy(version) {
      acked = version;
      writer.enqueue({ kind: 'consent', args: { privacy_ack_version: version } });
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    lastRejected: () => rejected,
    destroy() { writer.destroy(); listeners.clear(); },
  };
}
