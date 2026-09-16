// depot.mjs — ce que le portail lit DANS L'ARBRE : les workflows, les parcours.
//
// Pourquoi ce fichier existe (revue de la PR #113, 2e passe) : ces deux
// fonctions vivaient dans `collect.mjs`, qui est un script — il s'exécute au
// chargement et écrit dans `apps/qa/data/`. Rien de ce qu'il contenait ne
// pouvait donc être testé, et le CÂBLAGE échappait entièrement aux tests :
// `lib.mjs` était éprouvé fonction par fonction, mais trois oublis de branchement
// laissaient toute la suite verte — ne plus passer la liste des parcours au
// parseur, oublier de reporter le drapeau « illisible » dans le rendu, ne plus
// retirer les commentaires du texte d'un workflow. Un parseur juste, mal
// branché, rend exactement les mêmes faux verts qu'un parseur faux.
//
// Les deux fonctions prennent donc la RACINE qu'elles lisent et les résultats
// Playwright qu'elles croisent, au lieu de les prendre dans leur propre module.
// `depot.test.mjs` les fait tourner sur un faux dépôt en dossier temporaire.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compterParcours,
  sortDuCas,
  intentionDunParcours,
  declencheursDunWorkflow,
  cadenceDe,
  parcoursDunWorkflow,
  cadenceParParcours,
  sansCommentairesYaml,
} from './lib.mjs';

/**
 * Ce que chaque workflow du dépôt déclenche, joue et mesure.
 *
 * `fichiers` est la liste des fichiers SUIVIS par git ; `tousLesParcours` les
 * noms des fichiers de parcours, dont un balayage a besoin pour savoir ce
 * qu'il prend.
 */
export function ciDuDepot(fichiers, tousLesParcours, racine) {
  const wfs = fichiers.filter((f) => f.startsWith('.github/workflows/') && /\.ya?ml$/.test(f));
  return wfs.map((f) => {
    // Sans les commentaires : nos workflows en portent plus que de YAML, et ils
    // NOMMENT ce dont ils parlent (`pnpm bench`, `--coverage`, un parcours).
    // Un paragraphe d'explication suffisait à déclarer une étape exécutée.
    const texte = sansCommentairesYaml(readFileSync(join(racine, f), 'utf8'));
    const jobs = [...texte.matchAll(/^ {2}([a-z0-9_-]+):\s*$/gim)].map((m) => m[1]);
    const declencheurs = declencheursDunWorkflow(texte);
    const parcours = parcoursDunWorkflow(texte, tousLesParcours);
    return {
      fichier: f,
      nom: (texte.match(/^name:\s*(.+)$/m)?.[1] ?? f).trim().replace(/^['"]|['"]$/g, ''),
      declencheurs,
      jobs,
      // Un workflow qui BALAIE les parcours en joue autant qu'un qui les
      // nomme — ne lire que les noms littéraux laissait le portail annoncer
      // « 2 en CI » pour toujours (revue Codex, PR #51).
      specsNommees: parcours.joues,
      balayeLesParcours: parcours.balaye,
      parcoursExclus: parcours.exclus ?? [],
      // La forme du workflow n'a pas été comprise. Ce n'est PAS « aucun
      // parcours » : c'est « on ne sait pas », et le portail le dit ainsi.
      parcoursIllisibles: parcours.illisible === true,
      cadence: cadenceDe(declencheurs),
      lanceBanc: /pnpm bench|@nodal-agents\/bench/.test(texte),
      lanceCouverture: /--coverage/.test(texte),
    };
  });
}

/** Les cas d'un rapport Playwright, rangés par fichier de parcours. */
function casParFichier(resultats) {
  const parFichier = new Map();
  if (!resultats?.suites) return parFichier;
  // `chemin` accumule les titres des `describe` traversés. Sans lui, seul le
  // titre du cas est connu — or une étiquette `@cap:` posée sur le describe
  // vaut pour tous ses cas, et c'est la façon la moins verbeuse de
  // l'écrire. La perdre reviendrait à exiger une étiquette par cas.
  const marcher = (suites, chemin = [], niveau = 0) => {
    for (const s of suites ?? []) {
      const f = s.file ? `apps/web/tests/e2e/${s.file}` : null;
      // Le niveau 0 est le FICHIER : son titre est le nom du fichier, déjà
      // porté par `fichier`. L'inclure doublerait chaque clé de la mémoire.
      const ici = niveau > 0 && s.title ? [...chemin, s.title] : chemin;
      for (const spec of s.specs ?? []) {
        if (!f) continue;
        const essais = (spec.tests ?? []).flatMap((t) => t.results ?? []);
        // Quatre sorts, gardés séparés : `vert`, `rouge`, `ignoré`,
        // `instable`. Les écraser en un booléen faisait passer 36 cas
        // IGNORÉS pour des régressions (revue Codex, PR #51) — le défaut même
        // que ce portail dénonce ailleurs.
        const sort = sortDuCas(essais);
        const duree = essais.reduce((n, r) => n + (r.duration ?? 0), 0);
        const b = parFichier.get(f) ?? { sorts: [], dureeMs: 0, cas: [] };
        b.sorts.push(sort);
        b.dureeMs += duree;
        b.cas.push({
          titre: spec.title,
          titreComplet: [...ici, spec.title].join(' '),
          sort,
          dureeMs: duree,
        });
        parFichier.set(f, b);
      }
      marcher(s.suites, ici, niveau + 1);
    }
  };
  marcher(resultats.suites);
  return parFichier;
}

/** Les parcours versionnés, avec qui les joue, à quelle cadence, et le dernier rapport. */
export function parcoursDuDepot(fichiers, workflows, { racine, resultats = null } = {}) {
  const specs = fichiers.filter(
    (f) => f.startsWith('apps/web/tests/e2e/') && f.endsWith('.spec.ts'),
  );
  // Qui joue quoi, et à quelle cadence. Un parcours joué chaque nuit n'est pas
  // joué à chaque PR : les confondre, c'est appeler « couvert » un parcours qui
  // ne garde aucune PR. Une seule définition, dans `lib.mjs` et sous test.
  const cadences = cadenceParParcours(workflows);
  // Un workflow illisible ne dit rien des parcours — surtout pas qu'ils sont
  // morts. Tant qu'il y en a un, aucune ligne ne porte le rouge « jamais joué ».
  const ciIllisible = workflows.some((w) => w.parcoursIllisibles);
  const parFichier = casParFichier(resultats);

  return specs.map((f) => {
    const nom = f.split('/').pop();
    const brut = parFichier.get(f) ?? null;
    const r = brut
      ? { ...compterParcours(brut.sorts), dureeMs: brut.dureeMs, cas: brut.cas }
      : null;
    let texte = '';
    try {
      texte = readFileSync(join(racine, f), 'utf8');
    } catch {
      /* le fichier est suivi mais absent de cette branche */
    }
    return {
      fichier: f,
      nom,
      cas: (texte.match(/^\s*test(\.\w+)*\s*\(/gm) ?? []).length,
      jouParLaCi: cadences.has(nom),
      cadence: cadences.get(nom) ?? null,
      ciIllisible,
      resultat: r,
      // La première phrase UTILE du fichier — voir `intentionDunParcours`.
      // La regex d'avant prenait la première ligne `//` du fichier, et rendait
      // `── Constants ─────` sous la moitié des parcours (Quentin, 13/09).
      intention: intentionDunParcours(texte),
    };
  });
}
