# Demande de review — PR #84 (`qa/triage-parcours-rouges`), relue APRÈS merge

## Pourquoi cette demande existe

La PR #84 a été mergée dans `main` le 13/09 **sans passe Codex** — le binaire
était indisponible ce jour-là. La dette est suivie par l'issue #88. Les commits
sont dans `main` ; la branche `qa/triage-parcours-rouges` est conservée pour que
le périmètre reste lisible.

Conséquence pratique : un constat fondé ne se corrige pas « dans la PR », il se
corrige par une nouvelle PR. Rends donc des constats **exécutables** :
fichier, ligne, ce qui casse, dans quel cas.

## Le périmètre exact

Plage de commits : `62a73357..4186254c` (15 commits), sur la branche
`qa/triage-parcours-rouges`.

Fichiers concernés — **et rien d'autre** :

- `apps/web/tests/e2e/helpers.ts` (créé / considérablement étendu par cette PR)
- `apps/web/tests/e2e/*.spec.ts` (17 parcours Playwright)
- `apps/web/src/app/(dashboard)/llm-providers/LlmKeyForm.tsx` — **seul fichier
  de code produit touché** ; dis explicitement si ce changement est correct, et
  s'il était nécessaire pour réparer un parcours ou s'il a été emporté par
  mégarde.

## Ce que la PR affirme

