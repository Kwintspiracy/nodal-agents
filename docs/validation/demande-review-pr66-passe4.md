# Demande de review — dette de la PR #66, passe 4

Passe 3 : cinq constats (R1 bloquant, R2-R5 importants), tous vrais, tous
corrigés dans `d7f7456d`. Deux d'entre eux ont changé la FORME du correctif,
pas seulement sa valeur.

Cette passe relit `d7f7456d`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show d7f7456d`, le rapport de la passe 3
(`docs/validation/rapport-review-pr66-passe3.md`), puis
`apps/runner/src/verification/document.ts`, `types.ts`,
`apps/runner/src/job/finalize.ts` et les deux fichiers de tests.

## Ce que la passe 3 a changé

| Constat | Correctif |
|---|---|
| R1 | `ProofResult.provedManifestHash` : la finalisation compare à ce que la preuve a **lu**, plus à la configuration relue. A → B → A est fermé. Le test C1 décrivait le mauvais danger (une écriture AVANT la preuve n'en est pas un) — réécrit, plus un test A→B→A. |
| R2, R3 | La regex des blocs clôturés est SUPPRIMÉE. Une boucle de lignes applique les règles CommonMark telles quelles, et **blanchit** les lignes au lieu de les retirer (plus de titre setext fabriqué). Quinze cas figés. |
| R4, R5 | Le DOCTYPE n'est plus consulté. Le message du parseur NOMME l'entité ; on ne fait taire la plainte que si CETTE entité est déclarée. |

## Questions, par priorité

### P0

1. Les correctifs existent-ils dans `d7f7456d` ? Cite la ligne de chacun.
2. **`provedManifestHash`.** Le vérificateur de PROJET DE CODE ne le rend pas :
   la comparaison retombe sur la configuration pour lui. Est-ce correct — son
   `epoch` partagé suffit-il — ou vient-on de créer deux régimes dont l'un est
   plus faible sans que ce soit dit ?
3. **La boucle de lignes.** Sonde-la encore, sur ce que je n'ai pas couvert :
   un bloc clôturé à l'intérieur d'un élément de liste, une ligne d'info
   contenant des tildes pour une ouverture en tildes, un CRLF résiduel, un
   fichier qui commence par un bloc non clôturé et ne contient rien d'autre,
   une clôture suivie d'espaces puis d'un commentaire HTML.
4. **`isDeclaredEntityComplaint`.** Le message du parseur a-t-il toujours cette
   forme ? Sonde `@xmldom/xmldom` sur plusieurs entités inconnues et vérifie que
   le nom est bien extrait. Et : une entité déclarée DANS un commentaire
   (`<!-- <!ENTITY x "..."> -->`) fait-elle taire la plainte — c'est le trou que
   j'ai laissé et nommé ; est-il acceptable ?

### P1

5. Reste-t-il, dans les douze correctifs de cette branche, un comportement que
   la passe 1 avait jugé cassé et qui repasserait sans faire rougir un test ?
6. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

7. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les six autres PR de la dette (#75, #73, #74, #91, #87, #77) — ensuite,
séparément ; les constats R4/R5 de ta passe 2 sur `intent.ts` et
`code-projects.ts` (la dérivation de l'écran Code) : hors du périmètre de #66,
je les porterai en issue ; `apps/qa` ; style, nommage.

## Ce dont je doute moi-même

La question 2. J'ai ajouté un champ que SEUL le vérificateur de document
remplit. Si le vérificateur de projet en a besoin aussi et que personne ne le
voit, j'ai créé une asymétrie silencieuse — exactement ce que la passe 1
reprochait au reste.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les sept
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
