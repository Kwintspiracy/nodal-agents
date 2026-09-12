// audit-tests-chevauchement.test.mjs — le détecteur de chevauchement, vérifié
// sur des sources qu'on écrit ici.
//
// Un audit dont le détecteur n'est pas testé ne vaut rien : il rend un chiffre
// que personne ne peut contredire. Les cas ci-dessous couvrent les trois
// endroits où ce détecteur peut mentir :
//   - l'extraction (une parenthèse dans une chaîne ou un commentaire déplace la
//     fin d'un corps, et tous les appariements du fichier partent de travers) ;
//   - la normalisation (trop agressive, elle apparie deux tests qui n'appellent
//     pas la même fonction — c'est un faux positif, et c'est le coût le plus
//     cher ici) ;
//   - la frontière fichier (un groupe étalé sur plusieurs fichiers est presque
//     toujours de la défense en profondeur, pas une duplication).
//
// Lancer depuis la racine : npx vitest run scripts/tests/audit-tests-chevauchement.test.mjs

import { describe, it, expect } from 'vitest';
import { analyserSource, detecter } from '../audit-tests-chevauchement.mjs';

describe('analyserSource', () => {
  it('reconstruit le titre complet en empilant les describe', () => {
    const cas = analyserSource(
      `describe('le routeur', () => {
         describe('quand le canal est slack', () => {
           it('choisit le handler slack', () => {
             expect(router('slack')).toBe(handleSlack);
           });
         });
       });`,
      'faux/routeur.test.ts',
    );

    expect(cas).toHaveLength(1);
    expect(cas[0].cheminTitre).toBe('le routeur quand le canal est slack choisit le handler slack');
    expect(cas[0].titre).toBe('choisit le handler slack');
    expect(cas[0].fichier).toBe('faux/routeur.test.ts');
  });

  it('ne se fait pas déborder par une parenthèse dans une chaîne, un commentaire ou une regex', () => {
    // C'est la PARENTHÈSE qui délimite l'appel `it(...)`, pas l'accolade. Une
    // parenthèse fermante en trop dans du texte coupe le premier corps trop
    // tôt : le titre du second cas se retrouve alors dans le corps du premier,
    // et les deux sortent avec un corps faux. Première version de ce test :
    // elle mettait des accolades, et survivait à toutes les mutations — elle
    // ne prouvait rien.
    const cas = analyserSource(
      `it('premier', () => {
         const texte = 'une ) parenthèse ) en trop';
         // ) et une autre ici )
         const motif = /\\)|[)]/;
         expect(rendre(texte, motif)).toBe('ok');
       });
       it('second', () => {
         expect(rendre('rien')).toBe('ok');
       });`,
      'faux/parentheses.test.ts',
    );

    expect(cas.map((c) => c.titre)).toEqual(['premier', 'second']);
    // Le corps du premier va bien jusqu'à SA fin : il contient son assertion,
    // et pas le titre du second.
    expect(cas[0].assertions).toEqual(['.toBe']);
    expect(cas[0].appels).toContain('rendre');
    expect(cas[0].normalise).not.toContain('second');
  });

  it('relève les appels et la forme des assertions, pas leur valeur', () => {
    const [cas] = analyserSource(
      `it('un cas', async () => {
         const ligne = await lireLigne(identifiant);
         expect(ligne.action).toBe('block');
         await expect(ecrire(ligne)).rejects.toThrow('refusé');
       });`,
      'faux/formes.test.ts',
    );

    expect(cas.appels).toContain('lireLigne');
    expect(cas.assertions).toEqual(['.toBe', '.rejects.toThrow']);
    expect(cas.valeurs).toEqual(['block', 'refusé']);
  });

  it('compte un `it.skip` comme sauté', () => {
    const [cas] = analyserSource(
      `it.skip('pas encore', () => {
         expect(fonctionnalite()).toBe(true);
       });`,
      'faux/saute.test.ts',
    );

    expect(cas.saute).toBe(true);
  });
});

