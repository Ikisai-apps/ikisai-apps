import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, fieldAttrs, openSheet, replace, toast } from '@ikisai/ui-kit';
import { formatEuros, SETTLE_METHOD_LABELS, type SettleMethod } from '@ikisai/domain-flow';
import { flowActions, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { accountTotals, watchData, type Account, type FlowData } from '../app/data.ts';
import { busyButton } from './sheets-common.ts';

/**
 * Cuentas del cliente (0910, v2): se abren a nombre de alguien o de un número de cliente, los pedidos se cargan «a cuenta»
 * desde su ficha y se liquidan con un pago único (efectivo, Bizum o tarjeta). Liquida el owner o quien la abrió.
 */

/** Hoja «Cuentas» de la caja: las abiertas con lo que llevan, abrir una nueva y liquidar. */
export function openAccountsSheet(client: SyncClient, projectId: string): void {
  const actions = flowActions(client);
  const me = client.bootstrap()?.profile.userId ?? null;
  const isOwner = client.bootstrap()?.membership.role === 'owner';
  let data: FlowData | null = null;
  const list = el('div', { class: 'accounts-list', role: 'list' });
  // Al escribir, sugiere la gente que ya conocemos: titulares de cuentas anteriores y clientes con nombre (VG, 28-10).
  const people = el('datalist', { id: 'flow-cuentas-gente' });
  const holder = el('input', { ...fieldAttrs({ id: 'flow.cuentas.titular', entity: 'flow.accounts', prop: 'holder', type: 'text' }), type: 'text', maxlength: '80', placeholder: 'A nombre de (escribe o elige)', 'aria-label': 'A nombre de', autocomplete: 'off', list: 'flow-cuentas-gente' }) as HTMLInputElement;
  const number = el('input', { ...fieldAttrs({ id: 'flow.cuentas.numero_cliente', entity: 'flow.customers', prop: 'number', type: 'text' }), type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Nº de cliente (opcional)', 'aria-label': 'Número de cliente', autocomplete: 'off' });
  const openButton = busyButton({ class: 'primary' }, 'Abrir cuenta', async () => {
    if (!isOnline(client)) { toast('Abrir una cuenta necesita conexión.'); return; }
    const customer = number.value.replace(/\D/g, '');
    if (!holder.value.trim() && !customer) { toast('Pon a nombre de quién o su número de cliente.'); return; }
    if (central && !central.includes(holder.value.trim())) { toast('Las cuentas son para personas de Central: elige un nombre de la lista.'); return; }
    try {
      const out = await actions.openAccount(projectId, holder.value.trim(), customer || null);
      holder.value = ''; number.value = '';
      toast(`Cuenta abierta: ${out.holder}.`);
    } catch (error) { toast(describeError(error)); }
  });
  const sheet = openSheet({ title: 'Cuentas', meta: 'Lo cargado a cuenta se cobra al liquidarla, en un solo pago.',
    body: el('div', { class: 'accounts-sheet' }, el('div', { class: 'accounts-new' }, holder, people, number, openButton), list),
    onClose: () => off() });

  /** Nombre → número de cliente, para rellenarlo solo al elegir a alguien de la lista. */
  let numberOf = new Map<string, number>();
  holder.addEventListener('input', () => { const n = numberOf.get(holder.value.trim()); if (n && !number.value) number.value = String(n); });
  /** Personas de Central (VG, 28-10: las cuentas solo a su nombre). null mientras no se puedan leer. */
  let central: string[] | null = null;
  void client.api<{ rows: Array<{ name: string }> }>('/read/central.people_options?limit=1000')
    .then((r) => { central = [...new Set((r.rows ?? []).map((x) => x.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')); if (data) paintPeople(data); })
    .catch(() => { central = null; });
  function paintPeople(d: FlowData): void {
    if (central) { replace(people, ...central.map((n) => el('option', { value: n }))); holder.placeholder = 'A nombre de (elige de Central)'; return; }
    numberOf = new Map();
    for (const c of d.customers.values()) if (c.display_name) numberOf.set(c.display_name, c.number);
    for (const a of d.accounts) { const c = a.customer_id ? d.customers.get(a.customer_id) : undefined; if (c && !numberOf.has(a.holder)) numberOf.set(a.holder, c.number); }
    const names = [...new Set([...d.accounts.map((a) => a.holder), ...[...d.customers.values()].map((c) => c.display_name ?? '')].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    replace(people, ...names.map((n) => el('option', { value: n }, numberOf.get(n) ? `nº ${numberOf.get(n)}` : '')));
  }

  function paint(): void {
    if (!data) return;
    paintPeople(data);
    const totals = accountTotals(data);
    const open = data.accounts.filter((a) => a.status === 'open').sort((a, b) => a.holder.localeCompare(b.holder, 'es'));
    if (!open.length) { replace(list, el('p', { class: 'muted' }, 'No hay cuentas abiertas.')); return; }
    replace(list, ...open.map((a) => {
      const t = totals.get(a.id) ?? { orders: 0, cents: 0 };
      const canSettle = isOwner || a.opened_by === me;
      return el('div', { class: 'qcard account-card', role: 'listitem' },
        el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }, accountLabel(data!, a)),
          el('small', { class: 'qcard-sub muted' }, `${t.orders} ${t.orders === 1 ? 'pedido' : 'pedidos'} · ${formatEuros(t.cents)}`)),
        canSettle ? busyButton({ class: 'ghost' }, 'Liquidar', () => settle(a, t.cents)) : el('small', { class: 'muted' }, 'La liquida quien la abrió'));
    }));
  }

  async function settle(a: Account, cents: number): Promise<void> {
    const method = await chooseSettleMethod(a.holder, cents);
    if (!method) return;
    if (!isOnline(client)) { toast('Liquidar necesita conexión.'); return; }
    try {
      const out = await actions.settleAccount(a.id, method, a.revision);
      toast(`Cuenta de ${a.holder} liquidada: ${formatEuros(out.total_cents)} (${SETTLE_METHOD_LABELS[method].toLowerCase()}).`);
    } catch (error) { toast(describeError(error)); }
  }

  const off = watchData(client, (d) => { data = d; if (!d.accountsEnabled) sheet.close(); else paint(); }, projectId);
}

/** «Nombre · cliente 142» o solo el nombre. */
export function accountLabel(data: FlowData, a: Account): string {
  const n = a.customer_id ? data.customers.get(a.customer_id)?.number : null;
  return n && !a.holder.endsWith(String(n)) ? `${a.holder} · cliente ${n}` : a.holder;
}

/** Cómo se paga la cuenta. `null` si se cancela. */
function chooseSettleMethod(holder: string, cents: number): Promise<SettleMethod | null> {
  return new Promise((resolve) => {
    let chosen: SettleMethod | null = null;
    const pick = (m: SettleMethod) => el('button', { type: 'button', class: 'primary', 'data-method': m, onclick: () => { chosen = m; sheet.close(); } }, SETTLE_METHOD_LABELS[m]);
    const sheet = openSheet({ title: `Liquidar: ${holder}`, meta: `Total ${formatEuros(cents)}, en un solo pago.`, onClose: () => resolve(chosen),
      body: el('div', { class: 'flow-actions' }, pick('cash'), pick('bizum'), pick('card')) });
  });
}

/**
 * «A cuenta» desde la ficha de un pedido abierto: elegir una cuenta abierta (primero la de su cliente) o abrir una nueva.
 * Devuelve el id de la cuenta, o `null` si se cancela.
 */
export async function chooseAccount(client: SyncClient, data: FlowData, customerId: string | null): Promise<string | null> {
  const open = data.accounts.filter((a) => a.status === 'open')
    .sort((a, b) => Number(b.customer_id === customerId && !!customerId) - Number(a.customer_id === customerId && !!customerId) || a.holder.localeCompare(b.holder, 'es'));
  const picked = await new Promise<string | 'new' | null>((resolve) => {
    let chosen: string | 'new' | null = null;
    const sheet = openSheet({ title: 'Cargar a cuenta', onClose: () => resolve(chosen),
      body: el('div', { class: 'flow-pick' },
        ...open.map((a) => el('button', { type: 'button', class: 'ghost', onclick: () => { chosen = a.id; sheet.close(); } }, accountLabel(data, a))),
        el('button', { type: 'button', class: 'ghost', onclick: () => { chosen = 'new'; sheet.close(); } }, 'Abrir cuenta nueva…')) });
  });
  if (picked !== 'new') return picked;
  const customer = customerId ? data.customers.get(customerId) ?? null : null;
  const input = el('input', { ...fieldAttrs({ id: 'flow.cliente.nombre', entity: 'flow.customers', prop: 'display_name', type: 'text' }), type: 'text', maxlength: '80', placeholder: 'A nombre de', 'aria-label': 'A nombre de', value: customer?.display_name ?? '' });
  const ok = await confirmDialog({ title: 'Abrir cuenta', text: customer ? `Del cliente ${customer.number}.` : 'A nombre de quien paga al final.', body: input, confirmLabel: 'Abrir y cargar' });
  if (!ok) return null;
  if (!input.value.trim() && !customer) { toast('Pon a nombre de quién.'); return null; }
  try {
    const out = await flowActions(client).openAccount(data.project!.id, input.value.trim(), customer ? String(customer.number) : null);
    return out.account_id;
  } catch (error) { toast(describeError(error)); return null; }
}
