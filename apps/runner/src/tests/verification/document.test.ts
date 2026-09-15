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
      epoch: 0,
    });
    // Le manifeste d'un document, c'est ses règles PLUS l'état du fichier
    // (constat C1) : ici le fichier n'existe pas, et c'est dit.
    expect((config as ReadyConfig).manifestHash).toBe(`${DOCUMENT_MANIFEST_HASH}:absent`);
  });

  it('le manifeste SUIT le fichier — écrire dedans change la configuration', async () => {
    // Revue Codex post-merge de la PR #66, constat C1 (bloquant). `epoch` et
    // `manifestHash` étaient CONSTANTS pour un document : la primitive, qui les
    // relit après la preuve pour savoir si l'arbre a bougé, ne voyait jamais
    // rien bouger. Un autre job pouvait remplacer le fichier pendant la preuve
    // et le vert restait — sur un contenu qui n'était plus là.
    const p = write('empreinte.md', '# Un\n');
    const avant = await documentVerifier.loadConfig(null as never, {
      entityId: 'e',
      canonicalKey: documentVerifier.canonicalize(p),
    });
    writeFileSync(p, '# Un titre bien plus long qu’avant\n');
    const apres = await documentVerifier.loadConfig(null as never, {
      entityId: 'e',
      canonicalKey: documentVerifier.canonicalize(p),
    });
    expect((avant as ReadyConfig).manifestHash).not.toBe((apres as ReadyConfig).manifestHash);
    // Et sans écriture, il ne bouge pas : sinon tout deviendrait sale.
    const encore = await documentVerifier.loadConfig(null as never, {
      entityId: 'e',
      canonicalKey: documentVerifier.canonicalize(p),
    });
    expect((encore as ReadyConfig).manifestHash).toBe((apres as ReadyConfig).manifestHash);
  });

  it('le manifeste suit le CONTENU, pas la taille ni la date', async () => {
    // Passe 2 de la dette #66, constat R1. La première empreinte prenait taille
    // et mtime, et laissait donc passer une réécriture de MÊME TAILLE dans la
    // même granularité de mtime — et ce test-ci ne le voyait pas, puisqu'il
    // changeait la longueur. Deux contenus de longueur identique.
    const p = write('meme-taille.md', '# aaaa\n');
    const avant = await documentVerifier.loadConfig(null as never, {
      entityId: 'e',
      canonicalKey: documentVerifier.canonicalize(p),
    });
    writeFileSync(p, '# bbbb\n');
    const apres = await documentVerifier.loadConfig(null as never, {
      entityId: 'e',
      canonicalKey: documentVerifier.canonicalize(p),
    });

    expect((avant as ReadyConfig).manifestHash).not.toBe((apres as ReadyConfig).manifestHash);
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

describe('document — le chemin RÉEL, pas la clé repliée en casse', () => {
  it('la preuve ouvre le chemin d’affichage quand il est donné, pas la clé en minuscules', async () => {
    // Revue Codex post-merge de la PR #66, constat C2. La clé d'un document
    // est `projectKey(chemin)`, donc REPLIÉE EN CASSE sous Windows, et
    // `runProof` s'en servait comme chemin d'ouverture. Sur un dossier Windows
    // sensible à la casse (possible depuis Windows 10, et le cas de tout
    // système de fichiers POSIX), `Rapport.md` écrit puis `rapport.md` ouvert
    // donne un « not found » sur un fichier qui existe — ou pire, la preuve
    // d'un AUTRE fichier si les deux existent.
    //
    // Le chemin d'affichage (`display_path_snapshot`) est celui que l'outil a
    // écrit : c'est lui que la preuve ouvre. La clé reste l'identité.
    const reel = write('Casse/Rapport.md', '# Rapport\n');
    const repliee = reel.replace(/Rapport\.md$/, 'rapport.md');
    const config = await documentVerifier.loadConfig(null as never, {
      entityId: 'e',
      canonicalKey: repliee,
      displayPath: reel,
    });
    // Ce que le test peut prouver sur TOUTE plateforme : le sujet de la preuve
    // est le chemin réel, pas la clé. La conséquence (ouvrir le bon fichier)
    // ne se distingue que sur un système sensible à la casse — un volume
    // Windows normal répond pareil aux deux, et le test y resterait vert quoi
    // qu'il arrive.
    expect(config).toMatchObject({ kind: 'ready', subject: reel });
    const proof = await documentVerifier.runProof(config as ReadyConfig, async () => {});
    expect(proof.verdict).toBe('green');
    expect(proof.records.map((r) => r.command)).toEqual([
      'exists',
      'not-empty',
      'utf8',
      'well-formed:markdown',
    ]);
  });

  it('sans chemin d’affichage, la clé reste le sujet — le contrat d’avant, intact', async () => {
    const p = write('sans-affichage.md', '# Titre\n');
    const config = await documentVerifier.loadConfig(null as never, {
      entityId: 'e',
      canonicalKey: documentVerifier.canonicalize(p),
    });
    expect(config).toMatchObject({ kind: 'ready', subject: documentVerifier.canonicalize(p) });
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

  it('une accolade ÉCHAPPÉE dans un sélecteur CSS ne compte pas comme une ouverture', async () => {
    // Revue Codex de la PR #66, constat C7 : `.foo\{ { color: red; }` était
    // rapporté rouge (« '{' opened at line 1 is never closed ») alors que la
    // première accolade appartient au nom de la classe. Un échappement est
    // permis dans un identifiant CSS ; le compteur le lisait comme structure.
    const echappe = write('escape.css', '.foo\\{ { color: red; }\n');
    expect((await prove(echappe)).verdict).toBe('green');
    const echappeAntislash = write('escape-bs.css', '.a\\\\ { color: red; }\n');
    expect((await prove(echappeAntislash)).verdict).toBe('green');
    // Et l'échappement ne sert pas d'excuse : un bloc vraiment ouvert reste rouge.
    const ouvert = write('escape-ouvert.css', '.foo\\{ { color: red;\n');
    expect((await prove(ouvert)).verdict).toBe('red');
  });

  it('un en-tête YAML en CRLF n’est pas un titre non plus — la fin de ligne ne décide pas', async () => {
    // Revue Codex de la PR #66, constat C5 : l'en-tête n'était retiré qu'avec
    // des fins de ligne LF. Le MÊME fichier écrit par un éditeur Windows
    // passait au vert, sa deuxième ligne lue comme un titre souligné.
    const crlf = write('frontmatter-crlf.md', '---\r\ntitle: x\r\n---\r\ncorps sans titre\r\n');
    expect((await prove(crlf)).verdict).toBe('red');
    const crlfTitre = write(
      'frontmatter-crlf-titre.md',
      '---\r\ntitle: x\r\n---\r\n\r\n# Titre\r\n',
    );
    expect((await prove(crlfTitre)).verdict).toBe('green');
  });

  it('un titre dans un bloc de code clôturé n’est pas le titre du document', async () => {
    // Revue Codex de la PR #66, constat C5 : un fichier qui ne contient qu'un
    // exemple passait au vert parce que l'exemple contenait un `#`.
    const fence = write('fence.md', '```\n# faux titre\n```\n');
    expect((await prove(fence)).verdict).toBe('red');
    const fenceTilde = write('fence-tilde.md', '~~~md\n# faux titre\n~~~\n');
    expect((await prove(fenceTilde)).verdict).toBe('red');
    // Un vrai titre hors du bloc compte, et le bloc ne le mange pas.
    const vrai = write('fence-vrai.md', '# Titre\n\n```\n# exemple\n```\n');
    expect((await prove(vrai)).verdict).toBe('green');
  });

  it('un bloc clôturé ne se termine pas à la première fin de ligne', async () => {
    // Passe 2 de la dette #66, constat R2. Le `$` de l'alternative, sous le
    // drapeau `m`, s'accroche à CHAQUE fin de ligne : le bloc s'arrêtait donc
    // au premier saut, et le retrait ne retirait presque rien. Trois verdicts
    // faux, mesurés sur le vrai vérificateur.
    const fauxTitreAuMilieu = write('fence-milieu.md', '```\ntexte\n# faux\n```\n');
    expect((await prove(fauxTitreAuMilieu)).verdict).toBe('red');

    const jamaisFerme = write('fence-ouvert.md', '```\ntexte\n# faux\n');
    expect((await prove(jamaisFerme)).verdict).toBe('red');

    // Une clôture PLUS LONGUE que l'ouverture est permise : le titre qui suit
    // est bien hors du bloc, et le document a un titre.
    const clotureLongue = write('fence-longue.md', '```\ntexte\n````\n# vrai\n');
    expect((await prove(clotureLongue)).verdict).toBe('green');
  });

  it('les règles CommonMark des blocs clôturés, une par une', async () => {
    // Le tableau de régression de cette règle, accumulé au fil des passes 2 à 6.
    // La règle a eu cinq formes — quatre réécritures de CommonMark à la main,
    // puis `remark-parse` ; ces cas ont survécu à toutes, et c'est ce qui leur
    // donne leur valeur. La plupart viennent de la revue, pas de moi.
    const cas: Array<[string, string, 'green' | 'red']> = [
      ['cloture-mixte-1.md', '```\ncode\n```~\n# faux\n', 'red'],
      ['cloture-mixte-2.md', '~~~\ncode\n~~~`\n# faux\n', 'red'],
      ['info-backtick.md', '``` info`x\n# vrai\n', 'green'],
      ['tab-ouvre-pas.md', '\t```\n# vrai\n', 'green'],
      ['tab-ferme-pas.md', '```\ncode\n\t```\n# faux\n', 'red'],
      ['indent-4.md', '    ```\n    # faux\n', 'red'],
      ['cloture-indentee-3.md', '```\ncode\n   ```\n# vrai\n', 'green'],
      ['deux-blocs.md', '```\na\n```\n```\nb\n```\n# vrai\n', 'green'],
      ['titre-entre-blocs.md', '```\na\n```\n# vrai\n```\nb\n```\n', 'green'],
      ['bloc-en-citation.md', '> ```\n> # faux\n> ```\n', 'red'],
      // Passe 4, constat R3 : un bloc dans un élément de LISTE n'était pas vu
      // du tout — son contenu passait pour de la prose, et sa clôture devenait
      // une ouverture qui avalait le vrai titre plus bas. L'espace insécable,
      // lui, était accepté comme fin de clôture par `trim()`.
      ['bloc-en-liste.md', '- ~~~\n  # faux\n  ~~~\n', 'red'],
      ['cloture-nbsp.md', '~~~\ncode\n~~~\u00a0\n# faux\n', 'red'],
      // Passe 5. Le retrait du préfixe de conteneur, posé en passe 4, était une
      // approximation de plus : elle fabriquait une clôture à partir d'un `- ~~~`
      // situé DANS le code, et faisait disparaître de vrais titres. Elle est
      // retirée ; c'est la règle « un titre commence en colonne zéro » qui ferme
      // le faux vert, du côté sûr.
      ['pseudo-cloture-dans-le-code.md', '~~~\n- ~~~\n# faux\n', 'red'],
      ['liste-dix-chiffres.md', '1234567890. ~~~\n# vrai\n', 'green'],
      ['tiret-cinq-espaces.md', '-     ~~~\n\n# vrai\n', 'green'],
      ['citation-puis-titre.md', '> ~~~\n> code\n\n# vrai\n', 'green'],
      ['liste-puis-titre.md', '- ~~~\n  code\n\n# vrai\n', 'green'],
      // Depuis `remark-parse`, un titre indenté de trois espaces EST un titre :
      // la règle « colonne zéro » était une prudence rendue inutile par un vrai
      // parseur, et ce cas le prouve dans l'autre sens.
      ['titre-indente-trois.md', '   # Titre\n\ncorps\n', 'green'],
      // La profondeur compte : c'est le TITRE du document qui est demandé.
      ['commence-par-h2.md', '## Details\n\ncorps\n', 'red'],
      // Passe 6, constat R1 — une RÉGRESSION de C5 que le passage au parseur
      // avait réintroduite : `remark-parse` ignore le front matter, lit `---`
      // comme un filet, et un commentaire YAML `# …` y devient un vrai titre.
      ['yaml-commentaire.md', '---\n# commentaire YAML\ntitle: x\n---\n\ncorps\n', 'red'],
      ['yaml-commentaire-crlf.md', '---\r\n# commentaire\r\ntitle: x\r\n---\r\ncorps\r\n', 'red'],
      ['yaml-puis-vrai-titre.md', '---\ntitle: x\n---\n\n# Vrai\n', 'green'],
      // Passe 7, constats R1 et R2. L'expression régulière ne connaissait qu'un
      // seul en-tête : ouvert par `---`, fermé par `---`, non vide. La clôture
      // YAML `...` et l'en-tête TOML `+++` lui échappaient — deux FAUX VERTS.
      ['yaml-cloture-points.md', '---\n# commentaire\ntitle: x\n...\ncorps\n', 'red'],
      ['toml-commentaire.md', '+++\n# commentaire\ntitle = "x"\n+++\ncorps\n', 'red'],
      ['toml-puis-vrai-titre.md', '+++\ntitle = "x"\n+++\n\n# Vrai\n', 'green'],
      // Et un en-tête VIDE faisait chercher la fermeture trop loin : le vrai
      // titre était mangé jusqu'au filet suivant — un FAUX ROUGE.
      ['front-matter-vide.md', '---\n---\n# Vrai\n\n---\n\ncorps\n', 'green'],
      // Jamais refermé : ce n'est pas un en-tête, c'est le document lui-même.
      ['front-matter-non-ferme.md', '---\ntitle: x\n\ncorps\n', 'red'],
      // Passe 8, constat R1, puis passe 9 : un en-tête dont la clôture tombe
      // dans un bloc de code n'est PAS un faux vert. `remark-frontmatter`
      // 5.0.0, mesuré hors dépôt, lit le même en-tête et rend le même vert :
      // le titre est dans le corps pour tout outil qui lit du front matter.
      ['cloture-dans-le-code.md', '---\n\n```\n---\n# faux\n```\n', 'green'],
      // Le titre collé au délimiteur, lui, reste rouge : après l'en-tête il ne
      // reste qu'un bloc de code ouvert. La référence dit la même chose.
      ['titre-colle-a-l-en-tete.md', '---\n# Vrai\n\n```\n---\n```\n', 'red'],
      // Passe 9, constat R2 — la conjonction de la passe 8 rendait ROUGE ce
      // document-ci, dont l'en-tête est parfaitement valide : `example` est un
      // scalaire littéral qui contient trois backticks, et la lecture brute y
      // voyait un bloc de code jamais refermé qui cachait le vrai titre.
      ['bloc-scalaire-yaml.md', '---\nexample: |\n  ```\n---\n# Vrai\n', 'green'],
    ];
    for (const [name, content, attendu] of cas) {
      expect((await prove(write(name, content))).verdict, name).toBe(attendu);
    }
  });

  it('retirer un bloc ne doit pas FABRIQUER un titre souligné', async () => {
    // Passe 3, constat R3. La règle d'alors supprimait les lignes du bloc, ce
    // qui recollait leurs voisines : un paragraphe, un bloc, puis un filet
    // devenaient « texte / --- », donc un titre setext qui n'existait pas.
    // `remark-parse` ne peut plus se tromper là-dessus ; le cas reste, parce
    // qu'il dit ce que le document SIGNIFIE.
    const p = write('recollage.md', 'texte\n```\ncode\n```\n---\n');

    expect((await prove(p)).verdict).toBe('red');
  });

  it('une entité déclarée DANS le document ne le rend pas mal formé', async () => {
    // Passe 2 de la dette #66, constat R3. `@xmldom/xmldom` ne lit pas le
    // sous-ensemble interne d'un DOCTYPE et rapporte `entity not found` pour
    // une entité parfaitement déclarée. Retenir `error` faisait rougir du XML
    // valide — un faux rouge sur du travail correct.
    const declaree = write(
      'entite-declaree.svg',
      '<!DOCTYPE svg [<!ENTITY x "bonjour">]>' +
        '<svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>',
    );
    expect((await prove(declaree)).verdict).toBe('green');

    // Et sans déclaration, l'entité inconnue reste rouge (le constat C6).
    const inconnue = write(
      'entite-inconnue.svg',
      '<svg xmlns="http://www.w3.org/2000/svg">&nope;</svg>',
    );
    expect((await prove(inconnue)).verdict).toBe('red');

    // Passe 3, constats R4 et R5 : chercher un DOCTYPE se trompait DANS LES DEUX
    // SENS. Un sous-ensemble vide, ou un commentaire qui en imite un, éteignait
    // tous les `error` et rouvrait le trou ; un `>` dans un identifiant système
    // — permis par la grammaire XML — faisait manquer un vrai sous-ensemble.
    // C'est l'ENTITÉ NOMMÉE par le message qui décide maintenant.
    const cas: Array<[string, string, 'green' | 'red']> = [
      ['dtd-vide.svg', '<!DOCTYPE svg []><svg>&nope;</svg>', 'red'],
      ['dtd-commentaire.svg', '<!-- <!DOCTYPE svg [ --><svg>&nope;</svg>', 'red'],
      [
        'dtd-system-chevron.svg',
        '<!DOCTYPE svg SYSTEM "urn:a>b" [<!ENTITY x "ok">]><svg>&x;</svg>',
        'green',
      ],
      // Passe 4, constat R4 : trois façons de faire taire la plainte sans rien
      // déclarer. Les noms XML sont sensibles à la casse, et une déclaration
      // écrite dans un commentaire ou une section CDATA n'en est pas une.
      ['entite-casse.svg', '<!DOCTYPE svg [<!ENTITY x "ok">]><svg>&X;</svg>', 'red'],
      ['entite-commentaire.svg', '<!-- <!ENTITY x "ok"> --><svg>&x;</svg>', 'red'],
      ['entite-cdata.svg', '<svg><![CDATA[<!ENTITY x "ok">]]>&x;</svg>', 'red'],
    ];
    for (const [name, content, attendu] of cas) {
      expect((await prove(write(name, content))).verdict, name).toBe(attendu);
    }
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

  it('un <style> DANS un <svg> reste du CSS — le compteur n’invente pas de balise', async () => {
    // Revue Codex de la PR #66, constat C8. Le mode « texte brut » n'était posé
    // que hors contenu étranger : à l'intérieur d'un `<svg>`, le contenu d'un
    // `<style>` était relu comme du HTML, et une chaîne CSS contenant `<div>`
    // faisait rougir un fichier valide. Mesuré sur les deux formes — le constat
    // rendu ne nommait que `foreignObject`, la forme simple échouait aussi.
    const simple = write(
      'svg-style.html',
      '<svg><style>.a::before { content: "<div>"; }</style></svg>\n',
    );
    expect((await prove(simple)).verdict).toBe('green');
    const foreign = write(
      'svg-foreign.html',
      '<svg><foreignObject><style>.a::before { content: "<div>"; }</style></foreignObject></svg>\n',
    );
    expect((await prove(foreign)).verdict).toBe('green');
    const script = write(
      'svg-script.html',
      '<svg><script>if (a &lt; b) { x("</div>"); }</script></svg>\n',
    );
    expect((await prove(script)).verdict).toBe('green');
    // Et le SVG lui-même doit toujours se refermer.
    const ouvert = write('svg-ouvert.html', '<div><svg><style>.a{}</style></svg>\n');
    expect((await prove(ouvert)).verdict).toBe('red');
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

  it('une faute XML NON fatale est rouge aussi — une entité inconnue n’est pas du bien formé', async () => {
    // Revue Codex de la PR #66, constat C6 : seul le niveau `fatalError` était
    // retenu. `@xmldom/xmldom` rapporte une entité inconnue au niveau `error`
    // et rend quand même un document : le SVG passait au vert.
    const p = write('entite.svg', '<svg xmlns="http://www.w3.org/2000/svg">&undefined;</svg>');
    const { verdict, records } = await prove(p);
    expect(verdict).toBe('red');
    expect(records.at(-1)).toMatchObject({ command: 'well-formed:svg', verdict: 'red' });
    expect(records.at(-1)?.stderrTail).toMatch(/entity/i);
    // Et les SVG valides restent verts : sondés, ils n'émettent aucun `error`.
    const ok = write(
      'valide.svg',
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">' +
        '<!-- c --><style><![CDATA[.a{fill:red}]]></style><rect width="1" height="1"/></svg>',
    );
    expect((await prove(ok)).verdict).toBe('green');
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
