## Constats

- **R1 — bloquant — `apps/runner/src/verification/document.ts:76`.** C1 conserve un vert périmé lorsque taille et `mtimeNs` restent identiques. Déclenchement : prouver `# ok\n`, puis remplacer par `oops\n` après la lecture UTF-8, dans le même intervalle de résolution du mtime. La preuve reste verte et les deux `manifestHash` sont identiques ; `finalize.ts:488` ne détecte rien. Reproduit en mémoire avec le vrai vérificateur et des métadonnées identiques simulées. C’est le résidu annoncé du correctif, pas une nouvelle régression ; il empêche néanmoins de considérer C1 comme entièrement fermé.

- **R2 — important — `apps/runner/src/verification/document.ts:136`.** Le retrait des clôtures Markdown produit des faux verts **et** des faux rouges. Avec `/m`, l’alternative `$` termine la correspondance dès une fin de ligne :
  - `"```\ntexte\n# faux\n```\n"` retourne **green**, sans titre hors code ;
  - `"```\ntexte\n# faux\n"` retourne également **green** ;
  - `"```\ntexte\n````\n# vrai\n"` retourne **red**, alors que la clôture plus longue est autorisée et que le titre est extérieur. [CommonMark](https://spec.commonmark.org/spec#fenced-code-blocks)
  
  Les verdicts sont reproduits avec le vrai `runProof`, fichiers simulés en mémoire. Les tests actuels placent le faux titre immédiatement après l’ouverture et le vrai titre avant le bloc : ils évitent ces défauts.

- **R3 — important — `apps/runner/src/verification/document.ts:372`.** C6 fait rougir du XML bien formé utilisant une entité interne déclarée. Déclenchement : `<!DOCTYPE svg [<!ENTITY x "bonjour">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`. Le parseur installé rapporte `entity not found:&x;` ; le nouveau filtre transforme cette limitation du parseur en verdict **red**. Reproduit sur `runProof`. La déclaration interne rend pourtant cette référence licite. [XML 1.0](https://www.w3.org/TR/xml/#sec-internal-ent)

- **R4 — important — `packages/tools/src/verification/intent.ts:176`.** C4 oublie `expandWorkspaceRoots`, qui conserve `hasMarker` seul. Déclenchement : projet `/w/app` déclaré, attaché, sans manifeste ni sous-dossier visible ; cible dossier `/w/app` d’un outil mutant. La résolution adressée trouve `/w/app`, puis l’expansion supprime la cible ; l’intention retourne `no_targets` à la ligne 567. L’observation, elle, trouve `/w/app`. Reproduit sur les fonctions extraites : intention `[]`, observation `[/w/app]`. Une mutation peut donc partir sans salir le projet déclaré.

- **R5 — important — `apps/web/src/lib/code-projects.ts:198`.** C4 laisse l’écran Code calculer une autre identité. Avec `/w` et `/w/app` attachés, `/w/app` déclaré sans manifeste, et une écriture `/w/app/src/x.ts`, intention et observation retiennent désormais `/w/app`, mais `projectUnderWorkspace` retourne toujours `/w/app/src`. Reproduit sur les fonctions actuelles. Cette dérivation alimente la liste (`actions.ts:12398`) et le détail (`actions.ts:13030`) : la session est présentée sous un autre projet que celui vérifié.

## Les douze questions

1. **tient.** Sur ce Windows, taille et `mtimeNs` sont restés identiques pendant 100 lectures réelles. L’atime est distinct du mtime. Une modification explicite des dates peut provoquer un rejet conservatif, mais aucune preuve d’un « vert éternellement impossible ». Les comportements propres à OneDrive/Dropbox restent **NON TRANCHÉS**. [Microsoft — File Times](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times)

2. **constat — R1.** Un hash du contenu est préférable pour fermer ce résidu. Mesure locale : lecture et SHA-256 d’un fichier de 2 770 octets, moyenne de **0,106 ms**, soit environ **0,21 ms pour deux lectures**, sur 200 itérations avec cache chaud. Ce n’est pas une mesure de stockage distant.

3. **constat — R4, R5.** Deux chemins restent incohérents. `attach.ts` conserve aussi `hasMarker`, mais filtre ensuite les racines sans manifeste et rattache aux projets déclarés : sa seule présence ne prouve pas un défaut supplémentaire. `written-file-type.ts` décide du type ; `finalize.ts` reprend la clé persistée.

4. **NON TRANCHÉ.** Le supplément est bien de deux lectures du registre par appel concerné, donc 100 requêtes pour 50 écritures. Aucun benchmark DB effectué. Un cache par tour peut devenir périmé après une déclaration pendant ce tour ; partager un instantané par appel réduirait les lectures, mais nécessite de définir explicitement comment gérer les changements concurrents.

5. **tient**, pour la compatibilité annoncée. Les insertions et mises à jour actuelles remplissent `displayPathSnapshot`. La colonne reste nullable et aucun rattrapage des anciens états n’est ajouté. Le repli sur la clé conserve donc l’ancienne limitation de casse ; un code explicite rendrait ce cas observable. La présence effective d’anciens états nuls est **NON TRANCHÉE**.

6. **constat — R2.** La clôture plus longue et le bloc non refermé sont mal traités. Quatre espaces devant `# faux` sont correctement refusés. Une tabulation devant ce titre reste acceptée à tort ; cette dernière limitation préexistait au correctif.

7. **tient.** Le commentaire est consommé intégralement par `indexOf('*/')` avant que la boucle ne visite son contenu. `/* \*/ .a {}` passe ; l’antislash ne mange pas la fermeture. Un antislash terminal termine également la boucle sans débordement ni blocage.

8. **tient**, pour les cas demandés. `<svg><style>.a{} </svg>` retourne explicitement `<style> … is never closed (end of file)`. `<svg><title>Bonjour</title></svg>` passe sans imposer le mode texte brut à `title`.

9. **constat — R3.** La DTD interne avec entité déclarée manque aux tests. `xml:lang` passe. Un préfixe non déclaré est refusé ; ce dernier cas ne constitue pas un SVG correctement namespacé.

10. **tient**, pour l’existence d’un test discriminant par constat, **pas pour une couverture complète**. C2 affirme réellement le `subject` et possède un test de finalisation dont la clé désigne un fichier inexistant. C3 couvre `file_write`, mais ne démontre pas séparément le déplacement dans `file_edit`. C5 et C6 laissent passer R2 et R3 ; C4 ne couvre ni R4 ni R5. Suites non exécutées dans ce sandbox en lecture seule ; tests lus et sondes exécutées en mémoire.

11. **tient.** Le test C1 ne modifie aucune génération DB et conserve `epoch: 0` : son rejet dépend bien du changement de `manifestHash`. Limite : l’écriture intervient **avant** la lecture du vrai vérificateur, pas après sa capture du contenu ; il prouve la comparaison, sans reproduire exactement une preuve devenue périmée après lecture.

12. **constat — R4, R5.** Le test affirme le triplet exact `['code_project', keyOf(app), true]`, ce qui lie effectivement les deux calculs pour cette écriture fichier. Il ne couvre ni l’expansion des cibles dossier ni la dérivation de l’écran Code.

des constats