# Demande de review — PR #9 (Gemini 3.7, et un modèle qui refusait les images en silence)

Branche `fix/misc` → `main`. 1 fichier, +47/−0.
Les checks CI sont verts : ce n'est pas ce qu'on te demande de vérifier.

**Ton rôle : essayer de me démonter, pas de me confirmer.** Deux verdicts sont
utiles — « le constat tient » et « le constat est faux ». Un troisième ne l'est
pas : « ça a l'air bien ».

Ne corrige rien. Rends un rapport.

---

## Pourquoi une review sur 47 lignes de données

Parce que c'est précisément le genre de diff qu'on relit mal. Il n'y a pas de
logique à casser : rien qu'une liste de valeurs. Une valeur fausse ici ne fait
**pas** rougir un test — elle produit une estimation de coût fausse, ou un
modèle qui refuse une image sans dire pourquoi. C'est la classe de bug la moins
détectable du dépôt.

## Priorité 1 — chaque valeur est-elle vraie ?

Va à la source (`ai.google.dev/gemini-api/docs`), pas à ta mémoire. Vérifie une
par une :

| Champ | Ce que j'affirme |
|---|---|
| `modelId` | `gemini-3.7-flash` |
| `contextWindow` | 1 048 576 |
| `capabilities.tools` | `true` |
| `reasoningControl` | effort, niveaux `low`/`medium`/`high`, **obligatoire** |
| `pricing` | 0,75 $ entrée / 3,75 $ sortie par million |
| vision | le modèle accepte bien des images |

Sur le prix, deux pièges que je signale parce que je peux m'être trompé :

- C'est le tarif **introductif**. Google annonce qu'il expire au 31/12/2026 et
  double ensuite (1,50 $ / 7,50 $). **Est-ce la bonne convention pour ce
  fichier ?** Regarde comment les entrées voisines traitent un tarif temporaire.
  Si elles inscrivent le tarif plein, je suis à contre-courant.
- Le prix par million dépend parfois du **palier de contexte** chez Google (un
  tarif au-delà de 200k tokens). Si c'est le cas ici, mon entrée est fausse pour
  les longs contextes et ce fichier n'a peut-être aucun moyen de l'exprimer.

## Priorité 2 — la divergence entre les deux entrées est-elle légitime ?

J'ajoute le modèle **deux fois** : natif `google` et via `openrouter`. Les deux
entrées diffèrent sur un champ : `forcedToolChoice` (`false` en natif, `true`
via OpenRouter).

Je l'ai posé « par convention du fichier », pas par mesure. Vérifie :

1. Les autres paires natif/OpenRouter du fichier suivent-elles vraiment cette
   règle, **sans exception** ?
2. Est-ce que cette valeur reflète le comportement réel d'OpenRouter pour les
   modèles Google, ou est-ce un copier-coller qui se propage depuis une entrée
   ancienne ?
3. Les **autres** champs des deux entrées sont-ils cohérents entre eux
   (contexte, prix, capacités) ? Une divergence non intentionnelle sur le prix
   passerait totalement inaperçue.

## Priorité 3 — le trou de `VISION_MODEL_IDS`

Le constat : `gemini-3.6-flash` était **dans** le catalogue mais **absent** de
`VISION_MODEL_IDS`. Un modèle qui accepte les images sans figurer dans cette
liste les refuse en silence.

Ce que je te demande :

1. **Le constat est-il exact ?** Trace ce que fait réellement le code quand un
   modèle absent de cette liste reçoit une image. Si ça lève une erreur claire
   plutôt qu'un refus silencieux, mon constat est exagéré — dis-le.
2. J'ai ajouté 3.6 et 3.7 **à la main**, alors que le fichier déclare que cette
   liste est produite par `scripts/refresh-model-vision.mjs`. Est-ce acceptable,
   ou est-ce que j'introduis une divergence que le prochain passage du script
   effacera ?
3. **Combien d'autres modèles du catalogue manquent dans cette liste ?** Si la
   réponse est « beaucoup », mes deux lignes sont un pansement et le vrai constat
   à remonter est que le script n'est plus lancé.

## Priorité 4 — ce que la PR ne fait pas

Un point de la liste d'origine n'est **pas** traité : « AI mode disponible dans
les réglages d'agent même si tools = off ».

Je n'ai trouvé aucune occurrence de `AI mode`, `AI Mode` ni `aiMode` dans
`apps/web`. Si tu localises le réglage sous un autre nom, c'est le constat le
plus utile que tu puisses rendre sur cette PR — dis où il est et ce qu'il
contrôle réellement.

## Hors périmètre

Les PR **#7** (poste de développement) et **#8** (prompt du runtime CLI).

## Ce que je n'attends pas

Un avis sur le style ou le nommage. Une liste de constats, chacun avec la ligne
et la source qui me contredit.
