// @nodal-agents/test-kit — le socle de test réutilisable de Nodal-Agents.
//
// Trois harnais, chacun issu d'un manque que l'audit du 07/08/2026 a exposé :
//
//   builders        — fini les 40 lignes de RunnerEnv recopiées d'un test à
//                     l'autre. Une seule définition de « normal », et le test ne
//                     dit plus que ce qui en diffère.
//   gate            — le branchement le plus conséquent du produit (un outil
//                     s'exécute-t-il sans humain ?) devient une ligne, et
//                     « dans les quatre modes d'autonomie » devient l'option la
//                     moins chère à écrire plutôt que celle qu'on saute.
//   trust-boundary  — INJECT-001 se prouvait par grep. Un grep n'est pas un
//                     test : une frontière ajoutée demain arrive désormais avec
//                     la question déjà posée.
//   architecture    — les scanners d'invariants, une fois, au lieu de quinze
//                     copies qui peuvent diverger.
//   real-postgres   — un VRAI Postgres à deux connexions pour les tests de
//                     course ; PGlite sérialise tout et ne prouve aucun verrou.
//
// Ce paquet est privé et ne part jamais dans le tarball : il n'est référencé que
// par des devDependencies.

export * from './types';
export * from './builders';
export * from './gate';
export * from './trust-boundary';
export * from './architecture';
export * from './real-postgres';
