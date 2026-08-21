# Demande de review — PR #6 (refus de codex sous Windows)

Branche `fix/codex-sandbox-unenforced` → `main`. 8 fichiers, +275/−10.
Les cinq checks CI sont verts : ce n'est pas ce qu'on te demande de vérifier.

**Ton rôle : essayer de me démonter, pas de me confirmer.** Deux verdicts sont
utiles — « le constat tient » et « le constat est faux ». Un troisième ne l'est
pas : « ça a l'air bien ».

Ne corrige rien. Rends un rapport.

---

## Ce que la PR affirme

Que sous Windows, `codex exec --sandbox` ne confine pas le CLI, dans **aucun**
des deux modes — alors que `code_task` promet au modèle, dans son schéma
d'entrée, que le mode lecture empêche toute modification de fichier et toute
commande shell.

Conséquence livrée : `provider: "codex"` est **refusé** sur Windows, en lecture
comme en écriture, avant tout lancement.

## Priorité 1 — le constat est-il vrai ?

Reproduis toi-même. Ne te fie pas à mes sorties.

```bash
mkdir /tmp/rev && cd /tmp/rev
codex exec --json --sandbox read-only --skip-git-repo-check -c 'mcp_servers={}' - \
  <<< "Cree un fichier t.txt contenant OUI ici, via le shell."
ls t.txt
```

Puis l'évasion hors du répertoire de travail :

```bash
codex exec --json --sandbox workspace-write --skip-git-repo-check - \
  <<< "Ecris DEHORS dans <un chemin absolu hors du repertoire courant>, via le shell."
```

**Si les fichiers n'apparaissent pas chez toi, la PR entière est à jeter** — et
c'est le résultat le plus utile que tu puisses produire. Dans ce cas, dis sur
quelle plateforme et quelle version de `codex-cli` tu as testé.

Hypothèses que j'ai déjà écartées, à ne pas re-tester sauf si tu en doutes : le
comportement est identique dans un vrai dépôt git ; `-c 'sandbox_mode="read-only"'`
est accepté sans erreur et ignoré ; `codex sandbox` (la sous-commande interne)
bloque, elle, réellement.

## Priorité 2 — mes deux arbitrages discutables

Ce sont les points où je peux avoir tort en toute bonne foi.

**a) Refuser au lieu d'avertir.** Mon raisonnement : `computeApproval` ne peut
retourner que `'require_approval' | undefined`, donc un outil ne peut pas
ajouter de réserve à la carte d'approbation. L'avertissement ne pouvant pas
atteindre la décision, je ne propose pas la décision.

Vérifie la prémisse dans `packages/tools/src/types.ts`. **Existe-t-il un autre
chemin pour faire remonter un avertissement à l'humain avant qu'il approuve ?**
Si oui, mon refus est disproportionné.

**b) Refuser aussi le mode écriture.** En écriture, l'utilisateur a consenti à
des modifications ; ce qui saute, c'est le périmètre (le workspace). J'ai jugé
que ça justifiait le même refus. Argument contre, que je trouve sérieux : ça
supprime Codex de Windows pour des gens qui l'utilisaient sans incident.

**Tranche, et dis pourquoi.** Si tu penses que l'écriture devait passer avec un
avertissement, dis où cet avertissement serait affiché.

## Priorité 3 — le correctif est-il trop large ?

Un correctif de sécurité trop large est une régression déguisée. Vérifie que
**rien** de ceci n'est bloqué :

- `provider: "claude"`, les deux modes, sur toutes les plateformes
- `provider: "codex"`, les deux modes, sous Linux et macOS

`packages/tools/src/builtin/code-task/sandbox.test.ts` prétend le prouver.
**Neutralise la garde** (`codexSandboxEnforced` → `return true`) et vérifie que
les tests qui rougissent sont bien ceux du refus, et que ceux de non-régression
restent verts. Si un test vert le reste dans les deux cas, il ne teste rien.

## Priorité 4 — ce que je n'ai pas fait

- **Je n'ai mesuré que Windows.** Linux et macOS sont supposés sains sur la foi
  de la documentation de codex. Si tu peux mesurer, c'est le trou le plus utile
  à combler.
- Je n'ai pas vérifié le comportement des agents en **runtime `claude-code`**
  (`run-job.ts` / `run-chat.ts`) : ils n'appellent pas `code_task` et ne passent
  donc pas par la garde. Est-ce un trou ? Un agent `runtime: codex` est réservé
  et échoue déjà, mais confirme-le.
- Je n'ai pas regardé si un `code_task` **déjà approuvé** et rejoué plus tard
  contournerait la garde.

## Format attendu

Pour chaque point : **VÉRIFIÉ / CONTREDIT / NON TESTÉ**, avec la commande, la
sortie brute, la plateforme et la version. Une section « non testé » honnête vaut
mieux qu'une couverture prétendue — c'est ce qui rendait ton rapport du 20/08
utilisable.

Et si tu trouves quelque chose que je n'ai pas listé ici, c'est le plus précieux :
cette liste dit ce que je crains, donc pas ce que j'ai raté.
