// hygiene-file-scope.mjs — quels contrôles d'hygiène s'appliquent à quel
// fichier. Une fonction PURE, pour que la règle se teste sans dépôt git.
//
// Pourquoi elle est sortie du script (revue post-merge de la PR #77). Le
// commentaire de l'exemption de taille affirmait : « Les données du portail
// sont exemptées de la règle de taille — et d'elle seule : NUL et UTF-16
// restent contrôlés. » C'était faux pour le fichier même qui a motivé
// l'exemption : `apps/qa/data/tests.ndjson`. L'extension `.ndjson` n'était pas
// dans `TEXT_EXT`, donc la boucle sortait AVANT les contrôles de contenu. La
// phrase décrivait une garantie que le code ne donnait pas.
//
// Un commentaire qui énonce une règle se vérifie. Celui-ci l'est maintenant
// par `scripts/tests/hygiene-file-scope.test.mjs`.

/** Fichiers texte — les seuls dont on inspecte le CONTENU (NUL, UTF-16). */
export const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|ndjson|md|mdx|css|scss|html|yml|yaml|sql|sh|txt|toml|env\.example)$/i;

/** Binaire par nature — jamais inspecté pour des NUL. */
export const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|webp|avif|svgz|woff2?|ttf|otf|eot|pdf|zip|tgz|gz|xlsx|docx|pptx|mp[34]|mov|wasm|node|bin|db|sqlite)$/i;

/** Au-delà, ce n'est presque sûrement pas de la source. */
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Les DONNÉES du portail qualité : écrites par la mesure nocturne (`qa.yml`),
 * sur `main`, jamais à la main. `tests.ndjson` porte un enregistrement par test
 * du dépôt — 7 372 lignes, 3,2 Mo le 12/09/2026 — et c'est voulu : c'est la
 * mémoire qui rend l'instabilité visible. La première nuit l'a poussé, et ce
 * contrôle a rougi TOUTES les PR qui suivaient, sur un fichier qu'aucune d'elles
 * ne touchait. Un contenu borné (une ligne par test, pas par exécution),
 * lisible, qui ne peut pas être « gitignoré » puisque le portail en ligne se
 * rend depuis le dépôt.
 */
export const SIZE_EXEMPT = /^apps\/qa\/data\/.*\.(ndjson|json)$/;

/**
 * Ce qu'on inspecte sur ce fichier, par son seul chemin.
 *
 * @param {string} file chemin relatif à la racine du dépôt, séparateurs `/`
 * @returns {{ binary: boolean, sizeChecked: boolean, contentChecked: boolean }}
 */
export function fileScope(file) {
  const binary = BINARY_EXT.test(file);
  return {
    binary,
    sizeChecked: !binary && !SIZE_EXEMPT.test(file),
    contentChecked: !binary && TEXT_EXT.test(file),
  };
}
