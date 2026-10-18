// workflows/pdf-write.ts — un PDF texte minimal, écrit à la main.
//
// Sert aux fixtures du banc (une facture, un guide de trois pages) et aux
// tests des juges qui doivent lire un vrai PDF. Aucune bibliothèque : un
// catalogue, des pages, une police standard (Helvetica, encodage WinAnsi pour
// les accents et l'euro), un flux de texte par page, une table xref exacte.
// pdf-parse le lit comme n'importe quel PDF.

/** Les caractères hors Latin-1 que WinAnsi place ailleurs. */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '–': 0x96,
  '—': 0x97,
  œ: 0x9c,
  Œ: 0x8c,
};

function pdfString(text: string): string {
  let out = '(';
  for (const ch of text) {
    const code = WIN_ANSI[ch] ?? ch.codePointAt(0)!;
    if (code > 0xff) throw new Error(`pdf-write: ${ch} has no WinAnsi code`);
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out})`;
}

/** Un PDF dont chaque page porte ses lignes de texte, de haut en bas (A4). */
export function makePdf(pages: ReadonlyArray<readonly string[]>): Buffer {
  if (pages.length === 0) throw new Error('pdf-write: a PDF needs at least one page');
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((lines, i) => {
    const pageId = pageIds[i]!;
    const body = [
      'BT',
      '/F1 12 Tf',
      '16 TL',
      '72 770 Td',
      ...lines.map((l) => `${pdfString(l)} Tj T*`),
      'ET',
    ].join('\n');
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] =
      `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++)
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
