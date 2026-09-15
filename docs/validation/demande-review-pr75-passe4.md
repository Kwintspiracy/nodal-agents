# Demande de review — dette de la PR #75, passe 4

Passe 3 : trois constats, tous fondés, tous corrigés.

- **1** — le troisième état distinguait le refus de LIRE, pas celui de `stat`.
  Seuls `ENOENT` et `ENOTDIR` sont désormais une absence ; tout le reste est
  illisible, donc ni crédité ni tu.
- **2** — le cache de 60 s du scan rendait l'ANCIENNE identité après une
  déclaration. Les déclarations sont lues avant le cache et leur signature en
  fait partie ; le test ne vide plus le cache entre les deux appels.
- **3** — trois commentaires qui annonçaient une exclusivité que le code n'a
  plus. `declared.ts` nomme maintenant les six calculs, et dit lesquels passent
  par lui et lesquels refont la règle faute de pouvoir dépendre de `tools`.

Cette passe relit `83528382`, `9d11c9e0` et le commit de commentaires.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les correctifs existent-ils ? Cite les lignes.
2. **Reste-t-il un FAUX VERT** dans la chaîne « écriture constatée → `produced`
   → `declare_verification` » ? C'est le seul sens qui compte ici.
3. La signature des déclarations dans le cache suffit-elle ? Un autre geste de
   propriétaire change-t-il l'identité des projets sans passer par cette table,
   ou par cette colonne ? (masquage, renommage, `kind`, dé-déclaration.)
4. `estAbsence` a-t-il oublié un code d'erreur qui veut bien dire « absent » —
   sur Windows en particulier, où les codes ne sont pas ceux de POSIX ?

### P1

5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

L'issue #102 ; les cinq autres PR de la dette ; `apps/qa` ;
`apps/web/tests/e2e` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les six questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
