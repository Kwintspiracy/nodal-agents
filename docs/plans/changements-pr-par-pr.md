<!-- artifact: https://claude.ai/code/artifact/7db1c546-af55-4706-9e76-116746dc727f -->

# Ce qui a changé, PR par PR — lot du 22/08/2026

Construit depuis `git log b9ec625..main` : **29 commits**, dont 14 de code. Rien
n'est reconstitué de mémoire ; chaque ligne renvoie à un commit réel.

Le point de départ est `b9ec625`, le merge de la PR #6.

---

## PR #9 — Catalogue de modèles

*Branche `fix/misc`. 5 commits, ~525 lignes.*

| Commit | Ce qui change |
|---|---|
| `04ee015` | **Gemini 3.7 Flash au catalogue**, natif et OpenRouter. Identifiant, outils, niveaux de réflexion et fenêtre de 1M vérifiés à la source. Ajout de 3.6 et 3.7 à la liste vision |
| `0edacd1` | **Prix OpenRouter faux d'un facteur 2** : 3.7 passe de 0,75/3,75 à 0,375/1,875 ; 3.6 de 1,5/7,5 à 0,75/3,75. Niveau d'effort `max` retiré (inexistant). **Liste vision régénérée** : 11 identifiants manquaient, dont `claude-opus-5` |
| `6cd8761` | Le script de rafraîchissement **refusait à tort** dès qu'une source tombait : mesuré, `models.dev` seul couvre 54/54 et OpenRouter 33/54. Le critère devient la **couverture**, pas le nombre d'échecs. `mandatory: true` remis — son absence faisait apparaître un réglage `Off` que ces modèles refusent |

**Trouvé et corrigé au passage** : le script imprimait une liste **vide** en sortant en code 0 quand le réseau tombait. Coller cette sortie aveuglait tous les modèles d'un coup.

**Ce que j'avais affirmé et qui était faux** : « le modèle phare était aveugle ». Mesuré en exécutant la vraie expression de décision : **8 modèles sur 11**, et aucune des trois formes natives que j'avais nommées.

---

## PR #7 — Poste de développement

*Branche `feat/dev-posture`. 7 commits, ~1 500 lignes.*

| Commit | Ce qui change |
|---|---|
| `08fffc9` | **Continuité de session** pour `code_task` : une reprise au lieu d'un départ à froid. Clé `code_task:<jobId>:<cwd>`, échappatoire `fresh: true`. La forme d'argv de reprise de Codex est une **sous-commande**, pas un drapeau — un test verrouille les deux formes |
| `c22f25b` | **Conscience du dépôt** : branche, état, racine, HEAD, sondés au démarrage du job et rendus dans l'étage **volatile** du prompt (le stable est mutualisé entre jobs — une branche y serait servie périmée) |
| `644cf7e` | **Points de restauration** : nouveau paquet `@nodal-agents/checkpoints`, magasin git fantôme, instantané avant chaque écriture, commande CLI pour lister et restaurer. Un instantané qui échoue **refuse** l'écriture |
| `ec082fb` | Les **4 constats** de la review : le mauvais workspace était photographié ; les fichiers ignorés ne sont pas protégés (tranché et documenté) ; la séparation des sessions était correcte **par chance** ; la sonde git annonçait « clean » après un échec |
| `fb13001` | Les **2 constats** de la passe 2, tous deux causés par mes correctifs : la limite des checkpoints restait invisible ; un workspace injoignable bloquait les écritures **partout** |

**Le constat le plus grave** : `execute.ts` photographiait `workspaces[0]`, jamais la cible réelle. Un agent tenant `[docs, code]` écrivant dans `code/` obtenait un instantané de `docs`, l'écriture passait, et restaurer ne rendait rien.

---

## PR #8 — Le runtime CLI

*Branche `fix/harness-bugs`. 12 commits, ~700 lignes de code.*

| Commit | Ce qui change |
|---|---|
| `cf51342` | **Le bug signalé** : un agent en runtime CLI recevait `personality` **brut**. Il ne voyait ni son équipe, ni sa mémoire, ni ses skills. Passe désormais par `buildSystemPrompt` |
| `023cb0e` | Trouvé en me relisant : un cast `as never` faisait **disparaître la ligne d'identité** du prompt et passait `undefined` à `buildBaselineBlock`. En retirant le cast, le typecheck a sorti **8 erreurs réelles** |
| `f4850e3` | **Des faits, plus des ordres.** Mesuré : le prompt faisait 22 176 caractères et nommait **23 fois** des outils absents, aucune comme un fait. Après : **4 789 caractères, 0 mention**, sous-agent toujours visible |
| `ad01a30` | Les 2 constats de la passe 2, dont **une affirmation fausse de ma part** : j'avais supprimé le baseline en entier en écrivant qu'il était « entièrement » bâti autour des builtins |
| `5e8ffd6` | **Conclusion des 3 passes** : aucun contenu catalogue sur cette surface. Les règles sont portables, la prose qui les porte ne l'est pas |
| `5486f43` | L'asymétrie roster gardé / skills retirés est **une décision**, inscrite dans le code pour ne pas être relue comme un oubli |

**Ce que le plan de test a établi, mesuré et non déduit** : un agent CLI **ne peut pas déléguer**. L'argv porte `--strict-mcp-config` et un `--disallowedTools` purement **soustractif** ; rien ne peut ajouter un outil à la session.

---

## Hors PR — outillage et discipline

| Commit | Ce qui change |
|---|---|
| `25d2888` | **`.claude/` était ignoré** : les skills n'étaient pas versionnés, et **deux commits affirmaient les avoir ajoutés**. Règle corrigée, 3 skills versionnés |
| `e99c015` | Skill **`/suivi`** — tout plan vit dans `docs/plans/` et est publié en artifact à URL stable |
| `7e6aecb` | Skill **`/revue-codex`** — review (lecture) et plan de test (exécution) sont deux documents distincts. Piège `stdin` documenté : sans `< /dev/null`, `codex exec` bloque indéfiniment en tâche de fond (37 minutes perdues) |

---

## Les rapports de review

Tous versionnés dans `docs/validation/` :

| Fichier | Contenu |
|---|---|
| `rapport-review-pr7.md` | 4 constats, verdict CONTREDIT |
| `rapport-review-pr7-passe2.md` | 2 constats neufs |
| `rapport-review-pr7-passe3.md` | **aucun constat neuf** — arrêt de la boucle |
| `rapport-review-pr8.md` | 7 constats |
| `rapport-test-pr8.md` | la délégation est impossible |
| `rapport-review-pr8-passe2.md` / `passe3.md` | 2 + 2 constats neufs |
| `rapport-review-pr9.md` / `-delta.md` | 4 + 3 constats |

---

## Le compte

| | |
|---|---|
| Commits | 29, dont 14 de code |
| Constats de review | **15, aucun faux** |
| Dont causés par mes propres correctifs | **9** |
| Constats de moi qui se sont révélés faux | **1** |
| Passes de review | 8, plus 1 plan de test |
| État de `main` | typecheck 32/32, tests 31/31 sans cache, lint 32/32 |
