/**
 * Autoguardado del huésped (API.md §9.4 y §10): una cola por huésped, en orden y con una sola escritura en vuelo. Cada
 * escritura lleva la revisión que devolvió la anterior (Booking §16.8, BG2). La cola vive en IndexedDB (`outbox`), así
 * que sin red los cambios esperan y se envían solos al volver; nada se da por guardado hasta que Booking responde.
 *
 * Conflictos (`VERSION_CONFLICT`, otra persona cambió la ficha): se relee la ficha. Un campo que en el servidor sigue
 * como estaba cuando el huésped empezó a escribir se reenvía solo; uno que cambió a otro valor se ofrece al huésped
 * para que elija (`onConflict`). El consentimiento y la firma se reintentan con la revisión nueva.
 */
import type { GuestApi, MyGuest, Restriction, WriteResult } from './api.ts';
import { cache } from './cache.ts';
import { errorCode, isNetworkError } from './client.ts';

export type Op =
  | { kind: 'fields'; fields: Record<string, unknown>; base: Record<string, unknown> }
  | { kind: 'consent'; args: { allergies_visible_to_organizer?: boolean; privacy_ack_version?: string } }
  | { kind: 'restrictions'; items: Restriction[] }
  | { kind: 'sign'; image: Blob; name: string; textVersion: string | null };

export type WriterState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';
export type FieldState = 'saving' | 'saved' | 'pending' | 'error';

export interface Conflict { field: string; mine: unknown; theirs: unknown }

export interface WriterOptions {
  api: GuestApi;
  userId: string;
  guest: MyGuest;
  /** Ficha releída del servidor (tras vaciar la cola o tras un conflicto). */
  onGuest(guest: MyGuest): void;
  /** Cambio de estado global o de algún campo. */
  onState(): void;
  onConflict(conflicts: Conflict[]): void;
  /** Un cambio rechazado por Booking (no de red): se descarta y se avisa. */
  onRejected(op: Op, error: unknown): void;
  /** La firma dejó de valer porque cambió un dato del registro (BG5). */
  onSignatureReset(): void;
}

export interface Writer {
  enqueue(op: Op): void;
  state(): WriterState;
  pending(): number;
  fieldState(field: string): FieldState | null;
  /** Hay algo sin confirmar (cola, en vuelo o conflicto por decidir): no se debe actualizar la app ni salir. */
  busy(): boolean;
  resolve(conflict: Conflict, choice: 'mine' | 'theirs'): void;
  flush(): Promise<void>;
  destroy(): void;
}

const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '') || JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

