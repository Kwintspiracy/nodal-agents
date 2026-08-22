<!-- artifact: https://claude.ai/code/artifact/6a369704-f6cb-44c5-85ce-58175af1887d -->

# Lot « poste de développement » — état au 22/08/2026, 16h

Trois PR ouvertes, aucune mergée. Deux sont sorties de la boucle de
vérification, la troisième attend un arbitrage de périmètre.

## Où on en est

| PR | Sujet | Reviews | CI | Reste |
|---|---|---|---|---|
| **#7** | Continuité, conscience du dépôt, retour arrière | 3 passes, **close** | 🟢 4/4 | rien |
| **#8** | Le runtime CLI recevait sa personnalité brute | 3 passes + 1 plan de test | 🟡 en cours | **un arbitrage** |
| **#9** | Catalogue : prix, vision, efforts | 2 passes, **close** | 🟢 4/4 | rien |

## Ce que les reviews ont trouvé — 15 constats, aucun faux

| PR | Constats | Dont causés par mes propres correctifs |
|---|---|---|
| #7 | 6 | 2 |
| #8 | 7 + 2 + 2 | 4 |
| #9 | 4 + 3 | 3 |

Un seul constat s'est révélé **faux** au fil de la journée, et il était de moi :
« le modèle phare était aveugle ». Mesuré : 8 modèles sur 11, et aucun de ceux
que j'avais nommés.

### Le motif qui revient

Quatre fois, un test à moi est passé sans rien prouver, parce que sa fixture
n'instanciait pas le cas : un seul workspace, un fichier non ignoré, aucun skill
assigné, aucune mémoire. **Tester la pièce ne teste pas le câblage.**

## PR #8 — ce qui attend ta décision

Trois passes ont buté sur une seule cause : **le texte du catalogue est écrit
pour l'outillage Nodal.**

```
verify-before-done  →  ordonne file_read après chaque écriture
code-review         →  exige review_verdict puis return_result
command-execution   →  prescrit run_command
```

Aucun n'existe dans une session Claude Code. Les *règles* sont portables ; la
*prose* qui les porte ne l'est pas.

**Ce que la #8 livre** : identité, personnalité, roster d'équipe comme fait,
faits mémoire, chemins absolus, posture git. Le bug signalé est corrigé, mesuré
à 22 176 → 4 789 caractères et 23 → 0 ordre inexécutable.

**Ce qu'elle ne livre pas** :

| Manque | Pourquoi | Où le corriger |
|---|---|---|
| La délégation | `--strict-mcp-config` + `--disallowedTools` soustractif : rien ne peut ajouter un outil à la session | PR d'architecture — rouvre la porte que la #6 a fermée |
| Le contenu catalogue | Écrit pour les outils Nodal | Couche **catalogue**, invariant #3 |

## Outillage — trois défauts trouvés en route

| Défaut | État |
|---|---|
| `codex exec` en tâche de fond bloque sans `< /dev/null` | corrigé, inscrit dans `/revue-codex` |
| `.claude/` ignoré : les skills n'étaient pas versionnés | corrigé, 2 commits mentaient |
| 5 tests dépendent du **chemin** du dépôt | non corrigé, hors périmètre |

Et une limite mesurée : `--sandbox workspace-write` refuse l'écriture **et** la
création de processus sur cette machine. Un plan de test ne peut pas être
délégué à Codex sous Windows.

## Next steps

### Ce qui attend une décision de Quentin

1. **La #8 est-elle mergeable ainsi ?** Elle corrige le bug signalé et assume
   deux manques nommés. L'alternative est d'élargir le lot.
2. **La délégation depuis un agent CLI** : capacité à construire, ou absence
   assumée ?
3. **Les skills catalogue** conscients de la surface : projet à part entière.

### Ce que je peux faire seul ensuite

4. Le trou d'outillage : les 5 tests dépendants du chemin.
5. Relancer une passe sur la #7 après sa CI verte, pour confirmer.

### Tes gestes, toujours en attente

6. Révoquer les tokens Discord + Slack (fuités le 08/08).
7. `node scripts/probe-codex-sandbox.mjs` sur Linux ou macOS.
8. Décider du sort de la 0.8.6.
