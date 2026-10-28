import type { SyncStatus } from '@ikisai/sync-client';
import { bindOnline, closeSheet, confirmDialog, createQueue, el, fieldAttrs, formatDate, icon, openSheet, renderMedal, renderStats, replace, toast, toastWithAction, type QueueItem } from '@ikisai/ui-kit';
import { INVOICES, ISSUED_INVOICES, SETTINGS, describeError } from '../app/client.ts';
import { linksEnabled } from '../app/resources.ts';
import { fb } from './feedback.ts';
import { commitSafely } from './common.ts';
import { fiscalSummary, purchaseItems } from '@ikisai/domain-invoices';
import { workingQuarter, eur, loadMirror, onAnyTable, rangeLabel, shortDate, supplierName, todayIso, type Mirror } from '../app/data.ts';
import { homeAction, homeQueue, readChecks } from '../app/work-state.ts';
import { openFile } from '../app/files.ts';
import { OLD_DAYS, receivable, type IssuedWork } from '../app/issued-state.ts';
import { mirrorRows, type MirrorRow } from '../app/work-mirror.ts';
import { validateNow } from '../app/validate.ts';
import { quietOwnMerges } from './undo.ts';
import { chipsWithMore } from './chips.ts';
import { appEntriesHint } from './app-entries.ts';
import type { ViewMount } from './shell.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Fila de la vista previa del enlace con Recursos (R4, `invoices.resource_links_preview`). */
interface ResourceLinkRow {
  source: 'line' | 'memory'; id: string; invoice_code: string | null; name: string;
  action: 'enlazar' | 'crear' | 'dudoso' | 'omitir'; reason: string | null; item_name: string | null; kind: string | null; base_unit: string | null;
}
interface ResourceLinksPreview { rows: ResourceLinkRow[]; counts: Record<'lines' | 'memory' | 'enlazar' | 'crear' | 'dudoso' | 'omitir' | 'new_items', number>; digest: string }

const LINK_REASONS: Record<string, string> = {
  sin_tipo: 'sin tipo de artículo', unidad: 'unidad no reconocida', unidad_distinta: 'otra unidad que el artículo', mismo_nombre: 'mismo nombre con tipos o unidades distintos',
  sin_nombre: 'sin nombre', generica: 'línea genérica', servicio: 'servicio',
};
const KIND_NAMES: Record<string, string> = { ingrediente: 'Ingrediente', maquina: 'Máquina', material: 'Material', otro: 'Otro' };
function resourceLinkDetail(r: ResourceLinkRow): string {
  if (r.action === 'enlazar') return `con «${r.item_name ?? ''}»`;
  if (r.action === 'crear') return `${KIND_NAMES[r.kind ?? ''] ?? r.kind ?? ''}, en ${r.base_unit ?? ''}`;
  return LINK_REASONS[r.reason ?? ''] ?? r.reason ?? '';
}

let deferredInstall: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event as InstallPromptEvent;
});

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/**
 * Inicio (API.md §9.1; tanda 27, MUELA-032 y 070):
 * - si hay trabajo, la factura que toca, una a una (`createQueue` del kit): «Confirmar y siguiente» solo si está lista
 *   (valida al momento, con «Deshacer», que la devuelve a «Pendiente de revisión»; lo aprendido se queda); si le falta
 *   algo, «Completar en la ficha»;
 * - el recorrido con su cifra: Llegan · Por resolver · Por pagar · Por cobrar · Por repartir · Gestoría;
 * - Herramientas en una fila, cada una con su hoja (Drive, Claude, Inventario, Sincronización, Instalar,
 *   Cuenta), con los mismos permisos y los mismos ids de siempre; sin red, lo que necesita red se apaga con su motivo;
 * - con todo al día, «Todo al día» y tres accesos.
 */
