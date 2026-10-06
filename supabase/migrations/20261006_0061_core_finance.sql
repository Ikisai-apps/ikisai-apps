-- Ikisai Core · Invoices pasa a llamarse Finance (decisión del usuario, 6 oct 2026). Solo cambian nombre y dominio en el
-- catálogo; el identificador `invoices`, su schema y su función se mantienen. invoices.ikisai.com y tramita.ikisai.com
-- redirigen a finance.ikisai.com (Cloudflare).
update core.apps set name = 'Ikisai Finance', domain = 'finance.ikisai.com', alias_domain = 'tramita.ikisai.com', description = 'Facturas y finanzas'
where id = 'invoices';
