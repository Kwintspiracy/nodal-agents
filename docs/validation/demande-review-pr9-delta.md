# Demande de review — PR #9, passe delta

Branche `fix/misc` → `main`. Commit à relire : le dernier, **postérieur** à ton
premier rapport (`rapport-review-pr9.md`).

**Ne refais pas la première review.** Tes quatre constats ont été vérifiés à la
source et corrigés. Trois choses seulement ont besoin d'un œil neuf, parce
qu'elles sont **nouvelles depuis ton rapport** ou parce que **personne ne les a
challengées**.

Ne corrige rien. Rends un rapport.

---

## Ce qui a changé depuis ton rapport

| Ton constat | Ce que j'ai fait |
|---|---|
| Prix OpenRouter 3.7 faux | `0.375 / 1.875` |
| Prix OpenRouter 3.6 faux | `0.75 / 3.75` |
| `max` non supporté | retiré des deux entrées ; `minimal` **non** ajouté |
| 11 identifiants vision manquants | liste **régénérée entièrement** — 42 = 42, zéro écart |
| « en silence » exagéré | commentaire réécrit avec ton constat exact |
| script exit 0 sans réseau | `process.exit(1)` dès qu'une source tombe |

Les prix et la liste sont désormais vérifiables par machine. **Ne les re-relis
pas** : relance `node scripts/refresh-model-vision.mjs`, compare à
`VISION_MODEL_IDS`, et passe à la suite si l'écart est nul.

## Question 1 — le seuil d'échec du script est-il le bon ?

`scripts/refresh-model-vision.mjs` refuse d'imprimer une liste **dès qu'une
seule** des deux sources échoue.

Mon argument : les deux sources couvrent des formes d'identifiants différentes
(OpenRouter les formes `vendor/id`, models.dev les formes natives). Une source
absente ne produit pas une liste incomplète repérable — elle rétrograde des
familles entières en texte seul, en silence.

Le contre-argument que je n'ai pas su trancher : si `models.dev` est instable
alors qu'OpenRouter répond, je viens de rendre le script inutilisable pour un
incident qui ne touche qu'une moitié du catalogue.

Ce que je te demande :

1. **Mesure la couverture réelle.** Pour chaque identifiant de
   `VISION_MODEL_IDS`, lequel des deux `Map` le résout ? S'il existe une source
   qui, seule, résout **tous** les identifiants du catalogue, mon seuil est trop
   strict et il faut échouer sur les deux, pas sur une.
2. **Y a-t-il une troisième voie** que je n'ai pas vue : imprimer la liste
   partielle en marquant explicitement les identifiants non résolus comme
   « inconnus, ne pas supprimer » ? Le script a déjà un bloc `unknown` — est-ce
   qu'il suffisait de s'en servir au lieu d'ajouter un `exit(1)` ?
3. Le message d'erreur dit *« The existing VISION_MODEL_IDS is more accurate
   than anything derivable here »*. Est-ce vrai dans **tous** les cas, ou
   seulement quand la liste a été régénérée récemment ?

## Question 2 — le choix `max` retiré / `minimal` non ajouté

Pour `google/gemini-3.6-flash`, OpenRouter publie
`supported_efforts: ["high","medium","low","minimal"]`.

J'ai **retiré** `max` (absent de la liste publiée) mais **pas ajouté**
`minimal` (présent). Ma justification : retirer une valeur fausse est une
correction de donnée, ajouter un niveau est un changement de comportement.

Est-ce que cette asymétrie tient, ou est-ce que je laisse le catalogue dans un
état incohérent — ni conforme à la source, ni conforme à ce qu'il était ?
Regarde si d'autres entrées du fichier exposent `minimal`, et ce que le runtime
en fait.

## Question 3 — la seule qui compte vraiment

**Mon constat principal est tracé, pas observé.**

J'affirme, dans le commit et dans la PR, qu'avant ce correctif *un agent sur
`claude-opus-5` ne pouvait pas recevoir d'image*. Voici tout ce que j'ai fait
pour l'établir : j'ai lu `VISION_MODEL_IDS` et constaté l'absence, puis j'ai lu
`hydrateForLlm` et `visionRoutingNote` dans `apps/runner/src/job/execute.ts`.

**Je n'ai jamais envoyé une image à un agent Opus 5.** Ni avant, ni après.

C'est exactement la faute que ce dépôt m'a déjà reprochée deux fois dans ce même
lot : vérifier les pièces, jamais le câblage. Je ne veux pas la commettre une
troisième fois.

Ce que je te demande, dans cet ordre :

1. **Reproduis le chemin en entier**, avec un agent réel sur `claude-opus-5` et
   une vraie image en pièce jointe. Regarde ce qui part réellement vers le
   fournisseur : les octets de l'image, ou le texte de `visionRoutingNote` ?
2. Fais-le **sur `main`** (avant le correctif) puis **sur `fix/misc`** (après).
   Si le comportement est identique des deux côtés, mon constat est faux et
   c'est le résultat le plus utile de ce rapport.
3. Si tu ne peux pas exécuter le chemin complet, **dis-le explicitement** et
   n'invente pas un verdict par lecture de code — c'est précisément ce que j'ai
   fait et ce que je te demande de ne pas reproduire.

## Hors périmètre

Tout le reste de la #9. Les PR **#7** et **#8**.

## Ce que je n'attends pas

Une confirmation. Sur les trois questions, le verdict « tu as raison » ne vaut
que s'il est accompagné de ce que tu as **exécuté** pour l'établir.
