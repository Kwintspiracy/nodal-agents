<!-- artifact: https://claude.ai/code/artifact/6a369704-f6cb-44c5-85ce-58175af1887d -->

# Lots « poste de développement » + A/B/C1 — TOUT LIVRÉ le 23/08/2026

Six PR mergées en deux jours, `main` vert (typecheck 33/33, tests 32/32 sans
cache, lint 33/33), zéro PR ouverte.

## Ce qui est livré

| PR | Apport |
|---|---|
| **#7** | Continuité de session, conscience du dépôt, points de restauration |
| **#8** | Un agent CLI reçoit son contexte — en faits, plus en ordres impossibles |
| **#9** | Catalogue : prix corrigés, 11 modèles rendus à la vision |
| **#10** | Sessions de code visibles en direct, provider affiché, fin de flux sauvée |
| **#11** | Nommage outil/runtime, et la conscience du dépôt câblée au chemin CLI |
| **#12** | **Nodal est un serveur MCP** — `run_task`, provenance `caller`, identité racine |

## Brancher un terminal (dès maintenant)

```
claude mcp add nodal   -e DATABASE_URL=<l'URL que le runner utilise>   -- pnpm --filter @nodal-agents/mcp-server --silent serve
```

Identité par défaut : l'agent racine du workspace (`entities.root_agent_id`).
Chaque appel peut se nommer (`caller`) — provenance affichée, jamais une
autorisation.

## Le compte des reviews, sur les six PR

| PR | Passes | Constats | Verdict initial |
|---|---|---|---|
| #7 | 3 | 6 | contredit |
| #8 | 3 + plan de test | 11 | négatif |
| #9 | 2 | 7 | modifications |
| #10 (A) | 5 | 9 | modifications |
| #11 (B) | 2 | 3 | modifications |
| #12 (C1) | **9** | 12 | **à bloquer** |

**48 constats, aucun faux.** Un seul constat s'est révélé faux sur les deux
jours, et il était de moi.

## Les deux leçons des deux jours

**Tester la pièce ne teste pas le câblage** — la faute m'a été renvoyée sept
fois. Le remède qui a marché : les tests de bout en bout (fausse CLI sur le
PATH, client MCP en mémoire, la commande publique littérale).

**Des tests verts sur le mauvais contrat ne protègent de rien** — la v1 du
serveur MCP avait tests, mutations et portes propres, et elle était à bloquer.
Ce qui l'a sauvée est un changement de contrat (celui de la surface chat), pas
des rustines.

## Next steps

### Décidé, à faire
1. **C2** — `assign_*` par reprise de session (accord donné).

### Gestes de Quentin, toujours en attente
2. Brancher son terminal (commande ci-dessus) et dire si l'agent racine
   convient.
3. Révoquer les tokens Discord + Slack (fuités le 08/08).
4. La sonde Codex sur Linux ou macOS.
5. Le sort de la 0.8.6.

### Ouvert, non urgent
6. Les 5 tests dépendants du chemin du dépôt.
7. Les skills catalogue conscients de la surface (couche catalogue).
8. La rafale WebSocket HMR — non reproduite sur système au repos.
