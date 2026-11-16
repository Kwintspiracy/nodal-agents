// pin.ts — LE build du moteur de rendu de pages que cette version de Nodal
// installe (#1082).
//
// Épinglé dans le code, jamais « la dernière stable » : chaque installation
// d'une même version de Nodal rend les pages de la même façon, et une version
// de Nodal qui change ce numéro apporte un nouveau build EXPRÈS, avec ses
// tests. Au démarrage qui suit une mise à jour, l'installateur voit que le
// build installé n'est plus celui-ci : il installe le nouveau et retire
// l'ancien (`installRenderer`).
//
// `chrome-headless-shell` est la version SANS FENÊTRE de Chrome for Testing,
// que Google publie pour l'automatisation : il n'a aucun code d'interface, il
// ne peut donc rien afficher sur l'écran de la personne. Le numéro suit la
// version de Chrome que `puppeteer-core` (épinglé dans package.json) pilote :
// 25.17.0 parle le protocole de Chrome 157 (`devtools-protocol` 0.0.1717327).
// Les deux bougent ensemble.
//
// Tailles mesurées le 15/11/2026 sur l'index de Google (stable 157) : win64
// 120 Mo à télécharger, environ 270 Mo une fois dépaqueté ; mac-arm64 99 Mo ;
// linux64 122 Mo.

/** Le build installé et piloté. Un changement ici est un changement de rendu. */
export const RENDERER_BUILD_ID = '157.0.8103.78';

/**
 * L'empreinte SHA-256 de l'archive de ce build, par plateforme (les noms de
 * `@puppeteer/browsers`). `installRenderer` la donne à `install`, qui refuse
 * une archive dont l'empreinte diffère : ce qui est installé est exactement ce
 * qui a été épinglé, quel que soit le chemin par lequel les octets arrivent.
 *
 * Relevées le 16/11/2026 sur les archives de Google
 * (`https://storage.googleapis.com/chrome-for-testing-public/<build>/<dossier>/
 * chrome-headless-shell-<dossier>.zip`, `curl … | sha256sum`). Elles changent
 * avec `RENDERER_BUILD_ID`, toutes ensemble.
 */
export const RENDERER_ARCHIVE_SHA256: Readonly<Record<string, string>> = {
  linux: 'f90329720fb61e5a76da9b6b509b6ad12a484c9c5df0359403e935177c6d153a',
  mac_arm: '17bf66d53c1b1104dcb641c5b331cd4ac5d200c778f5feed0934a0b92deaf8d6',
  mac: 'f1a6a9561eaf1f409849538de663695d36d72fbf1ebca4d42e47c7b5f2a157f3',
  win32: 'd9829c59dcc79d9e6e920f8ab841f2a9a055dcf54229d756ac0b42dfec303910',
  win64: '2138c1583d25d6f3abec5269943b2f430207d87a539895aa9e90cc4697ec0e1f',
};
