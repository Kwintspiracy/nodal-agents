// document.test.ts — le vérificateur d'un DOCUMENT : quatre constats, sans
// pouvoir, et chacun DIT plutôt que noté.
//
// Plan « Créer, c'est prouver », point 4. Un skill écrit par un agent (trois
// fichiers : SKILL.md, base.css, base.html) affichait « non configuré » parce
// que tout ce qu'un outil de fichiers écrivait était un « projet de code » —
// et un projet sans commande de test n'est pas vérifiable. Un document, lui,
// se vérifie sans rien lancer : il existe, il n'est pas vide, il se décode, il
// est bien formé pour ce qu'il est.
//
// Chaque cas ci-dessous lit les LIGNES rendues (`records`), pas seulement le
// verdict : c'est la raison qui fait la valeur d'un rouge.

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { projectKey } from '@nodal-agents/shared';
import { DOCUMENT_MANIFEST_HASH, documentVerifier } from '../../verification/document.ts';
import type { ProofCommandRecord, ReadyConfig } from '../../verification/types.ts';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nodal-doc-verif-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** La preuve sur UN fichier : la configuration prête telle que `loadConfig` la rend, puis `runProof`. */
async function prove(absPath: string): Promise<{
  verdict: string;
  records: ProofCommandRecord[];
  seen: ProofCommandRecord[];
}> {
  const config = await documentVerifier.loadConfig(null as never, {
    entityId: 'e',
    canonicalKey: documentVerifier.canonicalize(absPath),
  });
  expect(config.kind).toBe('ready');
  const seen: ProofCommandRecord[] = [];
  const proof = await documentVerifier.runProof(config as ReadyConfig, async (r) => {
    seen.push(r);
  });
  return { verdict: proof.verdict, records: [...proof.records], seen };
}

const write = (name: string, content: string | Buffer): string => {
  const p = join(dir, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

describe('document — identité et configuration', () => {
  it('la clé est celle de projectKey, la seule règle de casse du dépôt', () => {
    expect(documentVerifier.deliverableType).toBe('document');
    expect(documentVerifier.canonicalize('D:\\Dev\\Skills\\SKILL.md')).toBe(
      projectKey('D:\\Dev\\Skills\\SKILL.md'),
    );
  });

  it('est toujours PRÊT, sans commande et sans approbation — constater n’est pas un pouvoir', async () => {
    const config = await documentVerifier.loadConfig(null as never, {
      entityId: 'e',
      canonicalKey: '/srv/docs/a.md',
    });
    expect(config).toMatchObject({
      kind: 'ready',
      commands: [],
      cwd: '/srv/docs',
      manifestHash: DOCUMENT_MANIFEST_HASH,
      epoch: 0,
    });
  });
});

describe('document — les trois constats communs', () => {
  it('un fichier supprimé entre l’écriture et la vérification est ROUGE, pas absent', async () => {
    const p = write('gone.md', '# Titre\n');
    rmSync(p);
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ rank: 1, command: 'exists', verdict: 'red' });
    expect(records[0]?.stderrTail).toMatch(/not found/i);
  });

  it('un fichier vide est rouge, et le dit', async () => {
    const p = write('empty.md', '');
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records.map((r) => [r.command, r.verdict])).toEqual([
      ['exists', 'green'],
      ['not-empty', 'red'],
    ]);
  });

  it('un fichier qui ne se décode pas en UTF-8 est rouge', async () => {
    const p = write('latin1.md', Buffer.from([0x23, 0x20, 0xe9, 0xe9, 0xff, 0xfe, 0x0a]));
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records.at(-1)).toMatchObject({ command: 'utf8', verdict: 'red' });
  });

  it('chaque constat est rendu au fil de l’eau — l’appelant les persiste un par un', async () => {
    const p = write('ok.md', '# Titre\n\ncorps\n');
    const { records, seen } = await prove(p);
    expect(seen.map((r) => r.rank)).toEqual(records.map((r) => r.rank));
    expect(seen.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });
});