describe('detecter', () => {
  /** Deux corps identiques à la valeur près — le cas canonique d'un `test.each`. */
  const MEME_CORPS = (valeur, fichier) =>
    analyserSource(
      `it('écrit une règle pour ${valeur}', async () => {
         const r = await ecrireRegle({ outil: '${valeur}', action: 'block' });
         expect(r.ok).toBe(true);
         const lignes = await relireRegles('${valeur}');
         expect(lignes).toHaveLength(1);
       });`,
      fichier,
    );

  it('groupe deux cas qui ne diffèrent que par leurs littéraux, et les dit CERTAINS', () => {
    const cas = [
      ...MEME_CORPS('web_search', 'a.test.ts'),
      ...MEME_CORPS('file_write', 'a.test.ts'),
    ];
    const { certains, probables } = detecter(cas);

    expect(probables).toHaveLength(0);
    expect(certains).toHaveLength(1);
    expect(certains[0].membres.map((m) => m.titre)).toEqual([
      'écrit une règle pour web_search',
      'écrit une règle pour file_write',
    ]);
    expect(certains[0].copiesPures).toBe(false);
    expect(certains[0].memeFichier).toBe(true);
  });

  it('signale « copies pures » quand les littéraux sont identiques eux aussi', () => {
    const cas = [
      ...MEME_CORPS('web_search', 'a.test.ts'),
      ...MEME_CORPS('web_search', 'a.test.ts'),
    ];
    const { certains } = detecter(cas);

    expect(certains).toHaveLength(1);
    expect(certains[0].copiesPures).toBe(true);
  });

  it('marque `memeFichier: false` quand le groupe s’étale — c’est le signal qui a démasqué 4 faux positifs sur 5', () => {
    const cas = [
      ...MEME_CORPS('web_search', 'a.test.ts'),
      ...MEME_CORPS('web_search', 'b.test.ts'),
    ];
    const { certains } = detecter(cas);

    expect(certains).toHaveLength(1);
    expect(certains[0].memeFichier).toBe(false);
  });

  it('n’apparie PAS deux cas qui appellent des fonctions différentes', () => {
    // Même forme, même nombre d'assertions, mais `ecrireRegle` d'un côté et
    // `supprimerRegle` de l'autre : deux branches, deux protections.
    const autre = analyserSource(
      `it('supprime une règle', async () => {
         const r = await supprimerRegle({ outil: 'web_search', action: 'block' });
         expect(r.ok).toBe(true);
         const lignes = await relireRegles('web_search');
         expect(lignes).toHaveLength(1);
       });`,
      'a.test.ts',
    );
    const { certains, probables } = detecter([...MEME_CORPS('web_search', 'a.test.ts'), ...autre]);

    expect(certains).toHaveLength(0);
    expect(probables).toHaveLength(0);
  });

  it('ignore les corps trop courts — une assertion d’une ligne ne prouve pas une duplication', () => {
    const court = (nom) =>
      analyserSource(`it('${nom}', () => { expect(f()).toBe(1); });`, 'a.test.ts');
    const { certains, probables } = detecter([...court('un'), ...court('deux')]);

    expect(certains).toHaveLength(0);
    expect(probables).toHaveLength(0);
  });

  it('classe en PROBABLE deux cas de même forme dont un seul littéral diffère', () => {
    // Corps non identiques après normalisation (le second lit un champ de
    // plus), mais même suite d'appels et mêmes matchers.
    const a = analyserSource(
      `it('premier', async () => {
         const r = await ecrireRegle({ outil: 'web_search' });
         expect(r.ok).toBe(true);
         expect(r.portee).toBe('agent');
       });`,
      'a.test.ts',
    );
    const b = analyserSource(
      `it('second', async () => {
         const r = await ecrireRegle({ outil: 'file_write' });
         expect(r.ok).toBe(true);
         expect(r.portee ?? null).toBe('agent');
       });`,
      'a.test.ts',
    );
    const { certains, probables } = detecter([...a, ...b]);

    expect(certains).toHaveLength(0);
    expect(probables).toHaveLength(1);
    expect(probables[0].membres.map((m) => m.titre)).toEqual(['premier', 'second']);
  });
});
