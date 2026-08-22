<!-- artifact: https://claude.ai/code/artifact/6a369704-f6cb-44c5-85ce-58175af1887d -->

# Lot « poste de développement » — état au 22/08/2026

Trois PR ouvertes, aucune mergée. Le lot est l'unité de travail : une PR qui se
scinde ne crée pas un second plan.

## Où on en est

| PR | Sujet | Code | Review | CI | Bloqué par |
|---|---|---|---|---|---|
| **#7** | Continuité, conscience du dépôt, retour arrière | ✅ 3/3 | ⬜ jamais lancée | 🟢 4/4 | rien — prête à relire |
| **#8** | Le runtime CLI recevait sa personnalité brute | 🔄 à revoir | 🔴 2 passes, **verdict négatif** | 🟡 2/4 en cours | un accord (test en écriture) + une décision de forme |
| **#9** | Catalogue : prix, vision, efforts | ✅ | ✅ 2 passes traitées | 🟢 4/4 | rien — close de mon côté |

## PR #9 — close

Deux passes de review, toutes deux traitées.

| Trouvé | Par | Verdict |
|---|---|---|
| Prix OpenRouter 3.7 et 3.6 doublés | Codex | vrai, corrigé |
| Effort `max` inexistant | Codex | vrai, retiré |
| 11 identifiants vision manquants | Codex | vrai, liste régénérée (42 = 42) |
| Seuil du script trop strict | Codex | vrai — mesuré : models.dev seul couvre 54/54, OpenRouter 33/54 |
| `mandatory` manquant → option `Off` impossible | Codex | vrai, **bug que j'avais introduit** |
| « le modèle phare était aveugle » | moi | **faux** — 8 des 11, et pas ceux que j'avais nommés |

Le dernier est le plus instructif : je l'avais établi par lecture. En exécutant
la vraie expression de décision (`capabilities.vision \|\| modelCanSeeImages`),
le compte tombe à 8, et les 3 modèles natifs que j'accusais n'ont jamais été
concernés.

## PR #8 — verdict négatif, la PR a la mauvaise forme

Le bug d'origine est réel : un agent en runtime CLI recevait `personality` brut,
donc ne voyait ni son équipe, ni sa mémoire, ni ses skills.

Mais le correctif — lui donner le prompt Nodal complet — lui donne aussi les
**consignes** d'un outillage qu'il n'a pas.

| # | Constat | Vérifié |
|---|---|---|
| 1 | `team-block.ts` ordonne `assign_<agent>`, `create_task`, `return_result` | ✅ par moi |
| 2 | Le bloc skills impose `skill_view`, `run_skill_script` | ⬜ |
| 3 | Le baseline impose `save_memory`, `mark_memory_outdated` en « MUST » | ⬜ |
| 4 | Le bloc workspace documente `file_read` / `file_write` | ⬜ |
| 5 | Le chemin job perd 5 champs du `JobContext` | ⬜ |
| 6 | Le chat CLI perd le contexte de déploiement | ⬜ |
| 7 | Les mutations restent vertes | ✅ **exécuté** : `30/30`, code 0 |

Le constat 1 vide la PR de son bénéfice : l'orchestrateur voit enfin ses
sous-agents, et reçoit l'ordre d'appeler des outils qui n'existent pas de son
côté. Il les voit, il ne peut pas les appeler.

J'ai aussi trouvé seul, en me relisant, que le cast `as never` faisait
disparaître la ligne d'identité du prompt et passait `undefined` à
`buildBaselineBlock`. Corrigé (`b0530bf`) ; le compilateur garde l'appelant
maintenant.

### Ce qui doit être tranché

**Question de forme.** Ma recommandation : rendre les mêmes **données** (équipe,
skills, mémoire, workspaces) comme des **faits** et non comme des consignes
d'outillage. « Tu as 9 sous-agents : X, Y, Z » sans « appelle `assign_X` ».

**Question de fond, plus lourde.** Un agent CLI ne peut probablement pas
déléguer **du tout** aujourd'hui. Si c'est confirmé, c'est une capacité
manquante, pas une formulation de prompt — et la #8 ne peut pas la livrer.

## PR #7 — prête, jamais relue

Les trois manques sont codés, la CI est verte sur les cinq checks, le plan de
review est écrit et sur la bonne branche. Personne ne l'a relue.

C'est la plus grosse des trois : elle touche `execute.ts`, le point de passage
unique de tous les outils, et ajoute un paquet.

## Outillage — deux défauts trouvés en route

**La suite de tests est instable.** `28/30` observé deux fois, `30/30` sur les
mêmes commits. Tant que ce n'est pas identifié, le test par mutation n'est pas
fiable : on ne distingue plus un rouge de mutation d'un rouge de contention.

**Une review en lecture seule déduit au lieu de mesurer.** Codex a conclu
correctement sur les mutations sans pouvoir les appliquer. D'où la séparation
review / plan de test, encodée dans `/revue-codex`.

## Next steps

### Ce que je peux faire seul

1. Traiter les constats 2 à 6 de la #8 — les vérifier d'abord, un par un.
2. Lancer la review de la **#7**, jamais faite. En lecture seule, donc sans
   préavis.

### Ce qui attend un accord

3. **Le plan de test de la #8** (`plan-de-test-pr8.md`) exige
   `--sandbox workspace-write` : Codex mute `run-chat.ts`, `run-job.ts`,
   `system-prompt.ts` (restaurés par `git checkout --`) et crée un test
   temporaire. C'est ce que je veux lancer, et c'est bloqué sur ton oui.

### Ce qui attend une décision

4. **La forme de la #8** : faits plutôt que consignes, ou autre chose.
5. **La délégation depuis un agent CLI** : capacité à construire, ou périmètre
   qu'on assume comme absent.

### Tes gestes, en attente depuis plus tôt

6. Révoquer les tokens Discord + Slack (fuités le 08/08).
7. Lancer `node scripts/probe-codex-sandbox.mjs` sur Linux ou macOS.
8. Décider du sort de la 0.8.6.