describe('document — bien formé, selon son type', () => {
  it('un markdown sans titre est rouge et dit pourquoi', async () => {
    const p = write('sans-titre.md', 'juste du texte\n\nsans titre\n');
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records.at(-1)).toMatchObject({ command: 'well-formed:markdown', verdict: 'red' });
    expect(records.at(-1)?.stderrTail).toMatch(/title|heading/i);
  });

  it('un markdown à titre setext (souligné) est un markdown avec titre', async () => {
    const p = write('setext.md', 'Mon titre\n=========\n\ncorps\n');
    const { verdict } = await prove(p);
    expect(verdict).toBe('green');
  });

  it('un CSS dont un bloc ne se referme pas est rouge, avec la ligne de l’ouverture', async () => {
    const p = write('bad.css', 'body { color: red;\n.x { }\n'); // l'accolade de body jamais refermée
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records.at(-1)).toMatchObject({ command: 'well-formed:css', verdict: 'red' });
    expect(records.at(-1)?.stderrTail).toMatch(/'\{' opened at line 1 is never closed/);
  });

  it('un commentaire CSS jamais fermé est rouge ; l’imbrication moderne ne l’est pas', async () => {
    // Sondé avant d'écrire : `css-tree` acceptait un bloc jamais refermé et
    // refusait `.a { .b {} }`. La structure, elle, ne se trompe dans aucun des
    // deux sens.
    const comment = write('comment.css', 'a { color: red; } /* jamais fermé\n');
    expect((await prove(comment)).records.at(-1)?.stderrTail).toMatch(/comment opened at line 1/);
    const nesting = write(
      'nesting.css',
      '.a { color: red; .b { color: blue; } @media (min-width: 1px) { color: green; } }\n',
    );
    expect((await prove(nesting)).verdict).toBe('green');
    const url = write('url.css', 'a { background: url("a)b.png"); content: "}"; }\n');
    expect(
      (await prove(url)).verdict,
      'les parenthèses et accolades dans une chaîne ne comptent pas',
    ).toBe('green');
  });

  it('un en-tête YAML et une liste suivie d’un filet ne sont pas des titres', async () => {
    // Trouvés en sondant : la deuxième ligne de `---`/`title: x`/`---` passait
    // pour un titre souligné, et `- item` suivi de `---` aussi.
    const fm = write('frontmatter.md', '---\ntitle: x\n---\n\ncorps sans titre\n');
    expect((await prove(fm)).verdict).toBe('red');
    const liste = write('liste.md', '- item\n---\ntexte\n');
    expect((await prove(liste)).verdict).toBe('red');
    // Mais un vrai titre APRÈS l'en-tête compte.
    const fmTitre = write('frontmatter-titre.md', '---\ntitle: x\n---\n\n# Titre\n');
    expect((await prove(fmTitre)).verdict).toBe('green');
  });

  it('un HTML qui ne se referme pas est rouge', async () => {
    const p = write('open.html', '<!doctype html><html><body><div><p>texte</body></html>');
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records.at(-1)).toMatchObject({ command: 'well-formed:html', verdict: 'red' });
  });

  it('un HTML sans doctype et avec un <br/> reste bien formé — ce sont des tolérances, pas des fautes', async () => {
    const p = write('lenient.html', '<html><body><p>a<br/>b</p></body></html>');
    const { verdict } = await prove(p);
    expect(verdict).toBe('green');
  });

  it('un JSON qui ne se parse pas est rouge', async () => {
    const p = write('bad.json', '{"a": 1,}');
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records.at(-1)).toMatchObject({ command: 'well-formed:json', verdict: 'red' });
  });

  it('un SVG mal formé est rouge', async () => {
    const p = write('bad.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>');
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records.at(-1)).toMatchObject({ command: 'well-formed:svg', verdict: 'red' });
  });

  it('les trois fichiers du skill sont verts', async () => {
    const md = write('skill/SKILL.md', '# Base CSS\n\nUn skill.\n');
    const css = write('skill/base.css', ':root { --ink: #111; }\nbody { color: var(--ink); }\n');
    const html = write(
      'skill/base.html',
      '<!doctype html>\n<html lang="fr"><head><title>Base</title></head><body><main>ok</main></body></html>\n',
    );
    for (const p of [md, css, html]) {
      const { verdict, records } = await prove(p);
      expect(verdict, p).toBe('green');
      expect(records.map((r) => r.verdict)).toEqual(['green', 'green', 'green', 'green']);
    }
  });

  it('une extension inconnue s’arrête aux trois constats communs — et le DIT', async () => {
    const p = write('notes.xyz', 'quelque chose\n');
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('green');
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.command)).toEqual(['exists', 'not-empty', 'utf8']);
    // La raison de l'arrêt est écrite dans le dernier constat, pas tue.
    expect(records.at(-1)?.stdoutTail).toMatch(/no well-formedness rule for \.xyz/i);
  });
});
