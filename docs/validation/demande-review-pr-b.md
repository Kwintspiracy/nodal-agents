# Demande de review — PR B (#11), nommage « CLI »

Branche `fix/cli-naming` → `main`. 1 commit, ~40 lignes de copie.

**Ton rôle : essayer de me démonter, pas de me confirmer.** Un point que tu ne
peux pas vérifier se rapporte **NON VÉRIFIÉ**. Ne corrige rien, rends un rapport.

C'est une PR de **texte**. Elle n'a donc pas de test possible au sens habituel,
et c'est précisément ce qui la rend risquée : la seule chose qui puisse être
fausse ici, c'est ce qu'elle **affirme**.

---

## Priorité 1 — la bannière dit-elle la vérité, maintenant ?

`AgentComposer.tsx`, `RuntimeInertTabPanel`.

L'ancien texte affirmait que « le harnais ne reçoit QUE la personnalité de cet
agent ». C'était devenu faux avec la PR #8. Je l'ai réécrit, et je peux tout à
fait avoir remplacé un mensonge par un autre.

Confronte **chaque affirmation** du nouveau texte à ce que
`buildSystemPrompt(..., { surface: 'cli-runtime' })` construit réellement :

| Ce que la bannière affirme recevoir | Vrai ? |
|---|---|
| son identité | |
| sa personnalité | |
| ses faits mémoire | |
| les chemins absolus de ses workspaces | |
| l'état du dépôt | |
| la liste de ses coéquipiers | |

| Ce qu'elle affirme NE PAS recevoir | Vrai ? |
|---|---|
| les outils de Nodal | |
| les skills | |
| les connecteurs | |
| les serveurs MCP | |
| les approbations par outil | |

Et la dernière phrase : « elle ne peut pas confier de travail à ses coéquipiers ».
Est-ce encore exact sur cette branche ?

**Le cas qui m'inquiète** : « l'état du dépôt » n'est rendu que si la sonde git
répond. « les chemins des workspaces » n'apparaissent que s'il y en a. La
bannière énonce ces choses sans condition — est-ce un mensonge par omission pour
un agent sans workspace ou hors dépôt ?

## Priorité 2 — les intitulés sont-ils exacts, pas seulement différents ?

Les renommer les distingue. Encore faut-il qu'ils soient **vrais**.

1. « Call a coding CLI (tool) » — l'agent reste-t-il vraiment un agent Nodal,
   avec sa boucle, quand il utilise `code_task` ?
2. « Run this agent ON Claude Code » — « il n'y a pas de boucle Nodal » est-il
   exact, ou Nodal en garde-t-il une part ?
3. « What runs this agent's turns » — est-ce que ça décrit bien le champ
   `agents.runtime`, ou est-ce que ce champ fait autre chose en plus ?
4. Les deux renvois croisés (« that is in Settings » / « on the Tools tab »)
   pointent-ils vers les bons endroits **tels qu'ils s'appellent à l'écran** ?

## Priorité 3 — ce que j'ai décidé de ne pas faire

Aucun test ne garde cette bannière. J'ai posé un commentaire renvoyant à
`cli-runtime-surface.test.ts` plutôt qu'une assertion inter-paquets.

**Challenge cette décision.** Mon argument : comparer deux textes ne vérifie
qu'une faute de frappe, et le coût d'un import `apps/web` → `orchestration`
dépasse le bénéfice. Le contre-argument : cette bannière a menti pendant une
journée entière sans que rien ne le signale, et un commentaire ne l'aurait pas
empêché.

Si tu vois une garde peu coûteuse que je n'ai pas vue, c'est le constat le plus
utile de cette review.

## Priorité 4 — ai-je laissé des « Coding CLI » ambigus ?

Cherche les occurrences restantes dans `apps/web`. Certaines sont des
commentaires de code (acceptables). Y en a-t-il d'autres **visibles à l'écran**
qui gardent l'ancien nom ambigu ?

## Hors périmètre

Le serveur MCP (PR C). Le comportement lui-même — cette PR ne change **aucune**
logique, seulement du texte. Si tu trouves un changement de comportement, c'est
un bug et il est prioritaire sur tout le reste.

## Ce que je n'attends pas

Un avis sur le style de la copie. Ce qui compte est : **est-ce vrai ?**
