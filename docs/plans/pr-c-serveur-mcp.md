<!-- artifact: https://claude.ai/code/artifact/60b8369d-be53-4e5c-91ac-4fefd2d8b682 -->

# PR C — Nodal comme serveur MCP

Deux usages, un seul mécanisme :

- un **agent CLI** qui peut enfin confier du travail à ses coéquipiers ;
- ton **terminal** qui pilote Nodal — trois reviews lancées en parallèle sans
  quitter la ligne de commande.

## La preuve est faite, avant le plan

Mesurée le 23/08 avec un vrai `claude`, pas déduite :

```
claude -p --strict-mcp-config --mcp-config <fichier> --allowedTools mcp__nodal__create_task
→ outil vu, appelé, réponse remontée :
  {"would_create":{"assigned_to":"researcher","task":"preuve"},"created":false}
```

**Le point qui décidait de tout** : `--strict-mcp-config` et `--mcp-config`
fonctionnent **ensemble**. Le premier veut dire « uniquement ceux que je te
donne », pas « aucun ». Le confinement de la PR #6 reste donc intact — la config
personnelle est toujours écartée — et Nodal peut quand même exposer ses outils.

Ce que je croyais être un arbitrage entre sécurité et délégation n'en était pas
un. Le SDK MCP est déjà une dépendance : Nodal en est client, il peut être
serveur.

## Ce que la PR livre

| # | Quoi | Où |
|---|---|---|
| **1** | Un serveur MCP stdio exposant les outils de délégation d'UN agent | nouveau `packages/mcp-server` |
| **2** | La liste d'outils calculée depuis la base, par agent | invariant #9 — aucun défaut |
| **3** | `--mcp-config` ajouté à l'argv d'une session runtime | `claude-turn.ts` |
| **4** | Les garde-fous anti-boucle appliqués à ce chemin | invariant #8 |

## Le vrai obstacle, et son découpage

Déléguer a deux formes, de difficulté très inégale.

**`create_task` — direct.** L'agent crée des tâches, elles partent au tableau,
il termine son tour. Nodal les exécute et compose la synthèse, comme aujourd'hui.
Rien à attendre, rien à bloquer.

**`assign_*` — plus délicat.** L'agent confie et **attend le résultat**. Un agent
Nodal fait ça en terminant son tour ; le job se met en pause, l'enfant tourne,
le parent reprend. Une session CLI ne se met pas en pause au milieu d'un tour.

Mais la PR #7 a livré la pièce manquante : **la continuité de session**. Le
mécanisme existe, il a été construit pour autre chose.

| Étape | Contenu | Difficulté |
|---|---|---|
| **C1** | `create_task` + `list_tasks` | faible |
| **C2** | `assign_*` par fin de tour et reprise de session | moyenne |

## Ce qui doit être tranché avant de coder

| Question | Ce que je propose |
|---|---|
| Au nom de QUI le terminal appelle-t-il ? | un agent désigné dans la config — il n'y a pas de job, donc pas d'identité implicite |
| Quelle autorisation ? | stdio lancé par le client lui-même = la confiance de ce shell. **Rien sur le réseau** sans authentification |
| Où vont les résultats d'un appel venu du terminal ? | la page Runs — il n'y a ni conversation ni canal |
| La profondeur de délégation ? | un appel depuis le terminal démarre à 0, comme un job racine |

## La surface d'attaque, dite franchement

C'est la seule des trois PR qui **ajoute** un point d'entrée. Un serveur qui crée
des jobs et fait tourner des outils mérite sa propre review et son propre plan de
test — la noyer dans autre chose serait exactement la faute que la PR #6 a servi
à corriger.

Trois choses à ne pas rater :

1. **La liste d'outils vient de la base**, par agent. Un serveur qui expose tout
   à tout le monde annule le modèle d'autorisation de Nodal.
2. **Aucune écoute réseau** dans cette PR. stdio uniquement.
3. **Les compteurs anti-boucle** s'appliquent, sinon un agent CLI peut créer des
   tâches sans fin.

## Vérification

| # | Le test qui compte | Le test qui ne prouverait rien |
|---|---|---|
| 1 | Un vrai `claude` voit l'outil, l'appelle, et **un job apparaît en base** | vérifier que le serveur démarre |
| 2 | Un agent SANS droit de délégation ne voit **aucun** outil | vérifier que la liste est calculée |
| 3 | Le cap de délégation refuse le énième appel | — |
| 4 | `--strict-mcp-config` reste présent : la config perso n'entre pas | — |

**La mutation qui compte** : retirer le filtrage par agent doit faire rougir le
test 2. Sans ça, il ne prouve rien.

## Hors périmètre

L'écoute réseau, l'authentification multi-utilisateur, et le cas où plusieurs
clients partagent un serveur. Tant que c'est stdio par client, ces questions ne
se posent pas.
