# Demande de review — PR #73 « Un tour de chat ne reçoit que ce qu'il peut obéir », post-merge

Commit `0b95f451`, mergé le 13/09 **sans passe Codex** (dette de revue,
issue #88). Il est dans `main`.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** (fichier,
ligne, ce qui casse, comment le déclencher) ou **le constat est faux**. « Ça a
l'air bien » ne compte pas.

Lire `git show 0b95f451`, puis le code d'aujourd'hui :
`packages/catalog/src/types.ts` et `index.ts`, les quatre skills de
`packages/catalog/src/skills/`, `packages/orchestration/src/agent-baseline.ts`,
`system-prompt.ts`, `team-block.ts`, et le test
`packages/orchestration/src/tests/chat-surface-cost.test.ts`.

## Ce que la PR affirme

1. `SystemSkill.surfaces?: readonly PromptSurface[]` déclare, **dans le
   catalogue** (invariant #3), où le texte d'une skill peut être suivi.
   `skillAppliesOn(s, surface)` : omis vaut `['job']`.
2. Les trois skills baseline qui prescrivent des outils de fichiers disent
   `['job']` ; « Language mirror » dit `['job', 'chat']`.
3. `buildBaselineBlock` prend `surface` et filtre ; sur `chat` il omet en plus
   `MEMORY_DISCIPLINE_BLOCK` (qui ordonne `save_memory`).
4. `buildTeamBlock` gagne `escalation` : sur `chat`, le roster est rendu comme
   connaissance **plus** le chemin `run_task`, au lieu de la phrase du
   `cli-runtime` (« aucun moyen de leur confier du travail »), qui serait fausse.
5. Résultat mesuré : ~8 983 → ~4 770 jetons (−47 %) sur le vrai prompt d'Alfred.
6. Cinq tests, dont un qui MESURE l'écart (chat < 60 % d'un job).

## Questions, par priorité

### P0 — ce que le chat a VRAIMENT perdu

1. **La prémisse.** « Sur la surface `chat` l'agent a UN outil, `run_task` ».
   Est-ce vrai dans le code ? Trouver où la liste d'outils d'un tour de chat
   est calculée (invariant #9 : liste explicite par agent depuis la DB) et
   dire si `chat` peut recevoir d'autres outils — aujourd'hui, ou par
   configuration d'un agent. Si OUI, la PR retire des règles que l'agent
   POUVAIT suivre. C'est le constat qui coûterait le plus cher.
2. **`save_memory` sur le chat.** Même question, séparément : la surface `chat`
   a-t-elle réellement zéro accès à la mémoire (écriture) ? Si l'agent de chat
   peut écrire une mémoire par un autre chemin, retirer
   `MEMORY_DISCIPLINE_BLOCK` fait perdre des faits en silence — invariant #4
   (pas de repli silencieux) : le retrait est-il tracé quelque part ?
3. **Le défaut `['job']`.** `skillAppliesOn` présume `job` quand `surfaces` est
   omis. Toutes les skills `baseline` existantes sont-elles passées en revue ?
   Une skill baseline SANS dépendance à un outil qui aurait dû être sur `chat`
   et qui n'y est plus : la lister s'il y en a. Et : une skill de `kind`
   `channel` passe-t-elle par `contentOfKind('channel', surface)` — avec quel
   `surface` ? Le diff ne montre pas l'appel : est-il resté au défaut `job`,
   ce qui rendrait le champ inopérant pour les channels ?
4. **`jobContext?.surface ?? 'job'`.** Quelles valeurs `JobContext.surface`
   prend-elle réellement en base / à l'exécution ? Le type `PromptSurface` du
   catalogue et le type côté orchestration sont-ils le MÊME ensemble de
   littéraux ? Une valeur présente d'un côté et pas de l'autre (`undefined`,
   une chaîne libre) fait-elle tomber dans `job` par défaut — et donc réinjecte
   les 4 200 jetons sans que personne le voie ?

### P1 — le bloc d'équipe

5. `delegation: surface !== 'cli-runtime' && surface !== 'chat'` — la condition
   est écrite en négatif, donc **toute surface future délègue par défaut**.
   Est-ce le bon sens du défaut ici ? Et `escalation: surface === 'chat'` : un
   appelant qui passe `delegation: false` sans `escalation` obtient-il encore
   la phrase « aucun moyen », désormais fausse pour lui aussi ?
6. Le texte d'escalade nomme-t-il `run_task` en dur dans `team-block.ts` ?
   Si oui : invariant #2 (pas de texte utilisateur codé en dur dans le runner)
   et invariant #1 (métadonnées d'agent 100 % depuis la DB) — le nom de l'outil
   vient-il du registre ou est-il une chaîne littérale ? Et si l'agent de chat
   n'a PAS `run_task` (agent sans sous-agents, ou outil non whitelisté), le
   bloc lui prescrit-il un outil absent — exactement le défaut que la PR #74
   apprend à détecter ?
7. Le roster est rendu « comme connaissance » : il contient les descriptions
   des neuf sous-agents (1 267 jetons, non traités par cette PR). Sur le chat,
   sont-elles utiles ou est-ce le prochain poste de coût ? (Question ouverte,
   pas un constat attendu.)

### P2 — la mesure

8. Le test qui MESURE (`chat < 60 % d'un job`) : compte-t-il des jetons ou des
   caractères ? Si c'est une longueur, le chiffre « −47 % en jetons » du
   message de commit est-il soutenu par ce test, ou seulement par une mesure
   manuelle non reproductible ? Un seuil à 60 % est-il assez serré pour
   rougir si quelqu'un réinjecte UNE des trois skills ?
9. La mutation annoncée (« redéclarer une skill d'outils sur le chat fait
   rougir deux tests ») tient-elle en lisant les tests ?
10. Le test construit-il le prompt par le VRAI `buildSystemPrompt` (avec une
    DB de test) ou par un assemblage partiel ? Un assemblage partiel ne
    prouverait pas le chiffre.

### P3 — la forme

11. `contentOfKind` a maintenant un paramètre à valeur par défaut `'job'` :
    tous les appelants ont-ils été mis à jour, ou l'un d'eux reste-t-il au
    défaut par oubli ?
12. `PromptSurface` est exporté depuis `@nodal-agents/catalog` et importé par
    `orchestration` : la direction de dépendance respecte-t-elle les couches
    (`pnpm deps:check`) ?

## Hors périmètre

Le contenu des skills lui-même ; « Capabilities you can request » ; le cache
fournisseur ; style, nommage.

## Ce dont je doute moi-même

La prémisse « le chat n'a qu'un outil » (Q1-2). Toute la PR en dépend : si
elle est fausse même partiellement, on a retiré des instructions applicables.

## Forme du rapport

Les constats d'abord (fichier:ligne, comment le déclencher, gravité
bloquant / important / mineur), puis les douze questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf » ou
« des constats ».
