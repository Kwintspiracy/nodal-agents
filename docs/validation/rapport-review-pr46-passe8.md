# Rapport — review Codex PR #46, passe 8 (v7-C, découverte des commandes)

Périmètre : le commit `0e396200`. Sandbox lecture seule, tout marqué **NON
EXÉCUTÉ**. Verdict de Codex : **changements demandés**, sur un P0.

## Le P0 — la garde de périmètre était perçable

Codex : `normalizePath` ne fait que convertir les séparateurs. `C:/ws/../secret`
satisfait le test de préfixe, puis `join` résout le `..` et lit hors périmètre.
De même pour un lien symbolique ou une jonction Windows posés dans un dossier
attaché.

**Le constat tient. Je l'avais trouvé et fermé avant de recevoir le rapport**,
en relisant ma propre garde : c'était la même faiblesse, avec la même
comparaison à `resolveAndCheckPath`. Les deux côtés passent maintenant par
`realpath`, après `resolve` qui écrase les `..`.

Deux tests, tous deux **vérifiés par mutation** :

- une remontée par `..` — écrite par CONCATÉNATION, pas avec `join`, qui
  collapse les `..` lui-même et laissait le test vert sans rien prouver. Le
  premier jet en était victime ;
- une jonction posée dans le dossier attaché et pointant dehors. Si
  l'environnement refuse de créer le lien, le test **échoue en le disant**
  plutôt que de rendre vert un cas non éprouvé.

Point de Codex non retenu tel quel : « les chemins UNC ne sont pas rejetés avant
`stat` ». Une racine UNC configurée par le propriétaire est un dossier
légitime ; la refuser interdirait un usage réel. La garde compare des chemins
réels, et une racine réseau ne devient pas un vecteur du fait d'être réseau.

## Les trois autres constats, tous traités

**Un nom de script ne garantit pas une preuve.** Vrai et important : un projet
peut appeler `next dev` depuis `test`, et la commande ne rendrait jamais la
main. On ne peut pas le deviner, mais on peut le MONTRER. La proposition porte
désormais ce que le script lance vraiment, et l'écran l'affiche à côté de la
commande. Le propriétaire voit `next dev` avant d'approuver.

**`pytest` était détecté n'importe où dans le fichier**, y compris dans un
commentaire ou une description. La détection exige maintenant une vraie section
`[tool.pytest...]`. Trois formes trompeuses sont testées et refusées.

**Les virgules finales du JSONC** faisaient silencieusement disparaître un
`deno.jsonc` parfaitement ordinaire, `JSON.parse` les refusant. Elles sont
retirées hors chaîne, et une virgule à l'intérieur d'une chaîne survit.

**La lecture n'était pas réellement bornée** : entre `stat` et `readFile`, le
fichier peut grossir. C'est un descripteur ouvert une fois et un tampon de
taille fixe : ce qui dépasse n'est jamais lu.

## Le constat P2, traité par la vérité plutôt que par du code

Codex : le test « refusé AVANT toute lecture » ne prouve que le refus, pas
l'ordre. Il resterait vert si la garde s'appliquait après les lectures.

C'est exact. Le prouver demanderait d'injecter un adaptateur de système de
fichiers. Le titre du test dit maintenant ce qu'il prouve, et son commentaire
dit que l'ordre est **structurel**, pas testé. Un titre qui promet plus que son
corps est la même famille de défaut que la revue traque depuis la passe 6.

## État après la passe

| Suite | Résultat |
|---|---|
| `packages/shared` | 452 |
| `apps/web` | 1054 |

Quatre mutations passées, quatre rouges attendus : le nom du script montré, la
section pytest, les virgules finales, la virgule dans une chaîne. Plus les deux
mutations de la garde de périmètre.
