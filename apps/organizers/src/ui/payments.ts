/**
 * Pagos y facturas (fase 3, API.md §13.3; Finance F1 y F2). Lo pagado sale **solo de Finance**: lo facturado, lo
 * cobrado y lo pendiente, y cada factura con su estado. La factura emitida desde Finance se pinta desde su copia
 * congelada con la página imprimible del kit (imprimir o guardar en PDF). Una factura antigua que solo tiene su PDF
 * guardado aún no se puede abrir desde el portal: «Pide esta factura a Ikisai», con el contacto público.
 * Lo contratado (total, señal y vencimientos) llegará de Booking; con ello se mostrará el saldo.
 */
import { createPrintView, el, openSheet, replace, toast } from '@ikisai/ui-kit';
import type { IssuedAddress, IssuedDocument, IssuerSnapshot } from '../../../../supabase/functions/_domain/invoices/issued.ts';
import type { Contract, PortalInvoice, PortalMoney } from '../app/api.ts';
import { balanceOf } from '../app/quote.ts';
import { describeError } from '../app/client.ts';
import { commonText, contactLine, textParagraphs } from '../app/common-texts.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { dayLabel } from '../app/labels.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

const money = (n: number | string) => i18n.formatMoney(Number(n));
const PURPOSES: Record<string, string> = { senal: L('Señal'), saldo: L('Saldo'), extras: L('Extras') };
const PAYMENT_TYPES: Record<string, string> = { efectivo: L('Efectivo'), tarjeta: L('Tarjeta'), transferencia: L('Transferencia'), plataforma_pago: L('Plataforma de pago'), otro: L('Otra') };

/** Rótulo del concepto del cobro: «Señal», «Saldo» o «Extras»; sin rótulo para `general` o vacío. */
const purposeChip = (purpose: string | null | undefined) => {
  const label = purpose ? PURPOSES[purpose] : undefined;
  return label ? el('span', { class: 'chip small orgpurpose' }, t(label)) : null;
};
const issueDay = (date: string) => dayLabel(`${date.slice(0, 10)}T12:00:00Z`);