1. Seize parcours e2e étaient rouges **pour de mauvaises raisons** : ils
   visaient une interface qui n'existe plus (page Connecteurs refondue : onglets
   « Installed » / « Library », tableau au lieu de cartes, un seul bouton
   « Install » ou « Add account »), ou des valeurs par machine devenues fausses
   (port Postgres, mot de passe, adresse de l'utilisateur courant).
2. **Aucune fonctionnalité produit n'était cassée.** Les parcours ont été
   réparés, pas le produit.
3. Deux parcours **sans objet** sur cette installation se déclarent désormais
   ignorés (`test.skip` avec une raison), au lieu de rougir.
4. Les gestes partagés de la page Connecteurs sont écrits **une seule fois**
   dans `helpers.ts`, pour qu'une prochaine refonte casse un endroit et non
   dix-sept.

## Questions, par priorité

### P0 — un test qui ne prouve plus rien

1. **Données d'assertion pré-seedées.** Cherche tout endroit où le test écrit en
   base (ou via une API) la donnée même qu'il ira ensuite affirmer avoir été
   produite par le parcours. Un `insertMemory` / `insert...` de *fixture* est
   légitime ; un `insert` de la *cible d'assertion* vide le test de son sens.
   `helpers.ts` porte des avertissements en ce sens sur `insertMemory` et
   `cleanCredentialsByType` — **vérifie qu'ils sont respectés par les appelants**,
   ne te contente pas de les lire.
2. **Assertions affaiblies.** Un parcours « réparé » en remplaçant une
   assertion forte par une faible (`toBeVisible` sur un conteneur générique,
   `expect(x).toBeTruthy()`, une regex si large qu'elle matche la page d'erreur)
   est une régression déguisée en réparation. Compare AVANT/APRÈS commit par
   commit.
3. **`test.skip` sans raison réelle.** Chaque garde doit dire une condition
   d'environnement vraie et vérifiable (« aucun agent sur cette installation »),
   pas masquer un échec. Signale toute garde dont la condition serait vraie
   *toujours* — un test ignoré en permanence est un test supprimé qui se cache.
4. **Étiquettes `@cap:<slug>/ecran`.** Ces étiquettes vivent dans les TITRES et
   nulle part ailleurs (voir `CLAUDE.md`). Une étiquette perdue, déplacée hors
   d'un titre, ou dont le slug a changé pendant la réparation, fait mentir le
   portail qualité. Compare la liste des étiquettes avant et après la plage.

### P1 — les gestes partagés

5. **`cleanCredentialsByType`** (`helpers.ts`). Le message de commit dit qu'un
   filtre sur le type avait été retiré, faisant de ce nettoyage une purge de
   TOUS les identifiants du propriétaire — y compris, sur une machine de
   développeur en local-trust, ses vrais comptes. Le filtre est-il correctement
   rétabli ? Les appelants passent-ils le bon type ? Reste-t-il ailleurs dans
   les parcours un `delete` sur `credentials` sans filtre équivalent ?
6. **`resolveActingUser`.** La sonde est comportementale (`/api/auth/get-session`
   répond ou non) et non déclarative. Cas où elle se trompe : que se passe-t-il
   si l'endpoint répond 200 mais que la pile est en local-trust, ou l'inverse ?
   L'échec est-il bruyant dans tous les cas, ou existe-t-il un chemin où la
   fonction rend un utilisateur du MAUVAIS mode ?
7. **Les sélecteurs de `helpers.ts`.** `openConnectorInstallDialog` cherche
   `/^(install|add account)$/i` ; `removeInstalledConnectorIfPresent` cherche
   `/^(delete|disconnect)$/i` et attend `« <nom> removed »`.
   `installedConnectorRow` filtre les `row` par `hasText`. Questions :
   ces sélecteurs peuvent-ils matcher **plusieurs** éléments (et donc
   `strict mode violation`, ou pire, cliquer le mauvais) ? `hasText` sur un nom
   court peut-il attraper une ligne voisine ? Un parcours recopie-t-il encore
   ces gestes au lieu de passer par le helper — ce que la PR dit avoir éliminé ?
8. **`resolveDbUrl`.** Lit le port en ligne 4 de `postmaster.pid` et le mot de
   passe dans `config.json`. Le repli `password = 'nodalai'` n'est-il PAS un
   repli silencieux (invariant #4) ? Que vaut le code si `postmaster.pid`
   existe mais appartient à un cluster ARRÊTÉ ?

### P2 — attente et stabilité

9. **`waitForTimeout`.** La PR affirme les avoir retirés des parcours qu'elle
   touche. Il en reste dans `agents-redesign.spec.ts`, `thread-autoscroll.spec.ts`
   et `global-setup.ts` : lesquels sont dans le périmètre de la PR (donc une
   affirmation fausse), lesquels lui préexistent et n'ont pas été touchés ?
10. **`networkidle`.** `openConnectorLibrary` / `openInstalledConnectors`
    attendent `networkidle` à 15 s. Sur une page qui garde une connexion ouverte
    (SSE, polling), `networkidle` n'arrive jamais. Est-ce le cas de
    `/connectors` ? Si oui, l'attente est un timeout déguisé.
11. **Fuites de connexion.** Les helpers DB ouvrent un client et le ferment en
    `finally`. Y a-t-il un chemin (throw avant le `try`, `resolveActingUser`
    appelé DANS un `try` qui possède déjà un client) où un client reste ouvert ?

## Hors périmètre

- `packages/tools`, `apps/runner`, `apps/qa` — d'autres relectures sont en cours
  dessus en parallèle.
- Tout code produit **sauf** `LlmKeyForm.tsx`.
- La question « ces parcours passent-ils » : le rejeu est de mon côté, pas du
  tien. Ne conclus jamais un résultat d'exécution par lecture.

## Ce qui n'est PAS attendu

Style, nommage, formatage, longueur des commentaires, préférence pour telle
API Playwright plutôt que telle autre. La langue des commentaires (français)
est un choix assumé du dépôt.

## Ce dont je doute moi-même — dis-le franchement

- **Le `tsconfig` d'`apps/web` exclut toujours `tests`.** Rien dans cette PR ne
  l'a changé. Donc `tsc --noEmit -p apps/web` ne type-vérifie AUCUN de ces
  fichiers, et `helpers.ts` — 600 lignes, requêtes Drizzle typées, `as` divers —
  n'a jamais été compilé. Est-ce que ça se voit ? Y a-t-il dans ces fichiers une
  erreur de type qu'un compilateur aurait attrapée ? C'est la question que je
  place en tête de mes propres doutes.
- **La refonte des sélecteurs a-t-elle été faite par lecture de l'interface ou
  par exécution ?** Si un sélecteur est faux, il ne se voit qu'au rejeu — et
  cette PR n'a pas été rejouée en entier.
- **Les deux parcours « sans objet »** : est-ce vraiment « sans objet », ou
  est-ce un échec produit qu'on a rangé sous le tapis ? C'est le constat que
  j'aimerais le plus me voir contredire.

## Forme attendue du rapport

Un fichier Markdown. Pour chaque constat :

```
### [P0|P1|P2] Titre court
- Fichier : chemin:ligne
- Ce qui casse : …
- Dans quel cas : …
- Preuve : l'extrait de code, ou la comparaison avant/après
```

Deux verdicts seulement : **le constat tient** ou **le constat est faux**.
Sont interdits : « ça a l'air bien », « conforme aux bonnes pratiques »,
« je confirme ». Si tu n'as rien trouvé sur un axe, écris-le en une ligne et
passe au suivant.

Tu es en **lecture seule** : tu ne peux rien exécuter. Tout ce que tu n'as pas
pu vérifier se rapporte comme **NON VÉRIFIÉ**, jamais comme conclu.
