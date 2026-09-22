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
      <DisclosureButton open={false} onClick={() => {}} inset="tight" className="h-8">
        Détails
      </DisclosureButton>,
    );
    const classes = classesDuBouton(html);
    expect(classes).toContain('h-8');
    expect(classes).toContain('px-3');
  });

  // #399 — le retrait vertical, même raison : `py-3` écrasait un `py-2` ou un
  // `py-0` passé par className (mesuré dans #396 : 12 px rendus pour 8 demandés).
  it('insetY="none" rend py-0 et jamais py-3 ; sans prop, py-3', () => {
    const sans = classesDuBouton(
      renderToStaticMarkup(
        <DisclosureButton open={false} onClick={() => {}}>
          Détails
        </DisclosureButton>,
      ),
    );
    expect(sans).toContain('py-3');
    expect(sans).not.toContain('py-0');
    const none = classesDuBouton(
      renderToStaticMarkup(
        <DisclosureButton open={false} onClick={() => {}} insetY="none">
          Détails
        </DisclosureButton>,
      ),
    );
    expect(none).toContain('py-0');
    expect(none).not.toContain('py-3');
    const tight = classesDuBouton(
      renderToStaticMarkup(
        <DisclosureButton open={false} onClick={() => {}} insetY="tight">
          Détails
        </DisclosureButton>,
      ),
    );
    expect(tight).toContain('py-2');
    expect(tight).not.toContain('py-3');
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
      // Un commentaire dans une accolade (`{/* … */}`, ou `// …` en fin de
      // ligne d'une expression) n'est pas du code : une apostrophe qu'il porte
      // (« l'appelant ») n'ouvre pas de chaîne. Sans ceci, un commentaire à
      // nombre impair d'apostrophes faisait lire la garde au-delà de la balise
      // (#399).
      if (depth > 0 && c === '/' && source[j + 1] === '*') {
        const fin = source.indexOf('*/', j + 2);
        j = fin === -1 ? source.length : fin + 1;
        continue;
      }
      if (depth > 0 && c === '/' && source[j + 1] === '/') {
        const fin = source.indexOf('\n', j);
        j = fin === -1 ? source.length : fin;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    const balise = source.slice(i, j);
    for (const m of balise.matchAll(/className="([^"]*)"/g)) trouves.push(m[1]!);
    // Un `className={…}` (variable, gabarit, `cn(...)`) ne se lit pas : la garde
    // le rend TEL QUEL, avec son accolade, et le test le refuse — un retrait
    // caché dans une expression est exactement le trou que la garde annonce
    // fermer (Reviewer C, #156).
    if (/className=\{/.test(balise)) trouves.push('{expression}');
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
  it('aucune source ne passe un px-* ni un py-* par className : le retrait est une prop, pas une classe', () => {
    const fautes: string[] = [];
    for (const fichier of fichiersTsx(SRC_DIR)) {
      const source = readFileSync(fichier, 'utf8');
      if (!source.includes(NOM_BALISE)) continue;
      for (const valeur of classNamesSurLaBalise(source)) {
        if (valeur.startsWith('{')) {
          fautes.push(
            `${relative(SRC_DIR, fichier)} → className=${valeur} (une expression : la garde ne peut pas y lire le retrait ; écris la classe en toutes lettres)`,
          );
        } else if (/(^|\s)p[xy]-[\w.[\]/-]+/.test(valeur)) {
          fautes.push(`${relative(SRC_DIR, fichier)} → className="${valeur}"`);
        }
      }
    }
    expect(
      fautes,
      `Le retrait se règle avec inset="default|tight|none" et insetY="default|none". Un px-* ou un py-* dans className ne gagne jamais sur celui du composant (#151, #399) :\n${fautes.join('\n')}`,
    ).toEqual([]);
  });

  it('CONTRE-ÉPREUVE : la lecture de la balise voit un px-* et ignore ce qui suit', () => {
    const faute = `${NOM_BALISE} open={o} onClick={() => setO((v) => !v)} className="h-8 px-3">
        <span className="px-4">Détails</span>
      </DisclosureButton>`;
    expect(classNamesSurLaBalise(faute)).toEqual(['h-8 px-3']);

    const propre = `${NOM_BALISE} open={o} onClick={() => setO((v) => !v)} inset="tight" insetY="none" className="h-8">`;
    expect(classNamesSurLaBalise(propre)).toEqual(['h-8']);

    // #399 — un commentaire dans la balise avec UNE apostrophe : la lecture
    // s'arrête au `>` de la balise, et ne file pas jusqu'au prochain `'`.
    const commente = `${NOM_BALISE}
        open={o}
        {/* le retrait de l'appelant est une prop */}
        onClick={() => setO((v) => !v)}
        className="h-8">
        <span className="px-4">Détails</span>
      </DisclosureButton>`;
    expect(classNamesSurLaBalise(commente)).toEqual(['h-8']);
    const ligne = `${NOM_BALISE} open={o} onClick={() => {
          // l'appelant referme
          setO(false);
        }} className="h-8">
        <span className="px-4">Détails</span>
      </DisclosureButton>`;
    expect(classNamesSurLaBalise(ligne)).toEqual(['h-8']);

    // Une expression n'est pas lisible : elle ressort telle quelle, accolade
    // comprise, pour que la garde la refuse — un gabarit qui glisserait un
    // `px-3.5` battrait `inset="tight"` par l'ordre de la feuille.
    const cachee = `${NOM_BALISE} open={o} onClick={() => setO((v) => !v)} className={\`h-8 \${x}\`}>`;
    expect(classNamesSurLaBalise(cachee)).toEqual(['{expression}']);
    const fonction = `${NOM_BALISE} open={o} onClick={() => {}} className={cn('h-8', 'px-3')}>`;
    expect(classNamesSurLaBalise(fonction)).toEqual(['{expression}']);
  });
});
