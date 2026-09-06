# Demande de review — PR #46, passe 38 (les deux P0 de la passe 37 sur P10a)

Périmètre : **un commit** (le dernier de la branche après `81038f70`, message « fix(ask-user):
… (passe Codex 37) »), qui répond à la passe 37
(`docs/validation/rapport-review-pr46-passe37.md`). Un agent code P10b (`register_project`,
guidance du prompt) en parallèle dans d'autres fichiers, NON committé : relire l'état COMMITTÉ.

- `packages/tools/src/execute.ts` : dans le plancher `asksUser`, un appel SANS `ctx.toolCallId`
  rend `{ outcome: 'error', error: 'question_without_call_id' }` (ligne d'audit écrite) au lieu
  de suspendre — une ligne sans id n'aurait jamais pu être reprise, et la porte aurait reposé
  la question à l'infini. Test (d) retourné : erreur, et AUCUNE ligne `approval_requests`
  sans `tool_call_id`. Mutation rouge.
- `apps/runner/src/job/execute.ts` : `wouldRequireApproval` rend `true` pour un outil
  `asksUser` — `ask_user` n'entre jamais dans le pré-passage parallèle ; dans la boucle
  sérielle, la première question suspend, les suivantes sont `[DEFERRED]`. Commentaire du
  remplacement de marqueur complété. Test bout en bout : deux `ask_user` dans un même tour →
  UNE ligne (`tc-q-a`), un `[AWAITING_APPROVAL]`, un `[DEFERRED]` ; la réponse va à la bonne
  question ; le travail finit. Mutation rouge (deux lignes).

## Réponses aux constats de la passe 37

| Constat 37 | Réponse |
|---|---|
| P0 — reprise sans `toolCallId`, cyclique | plus de suspension sans id : erreur `question_without_call_id`. Vérifié à la source : tous les chemins vivants passent `toolCallId: call.id` (boucle sérielle, pré-passage, reprise `req.toolCallId ?? undefined`) — le cas n'existait que par un appelant sans id, et il est maintenant refusé |
| P0 — plusieurs `ask_user` par tour, pré-passage parallèle | `wouldRequireApproval` tient `asksUser` hors du pré-passage |
| P1 5-9 | aucun constat, rien à faire |
| P2 — textes de plateforme dans le runner | INCHANGÉ, et voici la lecture : la carte d'approbation existante porte déjà « ⏳ Approbation requise », « Tap a button below to decide », « Already approved. », « Not authorized. » — le dépôt interprète l'invariant #2 comme « le runner ne parle jamais À LA PLACE de l'agent » (sa question et son contexte sont verbatim), pas « le runner n'écrit aucun mot de chrome ». `notify.ts` le dit explicitement pour la ligne d'impact (« invariant #2 does NOT apply — platform UI »). Si tu contestes cette lecture, dis où la ligne doit passer pour les approbations EXISTANTES aussi |
| P2 — `o012` | dit dans le commentaire de `OPTION_SUFFIX` (index numérique, borné par la ligne) |

## Questions

1. **`question_without_call_id` et le transcript** : l'erreur revient au modèle comme résultat
   d'outil (`{ error }`) ; le modèle peut rappeler `ask_user` — avec un id cette fois, puisque
   la boucle en donne toujours un. Un chemin où le modèle boucle sur cette erreur ?
2. **`wouldRequireApproval` sert aussi ailleurs ?** Vérifier qu'aucun autre appelant ne lit ce
   `true` comme « une règle exige l'approbation » pour un autre usage (un compteur, une trace).
3. **Le `[DEFERRED]` de la seconde question** reste tel quel après la reprise si le modèle ne
   la repose pas : c'est le comportement de toute action différée. Rien de neuf ?

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
