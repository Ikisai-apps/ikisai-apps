import type { SyncStatus } from '@ikisai/sync-client';
import { el, formatDate, icon, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { fb, type FbMark } from './feedback.ts';
import { fiscalSummary, purchaseItems } from '@ikisai/domain-invoices';
import { workingQuarter, eur, loadMirror, onAnyTable, rangeLabel, todayIso } from '../app/data.ts';
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

/** Inicio (API.md §9.1): estado antes que formulario; tarjetas con número y acción. */
export const mountHome: ViewMount = ({ main, client, navigate, logout }) => {
  const stat = (id: string) => el('dd', { id }, '…');
  const pendingData = stat('statPendingData'); const pendingReview = stat('statPendingReview'); const unassigned = stat('statUnassigned'); const unpaid = stat('statUnpaid');
  const supplierCount = stat('statSuppliers');
  const fromDrive = stat('statFromDrive');
  const driveState = el('p', { class: 'hint', id: 'driveState' });
  const isOwner = client.bootstrap()?.membership.role === 'owner';
  const quarterBase = stat('statQuarterBase'); const quarterVat = stat('statQuarterVat'); const quarterCount = stat('statQuarterCount');
  const network = el('dd'); const pending = el('dd'); const conflicts = el('dd'); const lastPull = el('dd'); const role = el('dd');

  function paintStatus(status: SyncStatus): void {
    network.textContent = status.network === 'online' ? 'En línea' : status.network === 'offline' ? 'Sin conexión' : status.network === 'syncing' ? 'Sincronizando…' : 'Error';
    pending.textContent = String(status.pendingCommands + status.pendingBlobs);
    conflicts.textContent = String(status.conflicts + status.rejected);
    lastPull.textContent = formatDate(status.lastPullAt);
    const boot = client.bootstrap();
    role.textContent = boot ? { owner: 'Propietario', editor: 'Editor', reader: 'Solo lectura' }[boot.membership.role] : '—';
  }

  async function paintCounts(): Promise<void> {
    const m = await loadMirror(client);
    const live = m.invoices.filter((i) => !i.deleted_at && i.status !== 'anulada');
    const today = todayIso();
    pendingData.textContent = String(live.filter((i) => i.status === 'pendiente_datos').length);
    const drive = live.filter((i) => i.drive_file_id && (i.status === 'pendiente_datos' || i.status === 'pendiente_revision'));
    fromDrive.textContent = drive.length ? `${drive.length} (${drive.filter((i) => i.status === 'pendiente_datos').length} sin leer)` : '0';
    const review = live.filter((i) => i.status === 'pendiente_revision');
    const revisar = review.filter((i) => i.review_reason === 'REVISAR IMPORTES').length;
    pendingReview.textContent = revisar ? `${review.length} (${revisar} con importes por revisar)` : String(review.length);
    const items = purchaseItems({ invoices: m.invoices, lines: m.lines, suppliers: m.suppliers, allocations: m.allocations }, { unassignedOnly: true });
    unassigned.textContent = items.items.length ? `${items.items.length} · ${eur(items.total_unallocated)}` : '0';
    const due = live.filter((i) => i.payment_status === 'pendiente');
    const overdue = due.filter((i) => i.due_date && i.due_date < today).length;
    unpaid.textContent = overdue ? `${due.length} (${overdue} vencidas)` : String(due.length);
    supplierCount.textContent = String(m.suppliers.filter((s) => !s.deleted_at).length);
    const q = fiscalSummary({ invoices: m.invoices, taxLines: m.taxes }, workingQuarter());
    quarterBase.textContent = eur(q.base); quarterVat.textContent = eur(q.vat); quarterCount.textContent = String(q.invoices.validada + q.invoices.archivada);
  }

  const name = client.bootstrap()?.profile.displayName;
  const link = (mark: FbMark, href: string, title: string, text: string, dd: HTMLElement, dt: string) =>
    fb(el('a', { class: 'card cardlink', href, onclick: (e: Event) => { e.preventDefault(); navigate(href); } },
      el('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'), el('h3', null, title), el('p', null, text), el('dl', { class: 'kv' }, el('dt', null, dt), dd)), mark);

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, name ? `Hola, ${name}` : 'Inicio'), el('p', null, 'Facturas de compra: documento, datos, revisión, asignación y gestoría. Todo funciona sin conexión.'))),
    el('div', { class: 'cardgrid' },
      link({ feedbackId: 'invoices.inicio.pendientes_datos', feedbackLabel: 'Pendientes de datos' }, '#/facturas?filtro=pendiente_datos', 'Pendientes de datos', 'Facturas con documento pero sin importar ni teclear.', pendingData, 'Facturas'),
      link({ feedbackId: 'invoices.inicio.pendientes_revision', feedbackLabel: 'Pendientes de revisión' }, '#/facturas?filtro=pendiente_revision', 'Pendientes de revisión', 'Importadas o editadas; hay que validarlas a mano.', pendingReview, 'Facturas'),
      link({ feedbackId: 'invoices.inicio.sin_asignar', feedbackLabel: 'Sin asignar' }, '#/compras', 'Sin asignar', 'Artículos de facturas validadas sin destino.', unassigned, 'Artículos'),
      link({ feedbackId: 'invoices.inicio.sin_pagar', feedbackLabel: 'Sin pagar' }, '#/facturas?filtro=sin_pagar', 'Sin pagar', 'Facturas con el pago pendiente.', unpaid, 'Facturas'),
      el('article', { class: 'card', 'data-feedback-id': 'invoices.inicio.trimestre', 'data-feedback-label': 'Trimestre' },
        el('h3', null, rangeLabel(workingQuarter())),
        el('p', null, 'Solo lo validado. Detalle y entrega en Gestoría.'),
        el('dl', { class: 'kv', 'data-feedback-ignore': '' }, el('dt', null, 'Base'), quarterBase, el('dt', null, 'IVA soportado'), quarterVat, el('dt', null, 'Facturas'), quarterCount),
        el('p', { style: 'margin-top:10px' }, el('button', { 'data-feedback-id': 'invoices.inicio.trimestre.ir_gestoria', 'data-feedback-label': 'Ir a Gestoría', class: 'ghost', type: 'button', onclick: () => navigate('#/gestoria') }, icon('briefcase', 16), 'Ir a Gestoría')),
      ),
      fb(el('article', { class: 'card' },
        el('h3', null, 'Desde Google Drive'),
        el('p', null, 'Las facturas que dejas en la carpeta «Entrada» llegan solas cada 15 minutos, leídas si el PDF tiene texto. Revísalas y valídalas.'),
        el('dl', { class: 'kv' }, el('dt', null, 'Por revisar'), fromDrive),
        el('p', { style: 'margin-top:10px', class: 'btnrow' },
          el('button', { 'data-feedback-id': 'invoices.inicio.drive.ver', 'data-feedback-label': 'Ver las de Drive', class: 'ghost', type: 'button', onclick: () => navigate('#/facturas?filtro=drive') }, 'Ver las de Drive'),
          isOwner ? el('button', { 'data-feedback-id': 'invoices.inicio.drive.buscar', 'data-feedback-label': 'Buscar ahora', class: 'ghost', type: 'button', id: 'driveRun', onclick: (e: Event) => void runDrive(e.currentTarget as HTMLButtonElement) }, 'Buscar ahora') : null),
        isOwner ? driveState : null,
      ), { feedbackId: 'invoices.inicio.drive', feedbackLabel: 'Desde Google Drive' }),
      link({ feedbackId: 'invoices.inicio.proveedores', feedbackLabel: 'Proveedores' }, '#/proveedores', 'Proveedores', 'Altas, NIF, alias y categoría por defecto.', supplierCount, 'Activos'),
      el('article', { class: 'card', 'data-feedback-id': 'invoices.inicio.sincronizacion', 'data-feedback-label': 'Sincronización' },
        el('h3', null, 'Sincronización'),
        el('dl', { class: 'kv' }, el('dt', null, 'Red'), network, el('dt', null, 'Pendientes'), pending, el('dt', null, 'Conflictos y rechazados'), conflicts, el('dt', null, 'Último pull'), lastPull, el('dt', null, 'Rol'), role),
        el('p', { style: 'margin-top:10px' }, el('button', { 'data-feedback-id': 'invoices.inicio.sincronizacion.ver_conflictos', 'data-feedback-label': 'Ver conflictos', class: 'ghost', type: 'button', onclick: () => navigate('#/conflictos') }, 'Ver conflictos')),
      ),
      el('article', { class: 'card' },
        el('h3', null, 'Instalar en este dispositivo'),
        el('p', null, 'Como app instalada se abre a pantalla completa y funciona sin conexión.'),
        deferredInstall
          ? el('p', null, el('button', { 'data-feedback-id': 'invoices.inicio.instalar', 'data-feedback-label': 'Instalar Ikisai Finance', class: 'ghost', type: 'button', style: 'margin-top:10px', onclick: async () => { await deferredInstall?.prompt(); deferredInstall = null; } }, 'Instalar Ikisai Finance'))
          : el('p', { style: 'margin-top:8px' }, 'En Android: menú del navegador → «Instalar aplicación». En iPhone: Compartir → «Añadir a pantalla de inicio».'),
      ),
      el('article', { class: 'card', 'data-feedback-id': 'invoices.inicio.cuenta', 'data-feedback-label': 'Cuenta' },
        el('h3', null, 'Cuenta'),
        el('p', null, name ? `Sesión iniciada como ${name}.` : 'Sesión iniciada.'),
        el('p', { style: 'margin-top:10px' }, el('button', { 'data-feedback-id': 'invoices.inicio.cuenta.cerrar_sesion', 'data-feedback-label': 'Cerrar sesión', class: 'ghost', type: 'button', id: 'logoutHome', onclick: () => void logout() }, 'Cerrar sesión')),
      ),
    ),
    el('button', { 'data-feedback-id': 'invoices.inicio.nueva_factura', 'data-feedback-label': 'Nueva factura', class: 'fab', type: 'button', id: 'homeNewInvoice', hidden: client.bootstrap()?.membership.role === 'reader', onclick: () => navigate('#/facturas/nueva') }, icon('plus'), 'Nueva factura'),
  );

  /** Estado de Drive para el owner: última búsqueda, salud y lo que no entró (duplicados o con errores). */
  async function paintDrive(): Promise<void> {
    if (!isOwner || !navigator.onLine) return;
    try {
      const st = await client.api<{ state: { last_run_at: string | null; health: string; health_detail: string | null } | null; files: Array<{ name: string; status: string; reason: string | null }> }>('/read/invoices.drive_status', { json: {} });
      const health = st.state?.health ?? 'unknown';
      const last = st.state?.last_run_at ? `Última búsqueda: ${formatDate(st.state.last_run_at)}.` : 'Aún no se ha buscado.';
      const problem = health === 'not_configured' ? ' Drive no está configurado.'
        : health === 'blocked' ? ` Drive rechaza la cuenta de servicio: ${st.state?.health_detail ?? ''}`
        : health === 'error' ? ` ${st.state?.health_detail ?? 'Fallo pasajero; se reintenta.'}` : '';
      const skipped = st.files.filter((f) => f.status !== 'importada').slice(0, 5);
      const list = skipped.map((f) => `${f.name} (${f.status === 'duplicada' ? 'duplicada' : f.reason ?? 'error'})`).join(' · ');
      replace(driveState, `${last}${problem}`, ...(skipped.length ? [el('br'), `Últimos sin importar: ${list}`] : []));
    } catch { replace(driveState, ''); }
  }
  async function runDrive(button: HTMLButtonElement): Promise<void> {
    if (!navigator.onLine) { toast('Buscar en Drive necesita conexión.'); return; }
    button.disabled = true;
    try {
      const r = await client.api<{ outcome: string; imported: number; read: number; duplicates: number; errors: number; more: boolean; detail: string | null }>('/drive/run', { json: {} });
      const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
      toast(r.outcome !== 'ok' ? (r.detail ?? 'No se pudo buscar en Drive.')
        : r.imported || r.duplicates || r.errors
          ? `Drive: ${plural(r.imported, 'nueva')} (${plural(r.read, 'leída')}), ${plural(r.duplicates, 'duplicada')}, ${r.errors} con errores${r.more ? '; quedan más para la siguiente búsqueda' : ''}.`
          : 'Drive: no hay facturas nuevas en «Entrada».');
      void client.sync().catch(() => undefined);
    } catch (error) { toast(describeError(error)); }
    button.disabled = false;
    void paintDrive();
  }

  paintStatus(client.status());
  void paintCounts();
  void paintDrive();
  const offStatus = client.onStatus(paintStatus);
  const offTables = onAnyTable(client, () => void paintCounts());
  return () => { offStatus(); offTables(); };
};
