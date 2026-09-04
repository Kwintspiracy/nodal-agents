# Rapport de relecture — PR #46, passe 3

Aucun fichier modifié.

## Constat

### P0 — Le correctif choisit la première racine physique, pas la racine utilisée par l’outil

**Fichiers :**

- `packages/tools/src/verification/intent.ts:151`
- `packages/tools/src/verification/intent.ts:155`
- `packages/tools/src/verification/intent.ts:158`
- `packages/tools/src/verification/intent.ts:160`
- `packages/tools/src/builtin/file-ops/workspace.ts:159`
- `apps/runner/src/job/execute.ts:876`
- `apps/web/src/lib/code-projects.ts:284`

**Verdict : FAUX — câblage VÉRIFIÉ par lecture ; scénario et impact DÉDUITS.**

`rebaseOntoLexicalRoots` parcourt les workspaces dans leur ordre de configuration et s’arrête au premier dont le chemin réel contient la cible. Il ne conserve pas la racine sélectionnée par `resolveAndCheckPath` et ne trie pas les racines physiques de la plus spécifique à la moins spécifique.

Exemple :

```text
racine 1 : /liens/depot       -> /reel/conteneur
racine 2 : /reel/conteneur/app
cible via le label racine 2 : /reel/conteneur/app/src/a.ts
```

`resolveAndCheckPath` renvoie le chemin réel. Si la racine 1 précède la racine 2, `rebaseOntoLexicalRoots` réécrit la cible en `/liens/depot/app/src/a.ts`.

L’intention utilise alors la clé `/liens/depot/app`, tandis que le web reconstruit le chemin depuis le label et rattache l’appel à `/reel/conteneur/app`. Ces chemins désignent le même dossier physique, mais produisent deux `projectKey` différents.

**Ce qui casse :** l’intention sale et incrémente l’epoch d’une ligne que l’onglet Code et la finalisation du projet sélectionné ne connaissent pas. Les commandes et approbations restent sur l’autre ligne. Le test ajouté ne couvre qu’une seule racine lexicale et ne détecte pas cette ambiguïté.

Les cas cible inexistante, racine inexistante et casse Windows ne révèlent pas d’autre défaut neuf dans les chemins examinés. Aucun autre constat neuf sur le reste du diff.