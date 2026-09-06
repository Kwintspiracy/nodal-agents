# Demande de review — PR #46, passe 5 (delta v7-A)

Les passes 1 à 4 ont relu PR① complète. **Cette passe ne relit que le delta
v7-A**, deux commits :

- `22255204` — le type de livrable vient du hook de l'outil, plus de littéral
  dans `intent.ts` ; vérificateur `office_file` côté runner ;
- `5198a8ee` — retrait de la reconnaissance d'extension dans `file_write` /
  `file_edit`.

Le reste de la PR a déjà été relu quatre fois ; le signaler à nouveau ne sert
qu'à masquer ce qui est neuf.

## Ce que le delta affirme

1. **Un outil déclare CE QU'IL PRODUIT.** `MutationTarget.deliverableType` est
   obligatoire ; un outil mutant ajouté sans le déclarer est une erreur du
   compilateur.
2. **Deux règles de canonicalisation, choisies par un `switch` exhaustif** sur
   `DeliverableType` (`packages/tools/src/verification/intent.ts`,
   `resolveDeliverables`) : `code_project` → le projet englobant ;
   `office_file` → le fichier lui-même.
3. **Un type déclaré sans règle est REFUSÉ** (`intent_type_unsupported`), donc
   l'écriture est refusée par le seam.
4. **Un fichier bureautique n'obtient pas de ligne `code_projects`** et n'a donc
   pas d'epoch — `verificationEpoch: null` dans l'issue.
5. **`office_file` a un vérificateur** qui rend toujours `not_configured`, pour
   que la finalisation ne lève pas `DELIVERABLE_TYPE_UNSUPPORTED`.
6. **`file_write` / `file_edit` déclarent toujours `code_project`** : ils
   écrivent du texte dans un dossier attaché.

## Ce dont je doute moi-même — à attaquer en priorité

### P0 — l'ordre de verrouillage à travers deux types

`resolveDeliverables` trie par `(deliverableType, key)`. Le verrou
`SELECT … FOR UPDATE` sur `code_projects` n'est pris que pour `code_project`,
et `'code_project' < 'office_file'` en ordre alphabétique, donc les clés
verrouillées restent croissantes entre elles.

**Est-ce que ça tient si un jour un autre type verrouille aussi
`code_projects` ?** Et : deux jobs concurrents dont l'un ne touche que des
`office_file` et l'autre les deux types — y a-t-il une séquence qui interbloque
ou qui viole l'ordre attendu par `finalize.ts` ?

### P0 — le refus d'un type non branché fait-il tomber un lot légitime ?

Si un hook rend des cibles de types MÉLANGÉS et qu'un seul est non branché,
`resolveDeliverables` lève et TOUT le lot est refusé : l'outil n'écrit pas.
Est-ce le bon arbitrage, ou faut-il poser l'intention sur les types connus et
refuser seulement l'inconnu ? Défendre une réponse, pas les deux.

### P1 — `resolveFileDeliverables` et l'appartenance au périmètre

`packages/shared/src/project-roots.ts`. Un fichier hors de tout dossier attaché
est ignoré. Vérifier :

- un fichier posé DIRECTEMENT à la racine attachée ;
- une racine qui est une racine de disque (`C:/`) ;
- un chemin UNC (`//srv/part/x.xlsx`) ;
- la casse : `projectKey` replie sur Windows seulement — deux écritures du même
  classeur doivent rendre UNE clé.

### P1 — `rebaseOntoLexicalRoots` après le passage au spread

Les deux `return` rendent maintenant `{ ...t, path }` au lieu de reconstruire
l'objet. Une cible qui gagnerait un champ demain le traverserait. Est-ce que ça
casse quelque chose aujourd'hui ?

### P1 — la copie d'écran

`apps/web/src/app/(dashboard)/code/[id]/VerificationSection.tsx` : un livrable
non `code_project` n'affiche plus « Add them on its project card in Code ». La
phrase de remplacement est-elle vraie pour TOUS les types non-code, ou seulement
pour `office_file` ?

### P2 — `runProof` du vérificateur `office_file` lève

Injoignable tant que `loadConfig` ne rend jamais `ready`. Garde ou code mort ?

## Hors périmètre

- Tout ce que les passes 1 à 4 ont déjà traité (outbox, primitive terminale,
  intention, UI de configuration).
- Le style, le nommage, la longueur des commentaires.
- Les vérifications réelles d'un document (ouvrir le classeur, feuilles,
  `#REF!`) : c'est v7-B, délibérément absent ici.

## Ce qui n'est PAS attendu

« Ça a l'air bien », « conforme aux bonnes pratiques », « je confirme ». Deux
verdicts valent : le constat tient, le constat est faux.

Un constat qui n'a pas pu être exécuté doit être rapporté comme **non exécuté**,
jamais conclu par lecture.
