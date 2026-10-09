/**
 * PDF mínimo con capa de texto (Helvetica, WinAnsi) para las pruebas de «Leer PDF» (fase 2). Sin dependencias: una
 * página A4 con cada línea en su posición; los caracteres fuera de ASCII se escriben como octal en WinAnsi (º, €, ñ…).
 */
const WIN_ANSI_EXTRA: Record<string, number> = { '€': 0x80 };

function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = WIN_ANSI_EXTRA[ch] ?? ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (code < 32 || code > 126) out += '\\' + code.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + ')';
}

/** Líneas `[texto, x, y]` en puntos (origen abajo a la izquierda; A4 = 595 × 842). */
export function textPdf(lines: Array<[string, number, number]>): Buffer {
  const content = lines.map(([text, x, y]) => `BT /F1 10 Tf ${x} ${y} Td ${pdfString(text)} Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Factura de prueba con texto: proveedor con CIF válido, número, fecha, dos tipos de IVA, IRPF y total. */
export function invoiceTextPdf(number = 'A-2026/0457'): Buffer {
  return textPdf([
    ['FRUTAS PEPE S.L.', 40, 800],
    ['C/ Mayor 1, Madrid', 40, 786], ['CIF: B12345674', 300, 786],
    [`Factura nº: ${number}`, 40, 760], ['Fecha factura: 06/10/2026', 300, 760],
    ['Tomate pera 20 kg', 40, 730], ['40,00', 450, 730],
    ['Aceite de oliva', 40, 716], ['100,00', 450, 716],
    ['Base imponible', 40, 690], ['140,00 €', 450, 690],
    ['IVA 10%', 40, 676], ['40,00', 300, 676], ['4,00', 450, 676],
    ['IVA 21%', 40, 662], ['100,00', 300, 662], ['21,00', 450, 662],
    ['Retención IRPF 15%', 40, 648], ['6,00', 450, 648],
    ['TOTAL FACTURA', 40, 620], ['159,00 €', 450, 620],
  ]);
}

/**
 * PDF de varias páginas con texto (medición en el móvil, fase 1): `pages` páginas de 45 líneas y, si se pide, un objeto
 * de relleno de `paddingBytes` (como la imagen de un escaneado) para probar PDF grandes.
 */
export function manyPagesPdf(pages: number, paddingBytes = 0): Buffer {
  const pageLines = (n: number) => Array.from({ length: 45 }, (_, i): [string, number, number] => [
    i === 0 ? `FRUTAS PEPE S.L.  CIF: B12345674  Factura nº: MP-${pages}  Fecha factura: 06/10/2026  Página ${n}` : `Artículo ${n}-${i} de prueba con descripción larga`, 40, 800 - i * 16]);
  const last: Array<[string, number, number]> = [['Base imponible', 40, 90], ['100,00', 450, 90], ['IVA 21%', 40, 76], ['100,00', 300, 76], ['21,00', 450, 76], ['TOTAL FACTURA', 40, 60], ['121,00 €', 450, 60]];
  const contents = Array.from({ length: pages }, (_, p) => [...pageLines(p + 1), ...(p === pages - 1 ? last : [])].map(([text, x, y]) => `BT /F1 10 Tf ${x} ${y} Td ${pdfString(text)} Tj ET`).join('\n'));
  const kids = contents.map((_, p) => `${5 + p * 2} 0 R`).join(' ');
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${paddingBytes} >>\nstream\n${'0'.repeat(paddingBytes)}\nendstream`];
  contents.forEach((content, p) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + p * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
