# Demande de review — PR #91 « La portée du jeton se lit aussi à la première connexion », post-merge

Commit `a70ae8dd`, mergé le 13/09 **sans passe Codex** (dette de revue,
issue #88). Il est dans `main`.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** ou **le
constat est faux**. « Ça a l'air bien » ne compte pas.

Lire `git show a70ae8dd`, puis `apps/web/src/components/ScopeDisclosure.tsx`,
`CredentialWizard.tsx`, `ConnectorAddForm.tsx`, `ConnectorForm.tsx`,
`ConnectorsMarketplaceGrid.tsx`, `packages/shared/src/connector-catalog.ts` et
le test `CredentialWizardScopeDisclosure.test.tsx`.

## Ce que la PR affirme

1. `ScopeDisclosure` est extrait en composant partagé ; le texte vient du
   catalogue (`scopeDisclosure`), jamais du composant. Rend `null` si vide.
2. `CredentialWizard` le rend **au-dessus de ses deux étapes** (`type` et
   `setup`), donc avant le bouton qui part chez le fournisseur.
3. Les **trois** écrans qui ouvrent l'assistant passent la portée : grille du
   catalogue, formulaire d'ajout, fiche d'un connecteur installé.
4. Preuve jsdom écrite avant, rouge avant, verte après, mutation vérifiée.
5. Le spec e2e `connector-scope-disclosure.spec.ts` n'est pas touché.

## Questions, par priorité

### P0 — tous les chemins, vraiment ?

1. **Énumérer les chemins.** Trouver TOUS les endroits du code qui rendent
   `CredentialWizard`. Y en a-t-il un quatrième (page Credentials, un lien
   profond, un `needsWizard` ailleurs, un retour d'OAuth) qui ne passe PAS
   `scopeDisclosure` alors qu'un connecteur est en jeu ? Un chemin oublié
   reproduit exactement le bug corrigé.
2. **Le chemin sans assistant.** Existe-t-il une route où l'utilisateur part
   chez le fournisseur SANS passer ni par `ConnectorAddForm` ni par
   `CredentialWizard` (bouton « Connect » direct, redirection serveur) ? Si
   oui, la promesse « la phrase apparaît sur chaque route » est fausse.
3. **`scopeDisclosure` manquant.** Un connecteur à portée large dont l'entrée
   de catalogue n'en déclare pas : rien ne s'affiche, silencieusement
   (invariant #4). Y a-t-il une garde ou un test qui l'empêche ? Lister les
   entrées de `connector-catalog.ts` sans `scopeDisclosure` dont les scopes
   OAuth dépassent le nom du connecteur.

### P1 — le rendu

4. L'import s'écrit avec l'extension (`.tsx`) dans le spécificateur. Est-ce la
   convention du dépôt ? Passe-t-il le build Next de PRODUCTION et le
   `moduleResolution` du tsconfig, ou est-ce toléré par hasard en dev ?
5. Frontière client/serveur : `CredentialWizard`, `ScopeDisclosure` et
   `Banner` sont-ils tous du même côté ? Une erreur ici casse au build de
   production sans casser en dev.
6. La divulgation est rendue au-dessus des DEUX étapes, donc aussi à l'étape
   « choix du type » où rien n'est encore choisi. Quand un connecteur est
   passé, `initialType` est-il toujours défini (donc l'étape 1 sautée) ? Sinon,
   la phrase décrit-elle une portée qui ne correspond pas au type que
   l'utilisateur va choisir ?
7. Le texte est-il en anglais partout ? La divulgation précède-t-elle le bouton
   dans l'ORDRE DU DOM (donc pour un lecteur d'écran), et pas seulement
   visuellement ?

### P2 — le test

8. Le test rend-il l'assistant par le chemin réel (« aucun identifiant ⇒
   assistant ») ou monte-t-il `CredentialWizard` directement avec la prop ? Le
   second ne prouve PAS que la grille du catalogue la passe.
9. L'ORDRE (divulgation avant le bouton) est-il vérifié par la position dans
   le HTML, ou seulement la présence ?
10. Les deux cas de bordure annoncés (Gmail : rien ; assistant ouvert depuis
    Credentials : rien) sont-ils testés, ou seulement affirmés dans le message
    de commit ?

## Hors périmètre

Les portées OAuth demandées à Google ; les specs de `apps/web/tests/e2e/`
(relus par ailleurs) ; style, nommage.

## Ce dont je doute moi-même

Q1 et Q2 : l'exhaustivité des chemins. Le bug d'origine EST un chemin oublié ;
rien ne garantit qu'il n'en reste pas un.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité bloquant /
important / mineur), puis les dix questions avec « tient » / « constat » /
« NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf » ou « des constats ».