export function createWriter(options: WriterOptions): Writer {
  const { api, userId } = options;
  const guestId = options.guest.id;
  let revision = options.guest.revision;
  let queue: Op[] = [];
  let inFlight: Op | null = null;
  let state: WriterState = 'idle';
  let conflicts = 0;
  const fields = new Map<string, FieldState>();
  let running: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const persist = () => (queue.length ? cache.saveOutbox(userId, guestId, queue) : cache.dropOutbox(userId, guestId));
  const notify = () => { if (!destroyed) options.onState(); };
  const markFields = (op: Op, value: FieldState | null) => {
    if (op.kind !== 'fields') return;
    for (const key of Object.keys(op.fields)) value ? fields.set(key, value) : fields.delete(key);
  };

  function enqueue(op: Op): void {
    const last = queue[queue.length - 1];
    if (op.kind === 'fields' && last?.kind === 'fields') {
      last.fields = { ...last.fields, ...op.fields };
      last.base = { ...op.base, ...last.base };
    } else if (op.kind === 'restrictions' && last?.kind === 'restrictions') {
      last.items = op.items;
    } else if (op.kind === 'consent' && last?.kind === 'consent') {
      last.args = { ...last.args, ...op.args };
    } else {
      queue.push(op);
    }
    markFields(op, 'pending');
    void persist();
    notify();
    void flush();
  }

  async function reload(): Promise<MyGuest | null> {
    try {
      const fresh = (await api.myGuest(guestId)).value;
      revision = fresh.revision;
      return fresh;
    } catch {
      return null;
    }
  }

  async function send(op: Op): Promise<WriteResult> {
    switch (op.kind) {
      case 'fields': return api.update(guestId, revision, op.fields);
      case 'consent': return api.consent(guestId, revision, op.args);
      case 'restrictions': return api.restrictions(guestId, op.items);
      case 'sign': return api.sign(guestId, revision, op.image, op.name, op.textVersion);
    }
  }

  /** Conflicto: separa lo que se puede reenviar de lo que tiene que decidir el huésped. */
  async function onConflict(op: Op): Promise<'retry' | 'drop' | 'network'> {
    const fresh = await reload();
    if (!fresh) return 'network';
    options.onGuest(fresh);
    if (op.kind !== 'fields') return 'retry';
    const found: Conflict[] = [];
    for (const [key, mine] of Object.entries(op.fields)) {
      const theirs = fresh.fields[key];
      if (same(theirs, mine)) delete op.fields[key];
      else if (!same(theirs, op.base[key])) { found.push({ field: key, mine, theirs }); delete op.fields[key]; }
    }
    if (found.length) {
      conflicts += found.length;
      for (const c of found) fields.delete(c.field);
      options.onConflict(found);
    }
    return Object.keys(op.fields).length ? 'retry' : 'drop';
  }

  async function run(): Promise<void> {
    while (!destroyed && queue.length) {
      const op = queue[0]!;
      inFlight = op;
      state = 'saving';
      markFields(op, 'saving');
      notify();
      try {
        const result = await send(op);
        revision = result.revision ?? revision;
        queue.shift();
        markFields(op, 'saved');
        if (result.signature_reset) options.onSignatureReset();
      } catch (error) {
        if (isNetworkError(error) || errorCode(error) === 'UPLOAD_FAILED') {
          markFields(op, 'pending');
          state = 'offline';
          inFlight = null;
          notify();
          scheduleRetry();
          return;
        }
        if (errorCode(error) === 'VERSION_CONFLICT') {
          const next = await onConflict(op);
          if (next === 'network') { state = 'offline'; inFlight = null; notify(); scheduleRetry(); return; }
          if (next === 'drop') queue.shift();
          continue;
        }
        queue.shift();
        markFields(op, 'error');
        options.onRejected(op, error);
      } finally {
        inFlight = null;
        await persist();
      }
    }
    if (destroyed) return;
    state = [...fields.values()].includes('error') ? 'error' : 'saved';
    notify();
    const fresh = await reload();
    if (fresh && !queue.length) options.onGuest(fresh);
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      for (const [key, value] of fields) if (value === 'saved') fields.delete(key);
      if (state === 'saved') state = 'idle';
      notify();
    }, 2500);
  }

  function scheduleRetry(): void {
    if (retryTimer || destroyed) return;
    retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, 15_000);
  }

  function flush(): Promise<void> {
    // Un cambio encolado mientras la vuelta anterior releía la ficha se envía en una vuelta nueva (no se queda esperando).
    if (!running) running = run().finally(() => { running = null; if (!destroyed && queue.length && state !== 'offline') void flush(); });
    return running;
  }

  const onOnline = () => { void flush(); };
  window.addEventListener('online', onOnline);

  // Cambios que quedaron sin enviar en una visita anterior (sin red o con la app cerrada a medias).
  void cache.outbox<Op[]>(userId, guestId).then((saved) => {
    if (!saved?.length || destroyed) return;
    queue = [...saved, ...queue];
    for (const op of saved) markFields(op, 'pending');
    notify();
    void flush();
  });

  return {
    enqueue,
    state: () => state,
    pending: () => queue.length,
    fieldState: (field) => fields.get(field) ?? null,
    busy: () => queue.length > 0 || inFlight !== null || conflicts > 0,
    resolve(conflict, choice) {
      conflicts = Math.max(0, conflicts - 1);
      if (choice === 'mine') enqueue({ kind: 'fields', fields: { [conflict.field]: conflict.mine }, base: { [conflict.field]: conflict.theirs } });
      else notify();
    },
    flush,
    destroy() {
      destroyed = true;
      window.removeEventListener('online', onOnline);
      if (retryTimer) clearTimeout(retryTimer);
      if (savedTimer) clearTimeout(savedTimer);
    },
  };
}
