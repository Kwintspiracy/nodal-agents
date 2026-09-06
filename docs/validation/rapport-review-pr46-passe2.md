# Rapport de relecture — PR #46, passe 2

Aucun fichier modifié.

## Constat

### P0 — Le `realpath` crée une identité différente entre l’intention et l’interface web

**Fichiers :**

- `packages/tools/src/verification/intent.ts:129`
- `packages/tools/src/verification/intent.ts:305`
- `packages/tools/src/verification/intent.ts:308`
- `apps/web/src/lib/code-projects.ts:25`
- `apps/web/src/lib/code-projects.ts:284`
- `apps/web/src/lib/actions.ts:11907`
- `apps/web/src/lib/actions.ts:12834`
- `packages/shared/src/project-key.ts:59`

**Verdict : FAUX — VÉRIFIÉ par lecture ; impact DÉDUIT.**

Le correctif canonicalise par `realpath` les racines et les cibles avant de produire la clé d’intention. En revanche, l’onglet Code dérive toujours ses projets à partir des chemins lexicaux des workspaces, puis applique directement `projectKey`, qui ne résout ni jonction ni lien symbolique.

Exemple :

```text
workspace enregistré : D:/work/link
cible réelle          : D:/repos/app/src/a.ts
```

Si `link` pointe vers `D:/repos/app`, l’intention écrit la clé `d:/repos/app`, tandis que le web dérive et manipule `d:/work/link`. Les deux représentent le même dossier physique mais deviennent deux lignes `code_projects`.

**Ce qui casse concrètement :** l’état `dirty`, l’epoch et les résultats de preuve peuvent être enregistrés sous la clé réelle sans apparaître sur le projet affiché par l’onglet Code. Inversement, les commandes, l’approbation ou le renommage configurés depuis le web restent attachés à la clé lexicale et ne sont pas relus par la finalisation de la clé réelle. Le test par lien valide seulement la clé produite par l’intention ; il ne vérifie pas son identité avec celle produite côté web.

Les autres correctifs examinés tiennent : le hook Office refuse ensuite effectivement le chemin hors workspace, `stillOurs` protège les issues, le sweep exige l’expiration du bail, et la limite ordonnée de vingt retarde le backlog sans l’affamer définitivement.

## Classement final

- **P0 :** divergence de clé entre `realpath` côté intention et chemin lexical côté web.
- **P1 :** aucun constat neuf.
- **P2 :** aucun constat neuf.

**Synthèse : la passe 2 révèle un P0 nouveau : le correctif `realpath` ferme le cas CI localement, mais sépare l’identité persistée par l’intention de celle utilisée par l’interface web.**