export function renderPayments(ctx: ViewContext, reservationId: string, contract: Contract | null): HTMLElement {
  const host = el('div', { id: 'payments', 'data-feedback-id': 'organizers.pagos', 'data-feedback-label': 'Pagos y facturas' }, loading());
  let alive = true;

  async function load(): Promise<void> {
    try {
      const out = await ctx.api.money(reservationId);
      if (!alive) return;
      paint(out.value, out.stale ? out.at : null);
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }

  async function open(invoice: PortalInvoice): Promise<void> {
    if (!invoice.has_document) { askIkisai(invoice); return; }
    try {
      const out = await ctx.usage.run('organizers.pagos.factura.ver', () => ctx.api.invoiceDocument(reservationId, invoice.id));
      if (out.value.document) openDocument(out.value.document);
      else askIkisai(invoice);
    } catch (error) {
      toast(describeError(error));
    }
  }

  function askIkisai(invoice: PortalInvoice): void {
    openSheet({
      title: t('Factura {numero}', { numero: invoice.number }),
      body: el('div', { id: 'askInvoice' },
        el('p', null, t('Esta factura se hizo con otra herramienta y aún no se puede abrir desde aquí. Pídenosla y te la enviamos.')),
        el('p', { class: 'muted' }, contactLine())),
    });
  }

  function paint(m: PortalMoney, staleAt: string | null): void {
    const totals = m.totals;
    const list = m.invoices.length
      ? el('div', { class: 'list', role: 'list', 'aria-label': t('Facturas') }, ...m.invoices.map((inv) => fbMark(el('button', {
        type: 'button', class: 'orginvoice', 'data-invoice': inv.id, onclick: () => void open(inv),
      },
      el('span', { class: 'orginvoice-main' },
        el('strong', null, inv.type.startsWith('R') ? t('Rectificativa {numero}', { numero: inv.number }) : t('Factura {numero}', { numero: inv.number })),
        el('span', { class: 'muted small' }, purposeChip(inv.purpose), ' ', issueDay(inv.issue_date), inv.rectifies?.length ? ` · ${t('rectifica {numeros}', { numeros: inv.rectifies.join(', ') })}` : '')),
      el('span', { class: 'orginvoice-side' },
        el('strong', null, money(inv.total)),
        el('span', { class: `chip small ${inv.collected ? 'ok' : 'warn'}` }, inv.collected ? t('Cobrada') : t('Pendiente')))),
      'organizers.pagos.factura.abrir', 'Abrir factura')))
      : el('p', { class: 'muted', id: 'noInvoices' }, t('Aún no hay facturas de este retiro.'));
    const instructions = commonText('payment.instructions');
    const b = contract ? balanceOf(contract, Number(totals.collected) || 0) : null;
    const contracted = contract && b
      ? section(t('Lo contratado'), { id: 'moneyContract' },
        el('dl', { class: 'kv orgtotals' },
          el('dt', null, t('Total contratado')), el('dd', { id: 'contractTotal' }, money(b.contracted)),
          el('dt', null, t('Pagado')), el('dd', { id: 'contractPaid' }, money(b.collected)),
          el('dt', null, t('Saldo pendiente')), el('dd', { id: 'contractBalance', class: b.balance > 0 ? 'warn-text' : '' }, el('strong', null, money(b.balance))),
          contract.payment_type ? el('dt', null, t('Forma de pago acordada')) : null,
          contract.payment_type ? el('dd', null, t(PAYMENT_TYPES[contract.payment_type] ?? contract.payment_type)) : null),
        el('h4', null, t('Vencimientos')),
        el('ul', { class: 'plainlist orgdue', id: 'contractDue' }, ...b.due.map((d) => el('li', { 'data-kind': d.kind },
          el('strong', null, d.kind === 'senal' ? t('Señal') : t('Saldo')), ` · ${money(d.amount)}`,
          d.date ? ` · ${t('antes del {fecha}', { fecha: issueDay(d.date) })}` : '', ' ',
          el('span', { class: `chip small ${d.paid ? 'ok' : 'warn'}` }, d.paid ? t('Pagado') : t('Pendiente')),
          // Decisión del usuario (8-10-2026): el saldo vence 24 horas después de terminar el evento.
          d.kind === 'saldo' ? el('div', { class: 'muted small' }, t('en las 24 horas siguientes al final del retiro')) : null))),
        el('p', { class: 'muted small' }, t('Según la propuesta aceptada (versión {n}). Lo pagado sale de las facturas cobradas.', { n: contract.proposal_version })))
      : el('p', { class: 'muted', id: 'noContract' }, t('Cuando el equipo de Ikisai cierre la propuesta contigo, verás aquí lo contratado, la señal y los vencimientos.'));
    replace(host,
      staleAt ? staleNote(staleAt) : null,
      contracted,
      section(t('Facturación'), { id: 'moneyTotals' },
        el('dl', { class: 'kv orgtotals' },
          el('dt', null, t('Facturado')), el('dd', { id: 'moneyInvoiced' }, money(totals.invoiced)),
          el('dt', null, t('Cobrado')), el('dd', { id: 'moneyCollected' }, money(totals.collected)),
          el('dt', null, t('Pendiente de pago')), el('dd', { id: 'moneyPending', class: Number(totals.pending) > 0 ? 'warn-text' : '' }, money(totals.pending))),
        el('p', { class: 'muted small' }, t('Lo cobrado lo registra el equipo de Ikisai al recibir cada pago.'))),
      section(t('Facturas'), { id: 'moneyInvoices' }, list),
      section(instructions.title ?? t('Cómo pagar'), { id: 'paymentInstructions', 'data-feedback-ignore': '' }, ...textParagraphs(instructions.body)));
  }

  void load();
  (host as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; };
  return host;
}

// --- Factura imprimible (copia congelada de Finance) ----------------------------------------------------------------
// La factura es un documento fiscal: se pinta tal como se emitió, en español, sea cual sea el idioma de la pantalla.

const eur = (n: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)).replace('.', ','));
const shortDate = (d: string) => d.slice(0, 10).split('-').reverse().join('/');
const addressText = (a: IssuedAddress | null | undefined) => (a ? [a.line, [a.postal_code, a.city].filter(Boolean).join(' '), a.province, a.country && a.country !== 'ES' ? a.country : null].filter(Boolean).join(', ') : '');
function issuerLines(e: IssuerSnapshot): string[] {
  return [e.trade_name && e.trade_name !== e.legal_name ? `${e.legal_name} (${e.trade_name})` : e.legal_name, `NIF ${e.tax_id}`,
    [e.address_line, [e.postal_code, e.city].filter(Boolean).join(' '), e.province, e.country !== 'ES' ? e.country : null].filter(Boolean).join(', '),
    [e.email, e.phone, e.website].filter(Boolean).join(' · ')].filter(Boolean);
}
const TYPE: Record<string, string> = {
  F1: 'Completa', F2: 'Simplificada (ticket)', F3: 'Sustitutiva de simplificadas', R1: 'Rectificativa (error fundado en derecho)',
  R2: 'Rectificativa (concurso de acreedores)', R3: 'Rectificativa (créditos incobrables)', R4: 'Rectificativa (resto de causas)', R5: 'Rectificativa de simplificada',
};

