// recipients.test.ts — aucun destinataire réel dans le banc. C'est LA protection.
//
// Revue Reviewer A de #756 (P2-1 a) : aucune liste de noms d'outils ne verra
// jamais un courrier envoyé par un outil générique (`run_command` avec smtplib
// ou curl, `run_skill_script`). Le garde `no-mail-sender` (needs.ts) est une
// défense en profondeur ; la protection est qu'il n'existe NULLE PART dans le
// banc une adresse, un numéro ou un chat qui mène à quelqu'un : ni dans une
// demande, ni dans une fixture que le banc pose dans un espace de travail.
//
// Ce test balaie toutes les demandes et TOUS les fichiers de
// packages/bench/fixtures (le texte des fichiers Office et PDF compris, lu
// avec les lecteurs des juges). Une adresse n'est admise que sous un domaine
// réservé (RFC 2606 / 6761 : `.invalid`, `.test`, `.example`, `example.com`,
// `example.net`, `example.org`) ou déclarée comme destinataire de test
// (`BENCH_TEST_RECIPIENTS`). Un numéro de téléphone ou un identifiant de chat
// n'est admis que déclaré.

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readXlsxGrid } from '../disk';
import { FIXTURES_DIR } from '../fixtures';
import { BENCH_TEST_RECIPIENTS } from '../needs';
import { readDocx, readPdf, readPptx } from '../office';
import { SCENARIOS } from '../scenarios';

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
/** Un numéro : international (+33 6 12 34 56 78) ou national à dix chiffres (06 12 34 56 78). */
const PHONE =
  /(?<![\w.,])(?:\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){7,12}|0[1-9](?:[\s.-]?\d{2}){4})(?![\w]|[.,]\d)/g;
/** Un identifiant de chat (Telegram, Discord, WhatsApp) : neuf chiffres d'affilée ou plus. */
const CHAT_ID = /(?<![\w.,-])-?\d{9,}(?![\w]|[.,]\d)/g;

const RESERVED = /(^|\.)(invalid|test|example|localhost)$|(^|\.)example\.(com|net|org)$/i;

/** Les destinataires d'un texte qui ne sont ni réservés ni déclarés. */
export function realRecipients(text: string): string[] {
  const declared = new Set(BENCH_TEST_RECIPIENTS.map((r) => r.toLowerCase()));
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL))
    if (!RESERVED.test(m[1]!) && !declared.has(m[0].toLowerCase())) out.push(m[0]);
  for (const re of [PHONE, CHAT_ID])
    for (const m of text.matchAll(re)) if (!declared.has(m[0].trim())) out.push(m[0].trim());
  return out;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** Le texte d'une fixture, lu comme un juge le lirait. */
async function textOf(path: string): Promise<string> {
  switch (extname(path).toLowerCase()) {
    case '.docx':
      return (await readDocx(path)).text;
    case '.pptx':
      return (await readPptx(path)).flatMap((s) => s.paragraphs).join('\n');
    case '.pdf':
      return (await readPdf(path)).pageTexts.join('\n');
    case '.xlsx':
      return (await readXlsxGrid(path))
        .flatMap((s) =>
          Object.values(s.cells).map((c) => ('value' in c ? String(c.value) : c.formula)),
        )
        .join('\n');
    default:
      return readFileSync(path, 'utf8');
  }
}

describe('the scanner sees real recipients', () => {
  it('flags a real address, a phone number and a chat id; leaves reserved ones', () => {
    expect(realRecipients('écris à jean.dupont@gmail.com')).toEqual(['jean.dupont@gmail.com']);
    expect(realRecipients('appelle le 06 12 34 56 78 ou le +33 6 12 34 56 78')).toEqual([
      '06 12 34 56 78',
      '+33 6 12 34 56 78',
    ]);
    expect(realRecipients('envoie-le au chat -1001234567890')).toEqual(['-1001234567890']);
    // En fin de phrase, la ponctuation ne cache rien.
    expect(realRecipients('Rappelle-moi au 06 12 34 56 78. Merci, 123456789, au revoir.')).toEqual([
      '06 12 34 56 78',
      '123456789',
    ]);
    expect(
      realRecipients('bench@example.invalid, contact@example.org, a@mail.example.com, b@x.test'),
    ).toEqual([]);
  });

  it('does not take amounts, dates or totals for phone numbers or chat ids', () => {
    expect(
      realRecipients('Total TTC : 1 234,56 EUR le 2026-10-15 ; 604 800 secondes ; 10 000 euros'),
    ).toEqual([]);
  });
});

describe('no real recipient anywhere in the bench', () => {
  it('in no scenario request', () => {
    const found = SCENARIOS.map((s) => ({ id: s.id, real: realRecipients(s.instruction) })).filter(
      (x) => x.real.length > 0,
    );
    expect(found).toEqual([]);
  });

  it('in no file the bench puts in a workspace (packages/bench/fixtures, Office and PDF text included)', async () => {
    const found: Array<{ file: string; real: string[] }> = [];
    const files = filesUnder(FIXTURES_DIR);
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const real = realRecipients(await textOf(f));
      if (real.length > 0) found.push({ file: relative(FIXTURES_DIR, f), real });
    }
    expect(found).toEqual([]);
  });
});
