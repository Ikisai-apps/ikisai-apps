import type { SyncStatus } from '@ikisai/sync-client';
import { el, formatDate, replace } from './dom.ts';
import { SUPPLIERS } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredInstall: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event as InstallPromptEvent;
});

export const mountHome: ViewMount = ({ main, client, navigate, logout }) => {
  const supplierCount = el('dd', null, '…');
  const network = el('dd');
  const pending = el('dd');
  const conflicts = el('dd');
  const lastPull = el('dd');
  const cursor = el('dd');
  const role = el('dd');

  function paint(status: SyncStatus): void {
    network.textContent = status.network === 'online' ? 'En línea' : status.network === 'offline' ? 'Sin conexión' : status.network === 'syncing' ? 'Sincronizando…' : 'Error';
    pending.textContent = String(status.pendingCommands + status.pendingBlobs);
    conflicts.textContent = String(status.conflicts);
    lastPull.textContent = formatDate(status.lastPullAt);
    cursor.textContent = String(status.cursor);
    const boot = client.bootstrap();
    role.textContent = boot ? { owner: 'Propietario', editor: 'Editor', reader: 'Solo lectura' }[boot.membership.role] : '—';
  }

  async function count(): Promise<void> {
    const rows = await client.list(SUPPLIERS);
    supplierCount.textContent = rows.length === 1 ? '1 proveedor' : `${rows.length} proveedores`;
  }

  const name = client.bootstrap()?.profile.displayName;
  const installCard = el('article', { class: 'card' },
    el('h3', null, 'Instalar en este dispositivo'),
    el('p', null, 'Como app instalada se abre a pantalla completa y funciona sin conexión.'),
    deferredInstall
      ? el('p', null, el('button', { class: 'ghost', type: 'button', style: 'margin-top:10px', onclick: async () => { await deferredInstall?.prompt(); deferredInstall = null; } }, 'Instalar Ikisai Invoices'))
      : el('p', { style: 'margin-top:8px' }, 'En Android: menú del navegador → «Instalar aplicación». En iPhone: Compartir → «Añadir a pantalla de inicio».'),
  );

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, name ? `Hola, ${name}` : 'Inicio'), el('p', null, 'Fase 0: proveedores y sincronización sin conexión.'))),
    el('div', { class: 'cardgrid' },
      el('a', { class: 'card cardlink', href: '#/proveedores', onclick: (e: Event) => { e.preventDefault(); navigate('#/proveedores'); } },
        el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        el('h3', null, 'Proveedores'),
        el('p', null, 'Altas, NIF, categoría por defecto y notas.'),
        el('dl', { class: 'kv' }, el('dt', null, 'Activos'), supplierCount),
      ),
      el('article', { class: 'card' },
        el('h3', null, 'Sincronización'),
        el('p', null, 'Estado del espejo local en este dispositivo.'),
        el('dl', { class: 'kv' },
          el('dt', null, 'Red'), network,
          el('dt', null, 'Pendientes'), pending,
          el('dt', null, 'Conflictos'), conflicts,
          el('dt', null, 'Último pull'), lastPull,
          el('dt', null, 'Cursor'), cursor,
          el('dt', null, 'Rol'), role,
        ),
      ),
      installCard,
      el('article', { class: 'card' },
        el('h3', null, 'Cuenta'),
        el('p', null, name ? `Sesión iniciada como ${name}.` : 'Sesión iniciada.'),
        el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', id: 'logoutHome', onclick: () => void logout() }, 'Cerrar sesión')),
      ),
      ...['Facturas', 'Compras', 'Gestoría'].map((title) =>
        el('article', { class: 'card' }, el('h3', null, title), el('p', null, 'Pendiente de la fase 1.')),
      ),
    ),
  );

  paint(client.status());
  void count();
  const offStatus = client.onStatus(paint);
  const offTable = client.onTable(SUPPLIERS, () => void count());
  return () => {
    offStatus();
    offTable();
  };
};
