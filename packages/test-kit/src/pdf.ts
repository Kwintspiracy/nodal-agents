// pdf.ts — a real, small PDF built in the test, for every test that hands a
// document to a model (#903). No fixture file to keep in sync, no library: the
// bytes are written here, with a correct cross-reference table, so pdf.js (and
// a provider) opens them as any PDF.
//
// Two kinds of page, the two a person sends: a page of TEXT (a PDF exported by
// a program), and a page that is ONE IMAGE and no text at all (a printer's
// scan). The scanned page draws its words as pixels, in a 5×7 bitmap font, so
// a model that reads it sees them and a text extractor finds nothing.

import { createHash } from 'node:crypto';

/**
 * One page: text set in Helvetica, or the same words as a scanned image.
 * `scale`: pixels per bitmap dot (default 6) — a larger one makes a heavier
 * page, as a high-resolution scan is (about 63 × scale² bytes a letter).
 */
export type TestPdfPage = { text: string } | { scanned: string; scale?: number };

/** The 5×7 glyphs a scanned page can draw (uppercase, digits, space). */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
};

/** Pixels per bitmap dot, by default. */
const SCALE = 6;

/** A grey image (8 bits, 0 = black) of `words`, white around them. */
function bitmap(
  words: string,
  scale: number = SCALE,
): { width: number; height: number; pixels: Buffer } {
  const cols = words.length * 6 + 1;
  const rows = 9;
  const width = cols * scale;
  const height = rows * scale;
  const pixels = Buffer.alloc(width * height, 0xff);
  [...words].forEach((ch, n) => {
    const glyph = GLYPHS[ch];
    if (glyph === undefined) {
      throw new Error(`buildTestPdf: no glyph for "${ch}" (uppercase A C E I M N O T V, 1 2 4 7)`);
    }
    glyph.forEach((line, gy) => {
      [...line].forEach((dot, gx) => {
        if (dot !== '1') return;
        const x0 = (1 + n * 6 + gx) * scale;
        const y0 = (1 + gy) * scale;
        for (let y = y0; y < y0 + scale; y += 1)
          pixels.fill(0x00, y * width + x0, y * width + x0 + scale);
      });
    });
  });
  return { width, height, pixels };
}

/** PDF string escaping for a `( … ) Tj` operand. */
const pdfString = (t: string): string => t.replace(/[\\()]/g, (c) => `\\${c}`);

/** RC4, the cipher of the PDF Standard security handler, revision 2. */
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k += 1) {
    a = (a + 1) & 0xff;
    b = (b + s[a]!) & 0xff;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[k] = data[k]! ^ s[(s[a]! + s[b]!) & 0xff]!;
  }
  return out;
}

const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest();

/** The padding string of the Standard security handler (PDF 1.7, 7.6.3.3). */
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

/**
 * What `{ restricted }` encrypts with: the Standard security handler,
 * revision 2 (RC4, 40-bit), an EMPTY user password — every reader opens the
 * file without asking — and an owner password that restricts it (`P`: no
 * copying, no changing). A bank statement is commonly saved this way.
 */
function restriction(): {
  objectKey: (n: number) => Buffer;
  dict: string;
  id: string;
} {
  const id = createHash('md5').update('nodal test pdf').digest();
  const ownerKey = md5(
    Buffer.concat([Buffer.from('owner', 'latin1'), PAD]).subarray(0, 32),
  ).subarray(0, 5);
  const O = rc4(ownerKey, PAD);
  const P = -44;
  const p = Buffer.alloc(4);
  p.writeInt32LE(P);
  const key = md5(PAD, O, p, id).subarray(0, 5);
  const U = rc4(key, PAD);
  return {
    objectKey: (n) =>
      md5(key, Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0, 0])).subarray(0, 10),
    dict:
      `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> ` +
      `/P ${P} >>`,
    id: id.toString('hex'),
  };
}

/**
 * A PDF of `pages`, US Letter: each `{ text }` page sets its text, each
 * `{ scanned }` page holds one image of its words and no text. `restricted`:
 * encrypted with an empty user password and an owner's restrictions
 * (`restriction`), as readers open it without a word.
 */
export function buildTestPdf(
  pages: readonly TestPdfPage[],
  opts: { restricted?: boolean } = {},
): Buffer {
  const lock = opts.restricted === true ? restriction() : null;
  const objects: Buffer[] = [];
  const add = (body: Buffer | string): number => {
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    return objects.length;
  };
  // A stream is encrypted with the key of the object it will be.
  const stream = (dict: string, plain: Buffer): Buffer => {
    const data = lock === null ? plain : rc4(lock.objectKey(objects.length + 1), plain);
    return Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  };

  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES'); // placeholder, rewritten once the kids are known
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const page of pages) {
    let resources: string;
    let content: string;
    if ('text' in page) {
      resources = `<< /Font << /F1 ${font} 0 R >> >>`;
      content = `BT /F1 24 Tf 72 700 Td (${pdfString(page.text)}) Tj ET`;
    } else {
      const { width, height, pixels } = bitmap(page.scanned, page.scale);
      const image = add(
        stream(
          `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
            '/ColorSpace /DeviceGray /BitsPerComponent 8',
          pixels,
        ),
      );
      resources = `<< /XObject << /Im1 ${image} 0 R >> >>`;
      // Drawn across the page, at its own aspect ratio.
      const w = 540;
      const h = Math.round((w * height) / width);
      content = `q ${w} 0 0 ${h} 36 ${700 - h} cm /Im1 Do Q`;
    }
    const contents = add(stream('', Buffer.from(content, 'latin1')));
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources ${resources} ` +
          `/Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`,
    'latin1',
  );
  const encrypt = lock === null ? null : add(lock.dict);

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const obj = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(obj);
    offset += obj.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R` +
    (lock === null || encrypt === null
      ? ''
      : ` /Encrypt ${encrypt} 0 R /ID [<${lock.id}> <${lock.id}>]`) +
    ` >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
