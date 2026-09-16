## Constats qui tiennent

**1. Important — faux rouge : un projet déclaré sans manifeste peut disparaître de l’intention.**  
Dans [intent.ts:176](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/tools/src/verification/intent.ts:176), `expandWorkspaceRoots` utilise encore `hasMarker` seul.

Déclenchement : attacher un dossier déclaré `kind='code'`, sans manifeste ni sous-dossier, puis lancer une écriture par `run_command` avec ce dossier comme `cwd`. L’expansion retourne `[]`. L’intention devient `no_targets`, l’écriture passe, mais aucune ligne ne permet de marquer le projet `produced`. `declare_verification` refuse ensuite un travail réel comme jamais touché.

Reproduction en mémoire avec la fonction actuelle et une lecture de dossier simulée vide : `declaredEmptyRootExpanded: []`. Le correctif des projets déclarés ne couvre donc pas cette étape.

**2. Important — faux rouge : le registre peut rattacher le travail à une autre clé que celle vérifiée.**  
Dans [attach.ts:379](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/tools/src/projects/attach.ts:379), le troisième calcul utilise toujours `hasMarker`, sans les projets déclarés.

Déclenchement : racines attachées `C:/w` et `C:/w/app`, projet déclaré `app` sans manifeste, sous-dossier `app/src` portant un manifeste ; écrire `app/src/x.ts`.

Le résolveur actuel, exécuté en mémoire, donne :

- intention et observation : `c:/w/app` ;
- registre : `c:/w/app/src`.

Le registre peut déclarer `src` puis y rattacher un job encore sans projet et la conversation. L’état `produced` reste sur `app` : une déclaration de vérification pour le projet ainsi rattaché, `src`, est refusée faute de trace. Le partage annoncé entre les trois endroits n’est pas effectif.

**3. Important — faux rouge : une écriture de même taille peut être manquée sans contenu identique.**  
Dans [observed.ts:66](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/tools/src/verification/observed.ts:66), seuls `size` et `mtimeNs` sont comparés.

Déclenchement : réécrire un fichier avec un contenu **différent de même taille**, entre deux observations donnant le même horodatage. L’observation retourne « inchangé », puis `produced` reste faux si aucune production antérieure ne l’avait établi.

Ce n’est pas limité à « la même nanoseconde » : Node précise que la précision dépend de la plateforme ; FAT, par exemple, expose une résolution d’écriture de deux secondes. Le nom `mtimeNs` n’offre aucune garantie de résolution effective. [Documentation Node](https://nodejs.org/download/release/v22.17.0/docs/api/fs.html), [documentation Microsoft](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times).

**4. Important — faux vert d’autorisation : le shell sans écriture reste crédité. Résidu explicitement documenté.**  
Dans [observed.ts:104](C:/Users/kwint/AppData/Local/Temp/wt-revue-runtime/packages/tools/src/verification/observed.ts:104), chaque cible dossier soutient une clé sans observation.

Déclenchement : `run_command` exécute une commande réussie sans écriture, avec `cwd` sur un projet portant un manifeste. L’intention le marque `addressed`, puis l’observation déclarative autorise `produced=true`. La condition de production de `declare_verification` est satisfaite.

Cela ne rend pas automatiquement les tests verts ; cela accorde indûment le droit de déclarer leur configuration. La promesse générale « un outil menteur ne peut plus déclarer » dépasse donc la protection réellement livrée.

## Les treize questions

| Q | Verdict |
|---|---|
| **1** | **Le constat tient**, nº 3. Une précision d’une seconde suffit au faux rouge. Aucune mesure locale ne permet d’attribuer une résolution effective uniforme à NTFS, ext4, APFS, SMB/NFS ou aux différents volumes Docker Windows. |
| **2** | **Le constat de silence total est faux.** L’observation ne produit qu’un `console.warn` et conserve le succès de l’outil. Mais `declare_verification:177` retourne ensuite un refus explicite, avec une raison inexacte : l’outil aurait signalé un échec. La carte dépend d’`addressed`, pas de `produced` ; ce booléen ne bloque pas directement le job. |
| **3** | **Le constat tient au niveau du helper** : fichier présent puis absent → changement crédité. Aucun outil fichier de suppression n’est présent dans les surfaces examinées ; une suppression par shell emprunte déjà le contrat déclaratif du nº 4. Ce n’est donc pas un défaut supplémentaire démontré du parcours fichier actuel. |
| **4** | **Le constat est faux.** Ordre réel : résolution des cibles → intention → checkpoint (`execute.ts:639`) → empreinte (`660`) → outil (`662`). Aucun checkpoint intermédiaire ne produit le faux positif proposé. |
| **5** | **Le constat est faux pour les outils mutants du même tour.** Le passage parallèle exige `riskLevel === 'read'` (`apps/runner/src/job/execute.ts:3220`) ; les écritures passent dans la boucle séquentielle. |
| **6** | **Le constat tient partiellement**, nº 1 et 2. Le défaut déjà corrigé entre intention et observation des fichiers déclarés n’est pas revenu. Les clés de précaution issues de l’expansion sont volontairement exclues de `produced`. |
| **7** | **Le constat est faux concernant une différence de casse entre les clés finales.** Les deux chemins utilisent les résolveurs partagés et `projectKey`, y compris pour les documents. |
| **8** | **Le constat est faux aujourd’hui.** `document` et `office_file` partagent la canonicalisation fichier ; `outbound_action` et `other` sont refusés par l’intention avant exécution. Le filtre large ne crée donc pas actuellement le défaut envisagé. |
| **9** | **Le constat est faux.** `execute.ts:693` ignore le booléen retourné ; aucune branche ne change de sens. |
| **10** | **Le constat d’un cas atteignable est faux.** Si `mutationTargets` est non nul, `filesBefore` est une `Map`, même vide. Le `?? new Map()` est redondant actuellement. |
| **11** | **Le constat d’un appelant oublié est faux.** Un seul appel effectif trouvé : `execute.ts:693`, avec `observed`. Aucun appelant actuel n’utilise le contrat optionnel ancien. |
| **12** | **Le constat tient**, nº 4. Le shell reste couvert par le trou documenté. Les documents locaux évoquent bien le shell et `robocopy`, mais ne prouvent pas que l’incident historique précis de #60 était exclusivement un shell. |
| **13** | **Le constat de test factice ou instable est faux.** Le test remplace bien `tool.execute` par un menteur, mais traverse le vrai `executeTool` et vérifie les lignes d’état. Retirer le filtre rendrait `produced=true`. Le test voisin crée un fichier absent dans un dossier temporaire neuf : aucune dépendance à une différence de millisecondes. Son attente actuelle est bien `document`. |

Validation : lecture du commit et du code actuel, recherches des appelants, reproductions ciblées en mémoire. Aucune suite d’intégration exécutée dans cette session en lecture seule.

des constats