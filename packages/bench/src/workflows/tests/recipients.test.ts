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
//
// Passe 2 : une demande peut viser le propriétaire SANS aucun identifiant
// (« envoie-la-moi sur Telegram » : l'outil d'envoi retombe sur son chat). Tout
// scénario déclare donc où il envoie (`sends`), et une demande d'envoi tournée
// vers le propriétaire exige `sends: 'owner'` — un scénario qui ne tourne
// qu'avec `--allow-owner-sends`, jamais dans un jeu, une matrice ou la nuit.

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readXlsxGrid } from '../disk';
import { FIXTURES_DIR } from '../fixtures';
import { destinationProblems, realRecipients } from '../recipients';
import { readDocx, readPdf, readPptx } from '../office';
import { SCENARIOS } from '../scenarios';

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

describe('a request to send to the owner needs a declared destination', () => {
  it('sees the verb turned to the person asking, in French and in English', () => {
    expect(destinationProblems('Puis envoie-la-moi sur Telegram.', 'nothing')).toHaveLength(1);
    expect(destinationProblems('Tu peux me l’envoyer ?', 'nothing')).toHaveLength(1);
    expect(destinationProblems("Tu peux me l'envoyer ?", 'nothing')).toHaveLength(1);
    expect(destinationProblems('Then send it to me.', 'nothing')).toHaveLength(1);
    expect(destinationProblems('Partage le rapport sur Slack.', 'nothing')).toHaveLength(1);
  });

  it('a send to a reserved address nobody can receive is no send to the owner', () => {
    expect(
      destinationProblems(
        'Écris le fichier, puis envoie-le par e-mail à bench@example.invalid. Dis-moi ensuite ce qui a été fait.',
        'nothing',
      ),
    ).toEqual([]);
  });

  it('a sentence without a sending verb, or a fixture that delivers a service, asks nothing', () => {
    expect(
      destinationProblems('Pose-moi la question, puis donne-moi le résultat.', 'nothing'),
    ).toEqual([]);
    expect(
      destinationProblems('ACME s’engage à livrer la prestation sous trente jours.', 'nothing'),
    ).toEqual([]);
  });

  it('the same request is fine once the scenario declares the owner', () => {
    expect(destinationProblems('Puis envoie-la-moi sur Telegram.', 'owner')).toEqual([]);
  });
});

describe('no real recipient anywhere in the bench', () => {
  it('every scenario request matches the destination it declares', () => {
    const found = SCENARIOS.map((s) => ({
      id: s.id,
      problems: destinationProblems(s.instruction, s.sends),
    })).filter((x) => x.problems.length > 0);
    expect(found).toEqual([]);
  });

  it('only scenarios that ask for it declare the owner', () => {
    expect(SCENARIOS.filter((s) => s.sends === 'owner').map((s) => s.id)).toEqual([
      'comfyui-telegram',
    ]);
  });

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
      const text = await textOf(f);
      // Une fixture ne déclare rien : elle ne doit ni nommer quelqu'un, ni demander d'envoyer au propriétaire.
      const real = [...realRecipients(text), ...destinationProblems(text, 'nothing')];
      if (real.length > 0) found.push({ file: relative(FIXTURES_DIR, f), real });
    }
    expect(found).toEqual([]);
  });
});
