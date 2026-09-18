// DisclosureButton.test.tsx — le retrait horizontal de la ligne repliable (#151).
//
// Pourquoi ce fichier existe : le composant posait `px-4` dans sa propre chaîne
// et concaténait le `className` de l'appelant APRÈS. Tailwind émet une règle par
// utilitaire dans un ordre fixe — `.px-0`, `.px-3`, `.px-3\.5`, `.px-4` dans la
// feuille servie — donc `px-4` gagnait toujours, quel que soit l'ordre des
// classes sur l'attribut. `FileDiff` demandait 14 px, un autre appelant 0, et
// tous les blocs du fil s'affichaient à 16 px sans que personne ne le voie.
//
// D'où deux faits ici, et pas un :
//   1. chaque `inset` rend SA classe et aucune des deux autres ;
//   2. plus aucune source ne passe un `px-*` par `className` — le chemin qui ne
//      marchait pas est fermé, pas seulement corrigé à un endroit.
//
// Mutations vérifiées : `inset` ignoré (le composant remis à `px-4` en dur) →
// les cas `tight` et `none` rougissent ; la garde privée de son filtre sur les
// attributs de la balise → elle rougit sur les `px-*` des autres composants.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import DisclosureButton from '../DisclosureButton.tsx';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Les classes portées par le <button>, dans une liste — pour dire « celle-ci
 *  et pas celle-là » sans qu'un `px-3` trouvé dans `px-3.5` fasse illusion. */
function classesDuBouton(html: string): string[] {
  const m = /<button[^>]*class="([^"]*)"/.exec(html);
  if (!m) throw new Error('aucun <button> rendu');
  return m[1]!.split(/\s+/);
}

const RETRAITS = [
  { inset: 'default', classe: 'px-4' },
  { inset: 'tight', classe: 'px-3' },
  { inset: 'none', classe: 'px-0' },
] as const;

describe('DisclosureButton — le retrait horizontal @cap:suivre-execution/ecran', () => {
  for (const { inset, classe } of RETRAITS) {
    it(`inset="${inset}" rend ${classe}, et aucun autre retrait`, () => {
      const html = renderToStaticMarkup(
        <DisclosureButton open={false} onClick={() => {}} inset={inset}>
          Détails
        </DisclosureButton>,
      );
      const classes = classesDuBouton(html);
      expect(classes).toContain(classe);
      for (const autre of RETRAITS) {
        if (autre.classe !== classe) expect(classes).not.toContain(autre.classe);
      }
    });
  }

  it('sans prop, le retrait vaut 16 px — le défaut historique du composant', () => {
    const html = renderToStaticMarkup(
      <DisclosureButton open={false} onClick={() => {}}>
        Détails
      </DisclosureButton>,
    );
    expect(classesDuBouton(html)).toContain('px-4');
  });

  it("le className de l'appelant est toujours rendu — il sert encore à tout le reste", () => {
    const html = renderToStaticMarkup(
      <DisclosureButton open={false} onClick={() => {}} inset="tight" className="h-8 py-0">
        Détails
      </DisclosureButton>,
    );
    const classes = classesDuBouton(html);
    expect(classes).toContain('h-8');
    expect(classes).toContain('px-3');
  });
});

// ---------------------------------------------------------------------------
// La garde : aucune source ne reprend le chemin qui ne marchait pas.

const NOM_BALISE = '<' + 'DisclosureButton';

/**
 * Les `className="…"` posés sur la balise ouvrante de chaque DisclosureButton
 * du fichier. Lit caractère par caractère en suivant la profondeur des `{}` :
 * un `>` d'une flèche (`onClick={() => …}`) vit à l'intérieur d'une accolade et
 * ne ferme donc pas la balise, ce qu'une expression régulière ne sait pas voir.
 */
export function classNamesSurLaBalise(source: string): string[] {
  const trouves: string[] = [];
  let i = source.indexOf(NOM_BALISE);
  while (i !== -1) {
    let depth = 0;
    let quote: string | null = null;
    let j = i + NOM_BALISE.length;
    for (; j < source.length; j += 1) {
      const c = source[j]!;
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    const balise = source.slice(i, j);
    for (const m of balise.matchAll(/className="([^"]*)"/g)) trouves.push(m[1]!);
    i = source.indexOf(NOM_BALISE, j);
  }
  return trouves;
}

function fichiersTsx(dir: string, out: string[] = []): string[] {
  for (const entree of readdirSync(dir)) {
    const complet = join(dir, entree);
    if (statSync(complet).isDirectory()) fichiersTsx(complet, out);
    else if (extname(entree) === '.tsx') out.push(complet);
  }
  return out;
}

describe('DisclosureButton — la garde du retrait', () => {
  it('aucune source ne passe un px-* par className : le retrait est une prop, pas une classe', () => {
    const fautes: string[] = [];
    for (const fichier of fichiersTsx(SRC_DIR)) {
      const source = readFileSync(fichier, 'utf8');
      if (!source.includes(NOM_BALISE)) continue;
      for (const valeur of classNamesSurLaBalise(source)) {
        if (/(^|\s)px-[\w.[\]/-]+/.test(valeur)) {
          fautes.push(`${relative(SRC_DIR, fichier)} → className="${valeur}"`);
        }
      }
    }
    expect(
      fautes,
      `Le retrait horizontal se règle avec inset="default|tight|none". Un px-* dans className ne gagne jamais sur celui du composant (#151) :\n${fautes.join('\n')}`,
    ).toEqual([]);
  });

  it('CONTRE-ÉPREUVE : la lecture de la balise voit un px-* et ignore ce qui suit', () => {
    const faute = `${NOM_BALISE} open={o} onClick={() => setO((v) => !v)} className="h-8 px-3">
        <span className="px-4">Détails</span>
      </DisclosureButton>`;
    expect(classNamesSurLaBalise(faute)).toEqual(['h-8 px-3']);

    const propre = `${NOM_BALISE} open={o} onClick={() => setO((v) => !v)} inset="tight" className="h-8 py-0">`;
    expect(classNamesSurLaBalise(propre)).toEqual(['h-8 py-0']);
  });
});
