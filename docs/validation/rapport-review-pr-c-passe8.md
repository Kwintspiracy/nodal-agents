# Rapport de review - PR C, passe 8

tokens used
39,842
## Rapport de review — PR #12, passe 8

### Verdict

**Un constat neuf.** La correction de la passe 7 paraît valide, mais son test de non-régression ne garantit pas exactement la propriété annoncée.

### MOYEN — Le test peut accepter une pollution de stdout

Fichier : [tools.test.ts](D:/APPS/NodalAI/packages/mcp-server/src/tools.test.ts:259)

Deux écarts :

- La commande publique est `pnpm --filter @nodal-agents/mcp-server --silent serve`, mais le test se place dans le paquet et exécute seulement `pnpm --silent serve`. Il ne traverse donc pas littéralement la commande documentée.
- L’assertion utilise `result.stdout.trim()`. Une sortie composée de retours à la ligne ou d’espaces passe le test, alors que le protocole stdio du SDK traite chaque ligne comme du JSON : une ligne vide provoquerait une erreur de désérialisation.

Le test devrait exécuter depuis la racine les arguments publics exacts et vérifier `result.stdout === ''`, octet pour octet.

### Vérifications complémentaires

- `--silent` est correctement présent dans la documentation et le commentaire du lanceur.
- Le lanceur écrit toujours l’erreur `DATABASE_URL` sur stderr et sort avec le code 1.
- Aucun autre constat neuf trouvé.
- `git diff --check` passe.
- Arbre de travail inchangé ; lecture seule respectée.