export function openDocument(doc: IssuedDocument): void {
  const r = doc.recipient;
  const rectified = (doc.rectification?.rectified ?? []) as Array<{ full_number?: string; number?: string; issue_date?: string }>;
  const body = el('div', { class: 'orginvoice-print' },
    el('div', { class: 'orginvoice-parties' },
      el('div', { id: 'docIssuer' }, el('small', null, 'Emisor'), ...issuerLines(doc.issuer).map((l, i) => (i === 0 ? el('strong', null, l) : el('div', null, l)))),
      el('div', { id: 'docRecipient' }, el('small', null, 'Destinatario'), el('strong', null, r.name ?? 'Sin destinatario'),
        r.tax_id ? el('div', null, `NIF ${r.tax_id}`) : null, addressText(r.address) ? el('div', null, addressText(r.address)) : null)),
    doc.rectification ? el('p', { id: 'docRectification' }, `Factura rectificativa ${doc.rectification.kind === 'S' ? 'por sustitución' : 'por diferencias'} de `
      + `${rectified.map((x) => `${x.full_number ?? x.number}${x.issue_date ? ` (${shortDate(x.issue_date)})` : ''}`).join(', ')}. Motivo: ${doc.rectification.reason ?? ''}.`) : null,
    el('p', null, doc.description),
    el('table', { class: 'orgquote orginvoice-lines', id: 'docLines' },
      el('thead', null, el('tr', null, el('th', null, 'Concepto'), el('th', { class: 'num' }, 'Cant.'), el('th', { class: 'num' }, 'Precio'), el('th', { class: 'num' }, 'Base'), el('th', { class: 'num' }, 'IVA'))),
      el('tbody', null, ...doc.lines.map((l) => el('tr', null, el('td', null, l.description), el('td', { class: 'num' }, num(l.quantity)),
        el('td', { class: 'num' }, l.unit_price === null ? '' : eur(l.unit_price)), el('td', { class: 'num' }, eur(l.net_amount)),
        el('td', { class: 'num' }, l.vat_rate === null ? '—' : `${num(l.vat_rate)} %`))))),
    el('table', { class: 'orgquote', id: 'docBreakdown' },
      el('thead', null, el('tr', null, el('th', null, 'Impuesto'), el('th', { class: 'num' }, 'Base imponible'), el('th', { class: 'num' }, 'Cuota'))),
      el('tbody', null, ...doc.breakdown.map((b) => el('tr', null,
        el('td', null, b.exemption ? `${b.tax.toUpperCase()} exento (${b.exemption})` : `${b.tax.toUpperCase()} ${num(b.rate)} %`),
        el('td', { class: 'num' }, eur(b.base)), el('td', { class: 'num' }, eur(b.quota)))))),
    el('dl', { class: 'kv orgtotals', id: 'docTotals' },
      el('dt', null, 'Base imponible'), el('dd', null, eur(doc.totals.base)),
      el('dt', null, 'IVA'), el('dd', null, eur(doc.totals.quota + doc.totals.surcharge)),
      doc.totals.withholding ? el('dt', null, 'Retención IRPF') : null, doc.totals.withholding ? el('dd', null, `−${eur(doc.totals.withholding)}`) : null,
      el('dt', null, 'TOTAL'), el('dd', { id: 'docTotal' }, el('strong', null, eur(doc.totals.total)))));
  const meta = [`Fecha de expedición: ${shortDate(doc.issue_date)}`];
  if (doc.operation_date && doc.operation_date !== doc.issue_date) meta.push(`Fecha de la operación: ${shortDate(doc.operation_date)}`);
  const view = createPrintView({
    brand: { appName: doc.issuer.trade_name || doc.issuer.legal_name, line: doc.issuer.trade_name ? doc.issuer.legal_name : undefined },
    title: `Factura ${doc.full_number}`,
    subtitle: TYPE[doc.invoice_type] ?? doc.invoice_type,
    meta,
    intro: body,
    sections: [],
    notes: doc.breakdown.some((b) => b.exemption) ? 'Operación exenta del IVA según la mención indicada en el desglose.' : undefined,
    runningFoot: `${doc.issuer.legal_name} · NIF ${doc.issuer.tax_id} · Factura ${doc.full_number}`,
  }, { printLabel: t('Imprimir / Guardar PDF') });
  openSheet({
    title: t('Factura {numero}', { numero: doc.full_number }),
    body: el('div', { id: 'invoiceDocumentView', 'data-feedback-id': 'organizers.pagos.factura.documento', 'data-feedback-label': 'Factura', 'data-feedback-ignore': '' }, view.element),
  });
}
