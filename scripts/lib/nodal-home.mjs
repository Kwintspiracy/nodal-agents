// nodal-home.mjs — le dossier de Nodal pour les scripts du dépôt.
//
// LA MÊME RÈGLE que le produit, pas une copie : ce module ré-exporte
// packages/shared/src/nodal-home.ts tel quel. Node ≥ 24 (la version du dépôt,
// `engines`) retire lui-même les types d'un fichier .ts importé, et ce fichier-là
// n'importe que des modules `node:` : aucun outil de build entre les deux. Une
// variable vide, relative ou relative au lecteur fait donc échouer le script
// avec le même message que le CLI, jamais un repli sur `~/.nodalai`.

import {
  NODAL_HOME_OVERRIDES,
  NODALAI_HOME_ENV,
  defaultNodalHome,
  nodalHome,
  nodalHomeEntry,
  nodalHomePath,
} from '../../packages/shared/src/nodal-home.ts';

export {
  NODAL_HOME_OVERRIDES,
  NODALAI_HOME_ENV,
  defaultNodalHome,
  nodalHome,
  nodalHomeEntry,
  nodalHomePath,
};

/**
 * L'environnement d'un enfant dont la Nodal doit vivre sous `homeDir` et nulle
 * part ailleurs (les smoke tests) : dossier personnel isolé, `NODALAI_HOME`
 * posé sur le dossier par défaut de ce dossier personnel, et chaque variable
 * étroite héritée du shell du développeur RETIRÉE — sans quoi elle enverrait la
 * base ou les workspaces de l'essai dans l'instance du développeur.
 */
export function isolatedNodalEnv(base, homeDir) {
  const env = {
    ...base,
    HOME: homeDir,
    USERPROFILE: homeDir,
    [NODALAI_HOME_ENV]: defaultNodalHome(homeDir),
  };
  for (const variable of Object.values(NODAL_HOME_OVERRIDES)) delete env[variable];
  return env;
}
