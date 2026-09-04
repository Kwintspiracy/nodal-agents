### P0 — Oui : une racine réelle parente court-circuite encore la racine liée plus spécifique

- `packages/tools/src/verification/intent.ts:164-167`
- `apps/web/src/lib/code-projects.ts:123-125`
- `apps/web/src/lib/code-projects.ts:284-288`

**VÉRIFIÉ par lecture ; scénario DÉDUIT.** Avec `/reel/conteneur` et `/liens/app → /reel/conteneur/app`, l’appel `app/src/a.ts` produit côté outil la cible réelle `/reel/conteneur/app/src/a.ts`. Le `lexicalHit` la considère déjà sous `/reel/conteneur` et empêche son rebasage vers la racine liée plus spécifique : l’intention pose la clé `/reel/conteneur/app`. L’onglet Code résout le même chemin étiqueté sous `/liens/app` et dérive la clé `/liens/app`.