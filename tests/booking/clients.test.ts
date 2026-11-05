/** Booking · clientes de reservas anteriores (B-35): uno por nombre, con el contacto de su reserva más reciente. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientNamed, pastClients } from '../../apps/booking/src/app/clients.ts';

test('clientes: uno por nombre sin tildes ni mayúsculas, el contacto más reciente y sin la reserva que se edita', () => {
  const rows = [
    { id: 'a', title: 'Retiro de otoño', start_date: '2026-10-01', contact_name: 'Lucía Sintética', contact_phone: '600 000 001', contact_email: null, deleted_at: null },
    { id: 'b', title: 'Retiro de primavera', start_date: '2026-04-01', contact_name: 'lucia  sintetica', contact_phone: '600 000 000', contact_email: 'lucia@example.invalid', deleted_at: null },
    { id: 'c', title: 'Borrada', start_date: '2026-11-01', contact_name: 'Leo', contact_phone: '1', deleted_at: '2026-11-02T00:00:00Z' },
    { id: 'd', title: 'Esta', start_date: '2026-12-01', contact_name: 'Marta', contact_phone: '2', deleted_at: null },
  ];
  const clients = pastClients(rows, 'd');
  assert.deepEqual(clients.map((c) => [c.name, c.phone, c.email, c.title]), [['Lucía Sintética', '600 000 001', 'lucia@example.invalid', 'Retiro de otoño']]);
  assert.equal(clientNamed(clients, ' LUCIA sintética ')?.title, 'Retiro de otoño');
  assert.equal(clientNamed(clients, 'Marta'), null);
  assert.equal(clientNamed(clients, ''), null);
});