export const mountHome: ViewMount = (ctx) => {
  const { main, client, navigate, logout } = ctx;
  const role = client.bootstrap()?.membership.role ?? 'reader';
  const isOwner = role === 'owner';
  const canEdit = role !== 'reader';
  const name = client.bootstrap()?.profile.displayName;

  // --- Recorrido: las cifras (los ids de siempre en la cifra de cada etapa) -----------------------------------------
  const stagesHost = el('section', { class: 'inv-home-stages', 'data-feedback-id': 'invoices.inicio.recorrido', 'data-feedback-label': 'Recorrido' });
  // --- Lo que toca: la cola ----------------------------------------------------------------------------------------
  const workHost = el('section', { class: 'inv-home-work', id: 'homeWork', 'data-feedback-id': 'invoices.inicio.una_a_una', 'data-feedback-label': 'La factura que toca' });
  let queueIds = '';
  let queue: ReturnType<typeof createQueue> | null = null;

  // --- Herramientas: lo de cada hoja se crea una vez y se pinta siempre (mismos ids) ------------------------------------
  const fromDrive = el('dd', { id: 'statFromDrive' }, '…');
  const driveState = el('p', { class: 'hint', id: 'driveState' });
  // Tanda 31 (MUELA-079): el estado con su medallón y lo que supone, y las cuatro cifras de la vista previa
  const linksState = el('strong', { id: 'resourceLinksState' }, '…');
  const linksMeaning = el('span', { class: 'hint', id: 'resourceLinksMeaning' });
  const linksFigures = el('div', { id: 'resourceLinksFigures', 'data-feedback-ignore': '' });
  const linksSwitch = el('button', { 'data-feedback-id': 'invoices.inicio.inventario.interruptor', 'data-feedback-label': 'Encender o apagar el enlace', class: 'ghost', type: 'button', id: 'resourceLinksSwitch', onclick: () => void switchResourceLinks() }, '…') as HTMLButtonElement;
  const linksPreviewButton = el('button', { 'data-feedback-id': 'invoices.inicio.inventario.vista_previa', 'data-feedback-label': 'Ver la vista previa', class: 'ghost', type: 'button', id: 'resourceLinksPreview', onclick: (e: Event) => void openResourceLinks(e.currentTarget as HTMLButtonElement) }, 'Ver la vista previa');
  const appEntriesHintText = el('span', { id: 'statAppEntries' }, '…');
  const network = el('dd'); const pending = el('dd'); const conflicts = el('dd'); const lastPull = el('dd'); const roleText = el('dd');
  const driveRun = isOwner ? el('button', { 'data-feedback-id': 'invoices.inicio.drive.buscar', 'data-feedback-label': 'Buscar ahora', class: 'ghost', type: 'button', id: 'driveRun', onclick: (e: Event) => void runDrive(e.currentTarget as HTMLButtonElement) }, 'Buscar ahora') : null;
  const driveReread = isOwner ? el('button', { 'data-feedback-id': 'invoices.inicio.drive.releer', 'data-feedback-label': 'Volver a leer las pendientes', class: 'ghost', type: 'button', id: 'driveReread', onclick: (e: Event) => void rereadDrive(e.currentTarget as HTMLButtonElement) }, 'Volver a leer las pendientes') : null;
  const connectButton = isOwner ? el('button', { 'data-feedback-id': 'invoices.inicio.claude.conectar', 'data-feedback-label': 'Conectar Claude', class: 'ghost', type: 'button', id: 'connectClaude', onclick: () => void connectClaude() }, 'Conectar Claude') : null;
  const offline: Array<() => void> = [];
  // El motivo va en un sitio fijo de la hoja: si la red cambia con la hoja cerrada, al abrirla se sigue viendo (tanda 31)
  const needsNetwork = (button: HTMLElement | null, reason: string, host: HTMLElement) => { if (button) offline.push(bindOnline(button, { client, reason, reasonHost: host })); };
  const driveReason = el('div', { class: 'inv-reason' });
  const claudeReason = el('div', { class: 'inv-reason' });
  const linksReason = el('div', { class: 'inv-reason' });
  needsNetwork(driveRun, 'Buscar en Drive necesita conexión.', driveReason);
  needsNetwork(driveReread, 'Volver a leer necesita conexión.', driveReason);
  needsNetwork(connectButton, 'Conectar Claude necesita conexión.', claudeReason);
  needsNetwork(linksPreviewButton, 'La vista previa la calcula el servidor: necesita conexión.', linksReason);

  const toolHint: Record<string, HTMLElement> = {};
  const toolsRow = el('div', { class: 'inv-tools', role: 'group', 'aria-label': 'Herramientas', 'data-feedback-id': 'invoices.inicio.herramientas', 'data-feedback-label': 'Herramientas' });
  function tool(key: string, id: string, label: string, iconName: Parameters<typeof icon>[0], body: () => HTMLElement, mark: { feedbackId: string; feedbackLabel: string }): HTMLElement {
    toolHint[key] = el('span', { class: 'inv-tool-hint' });
    return fb(el('button', { type: 'button', class: 'inv-tool', id, onclick: () => openSheet({ title: label, body: body(), foot: [el('button', { class: 'primary', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')] }) },
      icon(iconName, 20), el('span', { class: 'inv-tool-label' }, label), toolHint[key]), mark);
  }
  const install = () => el('div', null,
    el('p', null, 'Como app instalada se abre a pantalla completa y funciona sin conexión.'),
    deferredInstall
      ? el('p', null, el('button', { 'data-feedback-id': 'invoices.inicio.instalar', 'data-feedback-label': 'Instalar Ikisai Finance', class: 'primary', type: 'button', onclick: async () => { await deferredInstall?.prompt(); deferredInstall = null; await closeSheet(); } }, 'Instalar Ikisai Finance'))
      : el('p', null, 'En Android: menú del navegador → «Instalar aplicación». En iPhone: Compartir → «Añadir a pantalla de inicio».'));
  replace(toolsRow,
    tool('drive', 'toolDrive', 'Google Drive', 'upload', () => el('div', null,
      el('p', null, 'Las facturas que dejas en la carpeta «Entrada» llegan solas cada 15 minutos, leídas si el PDF tiene texto. Revísalas y valídalas.'),
      el('dl', { class: 'kv' }, el('dt', null, 'Por revisar'), fromDrive),
      el('p', { class: 'btnrow' },
        el('button', { 'data-feedback-id': 'invoices.inicio.drive.ver', 'data-feedback-label': 'Ver las de Drive', class: 'ghost', type: 'button', onclick: () => { void closeSheet(); navigate('#/facturas?filtro=drive'); } }, 'Ver las de Drive'),
        driveRun, driveReread),
      driveReason,
      isOwner ? driveState : null), { feedbackId: 'invoices.inicio.drive', feedbackLabel: 'Desde Google Drive' }),
    ...(isOwner ? [tool('claude', 'toolClaude', 'Leer con Claude', 'bot', () => el('div', null,
      el('p', null, 'Una sesión de Claude Code completa las facturas que llegan sin leer (escaneadas o con datos que faltan). Tú las revisas y validas.'),
      el('p', null, connectButton), claudeReason), { feedbackId: 'invoices.inicio.claude', feedbackLabel: 'Leer con Claude' })] : []),
    // R4: el inventario es un ajuste de toda la casa: estado, vista previa y el interruptor con su diálogo (solo el owner)
    ...(isOwner ? [tool('inventory', 'toolInventory', 'Inventario', 'cart', () => el('div', null,
      el('div', { class: 'inv-stocklink-state' }, renderMedal({ icon: 'cart', size: 40 }), el('div', null, linksState, linksMeaning)),
      linksFigures,
      el('p', { class: 'btnrow' }, linksPreviewButton, linksSwitch), linksReason), { feedbackId: 'invoices.inicio.inventario', feedbackLabel: 'Inventario (Recursos)' })] : []),
    // Ingresos y gastos de otras apps (0244): la lista, el resultado por evento y «facturado» con un toque
    fb(el('a', { class: 'inv-tool', id: 'toolAppEntries', href: '#/apuntes', onclick: (e: Event) => { e.preventDefault(); navigate('#/apuntes'); } },
      icon('euro', 20), el('span', { class: 'inv-tool-label' }, 'Ingresos de apps'), el('span', { class: 'inv-tool-hint' }, appEntriesHintText)), { feedbackId: 'invoices.inicio.apuntes', feedbackLabel: 'Ingresos y gastos de apps' }),
    // Cobros de la pasarela que no casan con su factura (API.md §19.7)
    fb(el('a', { class: 'inv-tool', id: 'toolUnmatched', href: '#/cobros-sin-casar', onclick: (e: Event) => { e.preventDefault(); navigate('#/cobros-sin-casar'); } },
      icon('euro', 20), el('span', { class: 'inv-tool-label' }, 'Cobros sin casar'), el('span', { class: 'inv-tool-hint' }, 'Pagos en línea por revisar')), { feedbackId: 'invoices.inicio.cobros_sin_casar', feedbackLabel: 'Cobros sin casar' }),
    tool('sync', 'toolSync', 'Sincronización', 'sync', () => el('div', null,
      el('dl', { class: 'kv' }, el('dt', null, 'Red'), network, el('dt', null, 'Pendientes'), pending, el('dt', null, 'Conflictos y rechazados'), conflicts, el('dt', null, 'Último pull'), lastPull, el('dt', null, 'Rol'), roleText),
      el('p', null, el('button', { 'data-feedback-id': 'invoices.inicio.sincronizacion.ver_conflictos', 'data-feedback-label': 'Ver conflictos', class: 'ghost', type: 'button', onclick: () => { void closeSheet(); navigate('#/conflictos'); } }, 'Ver conflictos'))), { feedbackId: 'invoices.inicio.sincronizacion', feedbackLabel: 'Sincronización' }),
    tool('install', 'toolInstall', 'Instalar', 'download', install, { feedbackId: 'invoices.inicio.instalar_hoja', feedbackLabel: 'Instalar en este dispositivo' }),
    tool('account', 'toolAccount', 'Cuenta', 'user', () => el('div', null,
      el('p', null, name ? `Sesión iniciada como ${name}.` : 'Sesión iniciada.'),
      el('p', null, el('button', { 'data-feedback-id': 'invoices.inicio.cuenta.cerrar_sesion', 'data-feedback-label': 'Cerrar sesión', class: 'ghost', type: 'button', id: 'logoutHome', onclick: () => { void closeSheet(true); void logout(); } }, 'Cerrar sesión'))), { feedbackId: 'invoices.inicio.cuenta', feedbackLabel: 'Cuenta' }),
  );

  function paintStatus(status: SyncStatus): void {
    network.textContent = status.network === 'online' ? 'En línea' : status.network === 'offline' ? 'Sin conexión' : status.network === 'syncing' ? 'Sincronizando…' : 'Error';
    pending.textContent = String(status.pendingCommands + status.pendingBlobs);
    conflicts.textContent = String(status.conflicts + status.rejected);
    lastPull.textContent = formatDate(status.lastPullAt);
    const boot = client.bootstrap();
    roleText.textContent = boot ? { owner: 'Propietario', editor: 'Editor', reader: 'Solo lectura', outsider: 'Outsider' }[boot.membership.role] : '—';
    const problems = status.conflicts + status.rejected;
    if (toolHint.sync) toolHint.sync.textContent = problems ? `${problems} por resolver` : network.textContent;
  }

  /** «Confirmar y siguiente»: valida al momento; «Deshacer» la devuelve a «Pendiente de revisión». */
  async function confirmNext(row: MirrorRow): Promise<void> {
    const ok = await validateNow(ctx, row.invoice.id, null);
    if (!ok) return;
    queue?.done();
    const code = row.invoice.code ?? 'la factura';
    toastWithAction(`${code} validada. «Deshacer» la devuelve a «Pendiente de revisión»; lo aprendido del proveedor se queda.`, {
      label: 'Deshacer',
      onClick: () => void unvalidate(row.invoice.id, code),
    }, 8000);
  }
  async function unvalidate(id: string, code: string): Promise<void> {
    quietOwnMerges();
    try {
      const current = await client.get(INVOICES, id) as { revision: number; status: string } | null;
      if (!current || current.status !== 'validada') { toast(`${code} ya no está validada en este dispositivo.`); return; }
      await client.commit([{ op: 'update', table: INVOICES, id, expectedRevision: current.revision, fields: { status: 'pendiente_revision' } }]);
      queue?.undo();
      toast(`${code} vuelve a estar pendiente de revisión.`);
    } catch (error) { toast(describeError(error)); }
  }

  function queueItem(row: MirrorRow, m: Mirror): QueueItem {
    const supplier = supplierName(m.supplierById.get(row.invoice.supplier_id), 'Proveedor');
    const reason = row.state.caption.split(' · ').slice(1).join(' · ');
    return {
      id: row.invoice.id,
      title: supplier,
      tone: row.state.ready ? 'ok' : row.state.tone,
      toneText: reason ? reason[0]!.toUpperCase() + reason.slice(1) : row.state.caption,
      medal: { name: supplier },
      value: eur(row.invoice.calculated_total),
      // El pago ya va en la etiqueta («Pagada (sin confirmar)», «Vencida…») si pide algo
      facts: [row.invoice.object, row.invoice.invoice_date ? shortDate(row.invoice.invoice_date) : 'Sin fecha', row.invoice.code ?? 'código pendiente', row.state.pay.kind === 'unconfirmed' || row.state.pay.kind === 'overdue' ? '' : row.state.pay.text].filter(Boolean),
      body: readBody(row, m),
    };
  }

  /**
   * «He leído esto» (tanda 30, MUELA-080): la miniatura del documento (se toca para verlo) y lo leído, cada cosa con ✓ o
   * !. Sin leer todavía, lo dice. Las etiquetas siguen debajo (como mucho dos y «+n»).
   */
  function readBody(row: MirrorRow, m: Mirror): HTMLElement {
    const supplier = m.supplierById.get(row.invoice.supplier_id);
    const checks = readChecks(row, !!supplier && supplier.slug !== 'sin_identificar', eur);
    const original = (m.filesByInvoice.get(row.invoice.id) ?? []).filter((f) => f.kind === 'original' && !f.deleted_at).sort((a, b) => a.page_order - b.page_order)[0] ?? null;
    return el('div', { class: 'inv-read' },
      original ? thumbnail(original) : el('div', { class: 'inv-thumb inv-thumb-none', 'aria-hidden': 'true' }, icon('invoice', 22)),
      el('div', { class: 'inv-read-text' },
        checks.length
          ? el('div', null, el('p', { class: 'inv-read-title' }, 'He leído esto'),
            el('ul', { class: 'inv-checks', 'data-feedback-ignore': '' }, ...checks.map((c) => el('li', { class: c.ok ? 'ok' : 'bad', dataset: { check: c.key } },
              el('span', { class: 'inv-check-mark', 'aria-hidden': 'true' }, c.ok ? '✓' : '!'), el('span', null, `${c.label}: ${c.text}`), el('span', { class: 'vh' }, c.ok ? ' (bien)' : ' (revísalo)')))))
          : el('p', { class: 'hint' }, row.invoice.status === 'pendiente_datos' ? (original ? 'Sin leer todavía: léela o rellénala.' : 'Sin leer y sin documento.') : ''),
        row.labels.length ? el('div', { class: 'chips' }, ...chipsWithMore(row.labels)) : null));
  }

  /** La miniatura: la imagen (con red) o el icono del PDF; al tocarla, se abre el documento. */
  function thumbnail(file: { file_id: string; mime_type: string | null; normalized_filename?: string | null }): HTMLElement {
    const isImage = (file.mime_type ?? '').startsWith('image/');
    const button = el('button', { 'data-feedback-id': 'invoices.inicio.cola.documento', 'data-feedback-label': 'Ver el documento', class: 'inv-thumb', type: 'button', 'aria-label': 'Ver el documento',
      onclick: () => void openFile(client, file.file_id).catch((e) => toast(describeError(e))) },
    isImage ? null : el('span', { class: 'inv-thumb-pdf' }, icon('invoice', 22), 'PDF'));
    if (isImage && navigator.onLine) {
      void client.fileUrl(file.file_id).then((url) => { button.append(el('img', { src: url, alt: '', loading: 'lazy' })); }).catch(() => button.append(el('span', { class: 'inv-thumb-pdf' }, icon('invoice', 22))));
    } else if (isImage) button.append(el('span', { class: 'inv-thumb-pdf' }, icon('invoice', 22)));
    return button;
  }

  function paintWork(m: Mirror, rows: MirrorRow[]): void {
    const list = homeQueue(rows);
    const byId = new Map(list.map((r) => [r.invoice.id, r]));
    const items = list.map((r) => queueItem(r, m));
    const ids = items.map((i) => i.id).join(',');
    if (!list.length) {
      queue = null; queueIds = '';
      replace(workHost, el('div', { class: 'card inv-home-done', id: 'homeAllDone' },
        el('h3', null, 'Todo al día'), el('p', null, 'No queda ninguna factura por resolver.'),
        el('p', { class: 'btnrow' },
          // «Nueva factura» ya está en el botón flotante
          el('button', { class: 'ghost', type: 'button', onclick: () => navigate('#/facturas?filtro=activas') }, icon('invoice', 16), 'Ver las facturas'),
          el('button', { class: 'ghost', type: 'button', onclick: () => navigate('#/compras') }, icon('cart', 16), 'Compras'),
          el('button', { class: 'ghost', type: 'button', onclick: () => navigate('#/gestoria') }, icon('briefcase', 16), 'Ir a Gestoría'))));
      return;
    }
    if (queue && ids === queueIds) return;
    if (queue) { queue.setItems(items); queueIds = ids; return; }
    queueIds = ids;
    queue = createQueue({
      label: 'La factura que toca', items, feedbackId: 'invoices.inicio.cola',
      primary: canEdit ? (item) => {
        const row = byIdNow(item.id);
        if (!row) return null;
        // La acción cambia según el caso: confirmar, leer, subir el documento, revisar importes, la categoría…
        const action = homeAction(row);
        return action.kind === 'confirm'
          ? { label: action.label, onClick: () => void confirmNext(row) }
          : { label: action.label, onClick: () => navigate(`#/facturas/${item.id}${action.focus ? `?ir=${action.focus}` : ''}`) };
      } : undefined,
      onOpen: (item) => navigate(`#/facturas/${item.id}`),
      onAll: () => navigate('#/facturas?filtro=por_resolver'),
      readOnlyText: 'Solo lectura: la gestoría ve lo que queda por resolver, sin confirmar.',
      doneTitle: 'Todo al día', doneText: 'Has pasado por todas las facturas por resolver.',
    });
    replace(workHost, queue.element);
    function byIdNow(id: string): MirrorRow | undefined { return currentRows.get(id) ?? byId.get(id); }
  }
  let currentRows = new Map<string, MirrorRow>();
  // «Encendido · 2 por decidir» y las cuatro cifras: la vista previa entera del servidor (solo el owner y con red). Se vuelve
  // a pedir al recuperar la red, tras «Aplicar» y al cambiar el interruptor, para que la pista y las cifras no se queden viejas.
  let linksPreview: ResourceLinksPreview | null = null;
  let linksOnSeen: boolean | null = null;
  function refreshLinksPreview(): void {
    if (!isOwner || !navigator.onLine) return;
    void client.api<ResourceLinksPreview>('/resource-links/preview').then((p) => { linksPreview = p; paintLinks(); }).catch(() => undefined);
  }
  const onBackOnline = () => refreshLinksPreview();
  window.addEventListener('online', onBackOnline);
  window.addEventListener('offline', paintLinks);
  refreshLinksPreview();

  function paintLinks(): void {
    const on = linksEnabled();
    linksState.textContent = on ? 'Encendido' : 'Apagado';
    linksMeaning.textContent = on
      ? 'Las líneas con artículo y sitio de lo que validas entran en el inventario común con la fecha de la factura.'
      : 'Las facturas no entran en el inventario.';
    linksSwitch.textContent = on ? 'Apagar' : 'Encender';
    const undecided = linksPreview?.counts.dudoso ?? 0;
    if (toolHint.inventory) toolHint.inventory.textContent = on ? `Encendido${undecided ? ` · ${undecided} por decidir` : ''}` : 'Apagado';
    // Sin red no hay cifras: salen del servidor
    const c = navigator.onLine ? linksPreview?.counts : null;
    if (!c) { replace(linksFigures); return; }
    const preview = () => void openResourceLinks(linksPreviewButton);
    replace(linksFigures, renderStats([
      { value: c.enlazar, label: 'se enlazan', onClick: preview, feedbackId: 'invoices.inicio.inventario.cifra' },
      { value: c.crear, label: 'se crean', hint: `${c.new_items} artículo${c.new_items === 1 ? '' : 's'} nuevo${c.new_items === 1 ? '' : 's'}`, onClick: preview, feedbackId: 'invoices.inicio.inventario.cifra_crear' },
      { value: c.dudoso, label: 'por decidir', hint: 'en la ficha', tone: c.dudoso ? 'warn' : null, onClick: openUndecided, feedbackId: 'invoices.inicio.inventario.por_decidir' },
      { value: c.omitir, label: 'no son stock', onClick: preview, feedbackId: 'invoices.inicio.inventario.cifra_omitir' },
    ], { label: 'Vista previa del inventario' }));
  }
  /** «Por decidir»: sus líneas, cada una a la ficha de su factura (por código); las de la memoria no tienen factura. */
  function openUndecided(): void {
    const rows = (linksPreview?.rows ?? []).filter((r) => r.action === 'dudoso');
    openSheet({
      title: 'Por decidir en la ficha',
      meta: 'Elige el artículo en la ficha de cada factura, o usa el texto sin artículo.',
      body: rows.length
        ? el('ul', { class: 'plain inv-undecided', id: 'resourceLinksUndecided' }, ...rows.map((r) => el('li', null, r.source === 'line' && r.invoice_code
          ? el('a', { href: `#/facturas/${r.invoice_code}`, 'data-feedback-id': 'invoices.inicio.inventario.por_decidir.ficha', 'data-feedback-label': 'Abrir la ficha', onclick: (e: Event) => { e.preventDefault(); void closeSheet(); navigate(`#/facturas/${r.invoice_code}`); } },
            el('strong', null, r.name), ` · ${r.invoice_code} · ${resourceLinkDetail(r)}`)
          : el('span', null, el('strong', null, r.name), ` · memoria · ${resourceLinkDetail(r)}`))))
        : el('p', null, 'No queda nada por decidir.'),
      foot: [el('button', { class: 'primary', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')],
    });
  }

  async function paintCounts(): Promise<void> {
    const m = await loadMirror(client);
    const today = todayIso();
    const rows = mirrorRows(m, today);
    currentRows = new Map(rows.map((r) => [r.invoice.id, r]));
    const live = rows.filter((r) => r.invoice.status !== 'anulada');
    const arrived = live.filter((r) => r.invoice.status === 'pendiente_datos');
    const review = live.filter((r) => r.invoice.status === 'pendiente_revision');
    const revisar = review.filter((r) => r.invoice.review_reason === 'REVISAR IMPORTES').length;
    const due = live.filter((r) => r.invoice.payment_status === 'pendiente');
    const overdue = due.filter((r) => r.state.pay.kind === 'overdue').length;
    const unconfirmed = live.filter((r) => r.state.pay.kind === 'unconfirmed').length;
    const items = purchaseItems({ invoices: m.invoices, lines: m.lines, suppliers: m.suppliers, allocations: m.allocations }, { unassignedOnly: true });
    const q = fiscalSummary({ invoices: m.invoices, taxLines: m.taxes }, workingQuarter());
    // Por cobrar: la misma función que el buzón de Emitidas y la cifra de Booking (las rectificativas restan)
    const { count: toCollect, amount: owed, old, unsent } = receivable(await client.list(ISSUED_INVOICES) as unknown as IssuedWork[], today);
    const sum = (list: MirrorRow[]) => eur(list.reduce((s, r) => s + cents(r.invoice.calculated_total), 0) / 100);
    replace(stagesHost, el('h3', { class: 'sectionlabel' }, 'Recorrido'), renderStats([
      { value: arrived.length, label: 'Llegan', hint: arrived.length ? 'sin datos: léelas' : 'ninguna sin leer', tone: arrived.length ? 'warn' : null, onClick: () => navigate('#/facturas?filtro=pendiente_datos'), feedbackId: 'invoices.inicio.pendientes_datos' },
      { value: review.length, label: 'Por resolver', hint: revisar ? `${revisar} con importes por revisar` : review.length ? sum(review) : 'nada por revisar', tone: revisar ? 'alert' : review.length ? 'warn' : null, onClick: () => navigate('#/facturas?filtro=pendiente_revision'), feedbackId: 'invoices.inicio.pendientes_revision' },
      { value: due.length, label: 'Por pagar', hint: [overdue ? `${overdue} vencida${overdue === 1 ? '' : 's'}` : null, unconfirmed ? `${unconfirmed} pago${unconfirmed === 1 ? '' : 's'} por confirmar` : null].filter(Boolean).join(' · ') || sum(due), tone: overdue ? 'alert' : unconfirmed ? 'warn' : null, onClick: () => navigate('#/facturas?filtro=sin_pagar'), feedbackId: 'invoices.inicio.sin_pagar' },
      { value: toCollect, label: 'Por cobrar', hint: [owed > 0 ? eur(owed) : null, old ? `${old} de más de ${OLD_DAYS} días` : null, unsent ? `${unsent} sin enviar` : null].filter(Boolean).join(' · ') || 'nada por cobrar', tone: old ? 'alert' : unsent ? 'warn' : null, onClick: () => navigate('#/facturas?vista=emitidas'), feedbackId: 'invoices.inicio.por_cobrar' },
      { value: items.items.length, label: 'Por repartir', hint: items.items.length ? eur(items.total_unallocated) : 'todo asignado', tone: items.items.length ? 'warn' : null, onClick: () => navigate('#/compras'), feedbackId: 'invoices.inicio.sin_asignar' },
      { value: q.invoices.validada + q.invoices.archivada, label: 'Gestoría', hint: `${rangeLabel(workingQuarter())}: validadas`, onClick: () => navigate('#/gestoria'), feedbackId: 'invoices.inicio.trimestre' },
    ], { label: 'Recorrido de tus facturas' }));
    // Los ids de siempre, en la cifra de cada etapa
    const values = stagesHost.querySelectorAll<HTMLElement>('.stat-value');
    ['statPendingData', 'statPendingReview', 'statUnpaid', 'statToCollect', 'statUnassigned', 'statQuarterCount'].forEach((id, i) => { if (values[i]) values[i]!.id = id; });
    // El trimestre en el que se trabaja, con sus cifras (las de la tarjeta Trimestre de antes; el detalle, en Gestoría)
    stagesHost.append(el('p', { class: 'hint inv-home-quarter', id: 'homeQuarter', 'data-feedback-ignore': '' },
      `${rangeLabel(workingQuarter())}, solo lo validado: base ${eur(q.base)} · IVA soportado ${eur(q.vat)} · ${q.invoices.validada + q.invoices.archivada === 1 ? '1 factura' : `${q.invoices.validada + q.invoices.archivada} facturas`}.`));
    // Herramientas
    const drive = live.filter((r) => r.invoice.drive_file_id && (r.invoice.status === 'pendiente_datos' || r.invoice.status === 'pendiente_revision'));
    fromDrive.textContent = drive.length ? `${drive.length} (${drive.filter((r) => r.invoice.status === 'pendiente_datos').length} sin leer)` : '0';
    if (toolHint.drive) toolHint.drive.textContent = drive.length ? `${drive.length} por revisar` : 'Al día';
    void appEntriesHint(client).then((text) => { appEntriesHintText.textContent = text; }).catch(() => undefined);
    // El interruptor ha cambiado (aquí o en otro dispositivo): la vista previa se vuelve a pedir
    const on = linksEnabled();
    if (linksOnSeen !== null && linksOnSeen !== on) refreshLinksPreview();
    linksOnSeen = on;
    paintLinks();
    paintWork(m, rows);
  }

  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, name ? `Hola, ${name}` : 'Inicio'), el('p', null, 'Facturas de compra: documento, datos, revisión, asignación y gestoría. Todo funciona sin conexión.'))),
    workHost,
    stagesHost,
    el('section', { class: 'inv-home-tools' }, el('h3', { class: 'sectionlabel' }, 'Herramientas'), toolsRow),
    el('button', { 'data-feedback-id': 'invoices.inicio.nueva_factura', 'data-feedback-label': 'Nueva factura', class: 'fab', type: 'button', id: 'homeNewInvoice', hidden: !canEdit, onclick: () => navigate('#/facturas/nueva') }, icon('plus'), 'Nueva factura'),
  );

  /**
   * Clave de agente para una sesión de Claude Code (§15.1): editor en Finance, nunca owner. Se muestra una sola vez con el
   * comando para conectarla; se revoca en Central › Accesos › Agentes.
   */
  async function connectClaude(): Promise<void> {
    if (!navigator.onLine) { toast('Conectar Claude necesita conexión.'); return; }
    const ok = await confirmDialog({ title: '¿Crear una clave para Claude?', text: 'Claude podrá leer y completar facturas (nunca validarlas). La clave se muestra una sola vez; puedes revocarla en Central › Accesos › Agentes.', confirmLabel: 'Crear clave' });
    if (!ok) return;
    try {
      const issued = await client.api<{ token: string }>('/agents', { json: { name: 'Claude · lectura de facturas', role: 'editor' } });
      const command = `claude mcp add --transport http ikisai-finance ${location.origin}/api/v1/mcp --header "Authorization: Bearer ${issued.token}"`;
      const box = el('textarea', { ...fieldAttrs({ id: 'invoices.inicio.claude.comando', storage: 'none', label: 'Comando para conectar Claude', type: 'text', sensitivity: 'sensitive', confirm: 'none' }), 'data-feedback-ignore': '', readonly: true, rows: '4', id: 'claudeCommand', style: 'width:100%;font-family:monospace' });
      box.value = command;
      openSheet({
        title: 'Conectar Claude',
        body: el('div', null,
          el('p', null, '1. En el ordenador, abre una terminal y pega este comando (una sola vez):'), box,
          el('p', { class: 'btnrow' }, el('button', { class: 'softbtn small', type: 'button', onclick: () => void navigator.clipboard.writeText(command).then(() => toast('Comando copiado.')) }, 'Copiar comando')),
          el('p', null, '2. Abre Claude Code y escribe: «Lee las facturas pendientes de Drive en Ikisai Finance y complétalas».'),
          el('p', { class: 'hint' }, 'Esta clave no se vuelve a mostrar. Guárdala solo en el comando; si la pierdes, crea otra y revoca esta en Central.')),
        foot: [el('button', { class: 'primary', type: 'button', onclick: () => void closeSheet() }, 'Hecho')],
      });
    } catch (error) { toast(describeError(error)); }
  }

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
  /** Vuelve a leer en el servidor los borradores de Drive que siguen sin datos, con el lector actual (owner). */
  async function rereadDrive(button: HTMLButtonElement): Promise<void> {
    if (!navigator.onLine) { toast('Volver a leer necesita conexión.'); return; }
    button.disabled = true;
    try {
      const r = await client.api<{ checked: number; read: number; items: Array<{ code: string | null; read: boolean; detail: string }> }>('/drive/reread', { json: {} });
      if (!r.checked) toast('No hay facturas de Drive pendientes de datos.');
      else openSheet({
        title: 'Volver a leer',
        meta: `${r.read} de ${r.checked} leída${r.read === 1 ? '' : 's'}. Las demás se completan con Claude o la IA.`,
        body: el('ul', { id: 'rereadResult', 'data-feedback-ignore': '' }, ...r.items.map((i) => el('li', null, el('strong', null, i.code ?? 'factura'), ` · ${i.detail}`))),
        foot: [el('button', { class: 'primary', type: 'button', onclick: () => void closeSheet() }, 'Hecho')],
      });
      void client.sync().catch(() => undefined);
    } catch (error) {
      // Que el fallo se vea (9-10-2026): una hoja con el motivo, no un aviso que se pierde.
      openSheet({ title: 'No se pudo volver a leer', body: el('p', { id: 'rereadError', role: 'alert' }, describeError(error)), foot: [el('button', { class: 'primary', type: 'button', onclick: () => void closeSheet() }, 'Cerrar')] });
    }
    button.disabled = false;
  }
  /** R4, PR 4: vista previa del enlace con Recursos (owner) y «Aplicar» con el mismo `digest`. No enciende el interruptor. */
  async function openResourceLinks(button: HTMLButtonElement): Promise<void> {
    if (!navigator.onLine) { toast('La vista previa necesita conexión.'); return; }
    button.disabled = true;
    try {
      const preview = await client.api<ResourceLinksPreview>('/resource-links/preview');
      const spaces = await client.api<{ tables: Array<{ rows: Array<{ id: string; name: string; kind: string; deleted_at: string | null; active: boolean }> }> }>('/resources/snapshot?tables=resources.spaces')
        .then((r) => (r.tables[0]?.rows ?? []).filter((x) => !x.deleted_at && x.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'es')))
        .catch(() => []);
      linksPreview = preview; paintLinks();
      const c = preview.counts;
      const space = el('select', { ...fieldAttrs({ id: 'invoices.inicio.inventario.sitio', label: 'Sitio habitual', type: 'select', sensitivity: 'internal', confirm: 'none' }), id: 'resourceLinksSpace' },
        el('option', { value: '' }, 'Sin sitio (no entran al inventario)'), ...spaces.map((x) => el('option', { value: x.id }, x.name)));
      const group = (action: ResourceLinkRow['action'], title: string) => {
        const rows = preview.rows.filter((r) => r.action === action);
        return rows.length ? el('section', { 'data-feedback-ignore': '' }, el('div', { class: 'sectionlabel' }, `${title} · ${rows.length}`),
          el('ul', { class: 'plain', id: `resourceLinks-${action}` }, ...rows.map((r) => el('li', null, el('strong', null, r.name),
            r.source === 'memory' ? ' · memoria' : r.invoice_code ? ` · ${r.invoice_code}` : '',
            ` · ${resourceLinkDetail(r)}`)))) : null;
      };
      const apply = el('button', { 'data-feedback-id': 'invoices.inicio.inventario.aplicar', 'data-feedback-label': 'Aplicar', class: 'primary', type: 'button', id: 'resourceLinksApply', disabled: !(c.crear + c.enlazar) }, 'Aplicar');
      apply.addEventListener('click', async () => {
        apply.disabled = true;
        try {
          const r = await client.api<{ created: number; linked: number; memory: number }>('/resource-links/apply', { json: { digest: preview.digest, space_id: space.value || null } });
          await closeSheet();
          toast(`Recursos: ${r.created} artículo${r.created === 1 ? '' : 's'} nuevo${r.created === 1 ? '' : 's'}, ${r.linked} línea${r.linked === 1 ? '' : 's'} y ${r.memory} nombre${r.memory === 1 ? '' : 's'} de la memoria enlazados.`);
          refreshLinksPreview();
          void client.sync().catch(() => undefined);
        } catch (error) { toast(describeError(error)); apply.disabled = false; }
      });
      openSheet({
        title: 'Inventario (Recursos)',
        meta: `${c.lines} línea${c.lines === 1 ? '' : 's'} validada${c.lines === 1 ? '' : 's'} y ${c.memory} nombre${c.memory === 1 ? '' : 's'} de la memoria sin artículo.`,
        body: el('div', { id: 'resourceLinksBody' },
          el('dl', { class: 'kv', id: 'resourceLinksCounts' }, el('dt', null, 'Se enlazan'), el('dd', null, String(c.enlazar)), el('dt', null, 'Artículos nuevos'), el('dd', null, `${c.new_items} (para ${c.crear})`),
            el('dt', null, 'Por decidir'), el('dd', null, String(c.dudoso)), el('dt', null, 'No son stock'), el('dd', null, String(c.omitir))),
          group('enlazar', 'Se enlazan'), group('crear', 'Se crean'), group('dudoso', 'Por decidir en la ficha'), group('omitir', 'No son stock'),
          el('label', { class: 'field' }, el('span', null, 'Sitio habitual de los artículos nuevos'), space,
            el('span', { class: 'hint' }, 'Al encender el enlace con el inventario, lo ya validado entra con la fecha de cada factura. Sin sitio, no entra.')),
        ),
        foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), apply],
      });
    } catch (error) { toast(describeError(error)); }
    button.disabled = false;
  }
  /**
   * R4, PR 5: encender o apagar el enlace con el inventario (`invoices.settings.resources_links`, solo el owner). Al
   * encenderlo, la Edge cuadra todo lo enlazado: lo ya validado entra con la fecha de cada factura, sin contar dos veces lo
   * que ya entró por Food o por una compra recibida en Tasks. Apagarlo no quita lo que ya entró.
   */
  async function switchResourceLinks(): Promise<void> {
    const on = !linksEnabled();
    const ok = await confirmDialog(on
      ? { title: 'Encender el enlace con el inventario', confirmLabel: 'Encender',
          text: 'Las líneas enlazadas de las facturas validadas entran en el inventario con la fecha de cada factura. Lo que ya entró desde la compra de Food o al recibir una compra en Tasks no se cuenta dos veces. Antes conviene aplicar la vista previa.' }
      : { title: 'Apagar el enlace con el inventario', confirmLabel: 'Apagar', danger: true,
          text: 'Las facturas que valides dejan de entrar en el inventario y la app vuelve a verse como antes. Mientras esté apagado, ni las compras que se reciban en Tasks ni las facturas que anules o rectifiques se cuadran con el inventario, y una compra puede contarse dos veces. Al volver a encenderlo, todo se cuadra. Lo que ya entró se queda.' });
    if (!ok) return;
    const current = (await client.list(SETTINGS)).find((x) => !x.deleted_at && x.key === 'resources_links');
    linksSwitch.disabled = true;
    await commitSafely(client, [current
      ? { op: 'update', table: SETTINGS, id: current.id, expectedRevision: current.revision, fields: { value: on } }
      : { op: 'insert', table: SETTINGS, id: crypto.randomUUID(), fields: { key: 'resources_links', value: on } }],
    on ? 'Enlace con el inventario encendido.' : 'Enlace con el inventario apagado.');
    linksSwitch.disabled = false;
    refreshLinksPreview();
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
  return () => { offStatus(); offTables(); offline.forEach((off) => off()); window.removeEventListener('online', onBackOnline); window.removeEventListener('offline', paintLinks); };
};
