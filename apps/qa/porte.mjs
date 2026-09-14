// porte.mjs — refuse une PR qui casse le lien entre le produit et ses preuves.
//
// Elle tourne sur CHAQUE PR, là où aucun rapport d'exécution e2e n'existe. Elle
// ne juge donc pas des résultats : elle lit les titres des tests versionnés et
// vérifie deux choses, celles qui pourrissent en silence.
//
//   1. une étiquette `@cap:` qui ne désigne aucune capacité du registre — une
//      faute de frappe, ou un slug renommé sans que les tests suivent. Le test
//      continue de passer ; il ne prouve simplement plus rien, et rien ne le
//      dit ;
//   2. une capacité `exigee` que plus AUCUN test ne revendique — le cas du test
//      supprimé ou renommé qui emporte la preuve avec lui.
//
// Ce qu'elle ne fait PAS : rougir parce qu'un test échoue. La gravité d'un
// rouge est le sujet de l'issue #65. L'écrire ici en ferait une garde
// imaginaire — exactement le défaut que ce portail dénonce ailleurs.
//
//   node apps/qa/porte.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { CAPACITES } from './capacites.mjs';
import { capacitesDunTitre, titresDeTest, fautesDuRegistre, regrouperParCapacite } from './lib.mjs';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const EST_TEST = (f) => /\.(test|spec)\.(ts|tsx|mts|mjs)$/.test(f);

/**
 * Toutes les revendications du dépôt : une par couple (fichier, capacité).
 *
 * Le scan est TEXTUEL, et c'est délibéré : il n'exige ni build, ni base, ni
 * navigateur, donc il tient dans une porte de PR de quelques secondes. Son prix
 * est qu'il ne sait pas si le test passe — ce que la porte n'a de toute façon
 * pas à juger.
 */
export function revendicationsDuDepot(fichiers, lire) {
  const preuves = [];
  for (const f of fichiers) {
    if (!EST_TEST(f)) continue;
    let texte = '';
    try {
      texte = lire(f);
    } catch {
      // Suivi par git mais absent de cette branche : rien à en dire.
      continue;
    }
    // Dédupliqué par couple (capacité, NIVEAU) : un fichier qui prouve une
    // capacité à l'écran ET au moteur compte pour deux, sans quoi le second
    // niveau disparaîtrait du portail derrière le premier.
    const vus = new Map();
    for (const t of titresDeTest(texte)) {
      for (const { slug, niveau } of capacitesDunTitre(t)) {
        vus.set(`${slug}::${niveau ?? ''}`, { capacite: slug, niveau, origine: f });
      }
    }
    preuves.push(...vus.values());
  }
  return preuves;
}

function main() {
  const fichiers = execSync('git ls-files', { cwd: RACINE, encoding: 'utf8', maxBuffer: 64e6 })
    .split('\n')
    .filter(Boolean);

  const preuves = revendicationsDuDepot(fichiers, (f) => readFileSync(join(RACINE, f), 'utf8'));
  const fautes = fautesDuRegistre({ capacites: CAPACITES, preuves });
  const registre = regrouperParCapacite({ capacites: CAPACITES, preuves });

  const exigees = registre.filter((c) => c.exigee);
  const jamais = registre.filter(
    (c) => c.ecran.etat === 'absente' && c.moteur.etat === 'absente' && c.nonDit.length === 0,
  );
  const sansMoteur = registre.filter((c) => c.moteur.etat === 'absente');
  const sansEcran = registre.filter((c) => c.ecran.etat === 'absente');

  console.log(`Product capabilities : ${registre.length}`);
  console.log(`  required           : ${exigees.length}`);
  console.log(`  claims             : ${preuves.length} in the repository`);
  console.log(`  no screen proof    : ${sansEcran.length}`);
  console.log(`  no engine proof    : ${sansMoteur.length}`);
  console.log(`  no proof at all    : ${jamais.length}`);
  if (jamais.length > 0) {
    // Affiché sans faire échouer : c'est la liste de ce qu'on croit livré, et
    // elle est censée rétrécir. La transformer en échec dès aujourd'hui ferait
    // désactiver la porte demain.
    for (const c of jamais) console.log(`      · ${c.slug} — ${c.question}`);
  }

  if (fautes.length === 0) {
    console.log('\nThe product ↔ proofs link holds.');
    return 0;
  }

  console.error(`\n${fautes.length} fault(s):\n`);
  for (const f of fautes) {
    if (f.type === 'étiquette inconnue') {
      console.error(`  ✗ @cap:${f.slug} names no capability of the registry`);
      for (const o of f.origines) console.error(`      claimed by ${o}`);
      console.error(`      → fix the title, or add the capability to apps/qa/capacites.mjs`);
    } else {
      console.error(`  ✗ "${f.nom}" is required and no test proves it any more`);
      console.error(`      → write @cap:${f.slug} in the title of the test that proves it`);
    }
    console.error('');
  }
  return 1;
}

// Ne s'exécute que lancée en propre : `revendicationsDuDepot` est importée par
// les tests, et un `process.exit` au chargement d'un module les tuerait tous.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
