<!-- artifact: https://claude.ai/code/artifact/6a369704-f6cb-44c5-85ce-58175af1887d -->

# Lot « poste de développement » — CLOS le 22/08/2026

Les trois PR sont mergées. `main` est vert : typecheck 32/32, tests 31/31 sans
cache, lint 32/32, `deps:check` propre. Zéro PR ouverte.

## Ce qui est livré

| PR | Apport |
|---|---|
| **#7** | Continuité de session pour `code_task`, conscience du dépôt, points de restauration |
| **#8** | Un agent en runtime CLI reçoit son contexte — en **faits**, plus en ordres impossibles |
| **#9** | Prix OpenRouter corrigés, 11 modèles rendus à la vision, script qui refuse de mentir |

## Ce que les reviews ont trouvé

**15 constats, aucun faux.** Neuf venaient de mes propres correctifs — c'est ce
que les deuxièmes et troisièmes passes servent à attraper.

| PR | Passes | Constats | Dont causés par mes correctifs |
|---|---|---|---|
| #7 | 3 | 6 | 2 |
| #8 | 3 + 1 plan de test | 11 | 4 |
| #9 | 2 | 7 | 3 |

Un seul constat s'est révélé **faux** dans la journée, et il était de moi : « le
modèle phare était aveugle ». Mesuré : 8 modèles sur 11, et aucun de ceux que
j'avais nommés.

### Le motif qui revient — quatre fois

Un test à moi passait sans rien prouver, parce que sa fixture n'instanciait pas
le cas : un seul workspace, un fichier non ignoré, aucun skill assigné, aucune
mémoire. **Tester la pièce ne teste pas le câblage.**

### La leçon de la #8

Trois passes ont buté sur une seule cause : le texte du catalogue est écrit pour
l'outillage Nodal. **Les règles sont portables ; la prose qui les porte ne l'est
pas.** D'où : cette surface ne reçoit aucun contenu catalogue, et le correctif
réel appartient à la couche catalogue.

## Ce que le lot n'a PAS livré, et l'assume

| Manque | Où ça va |
|---|---|
| La délégation depuis un agent CLI | **PR C** — le chemin est clair, `--strict-mcp-config` et `--mcp-config` cohabitent |
| Les skills catalogue conscients de la surface | couche catalogue, invariant #3 |
| 5 tests dépendant du **chemin** du dépôt | trou d'outillage, non corrigé |

## La suite — trois PR, ordre validé

| PR | Sujet | Pourquoi cet ordre |
|---|---|---|
| **PR A** | [Observabilité — arrêter de perdre ce qui a tourné](https://claude.ai/code/artifact/7844e194-d0c1-440d-8c84-7534fb429f6a) | contient un défaut **actif** : une session longue rend un résultat amputé sans le dire |
| **PR B** | Nommage « CLI » — outil contre runtime | ~30 lignes de copie, règle une confusion quotidienne |
| **PR C** | Serveur MCP — délégation, et le terminal qui pilote Nodal | seule à ajouter une **surface d'attaque** — sa propre review, son propre plan de test |

**PR C se découpe** : d'abord la preuve minimale — un serveur exposant **un seul**
outil, `create_task`, branché sur le `claude` du terminal. Si une tâche Nodal
part du terminal et apparaît dans Runs, tout le reste tient. Sinon on l'apprend
en une heure au lieu d'un lot entier.

PR C sert **deux** usages, et le second est venu de Quentin : un agent CLI qui
délègue, **et** son terminal qui pilote Nodal — trois reviews lancées en
parallèle sans quitter le terminal.

## Outillage — trois défauts trouvés en route

| Défaut | État |
|---|---|
| `codex exec` en tâche de fond bloque sans `< /dev/null` | corrigé, inscrit dans `/revue-codex` (37 min perdues) |
| `.claude/` ignoré : les skills n'étaient pas versionnés | corrigé — 2 commits affirmaient le contraire |
| 5 tests dépendent du chemin du dépôt | **ouvert** |

Et une limite mesurée : `--sandbox workspace-write` refuse l'écriture **et** la
création de processus sur cette machine. Un plan de test ne peut pas être
délégué à Codex sous Windows — les mesures se font ici.

## Next steps

### Ce que je fais ensuite, sans rien attendre

1. **PR A** (spec liée ci-dessus), en commençant par la mesure promise : ce qu'on perd réellement quand
   le plafond tombe, sur une session `code_task` réelle.

### Gestes de Quentin, en attente

2. **Révoquer les tokens Discord + Slack** — fuités le 08/08, jamais confirmés
   révoqués.
3. **`node scripts/probe-codex-sandbox.mjs` sur Linux ou macOS** — le confinement
   de Codex n'a jamais été mesuré ailleurs que sous Windows.
4. **Décider du sort de la 0.8.6** — la fuite MCP est publiée sur npm depuis la
   0.8.1.
