# Demande de review — PR #8 (un agent en runtime CLI recevait sa personnalité brute)

Branche `fix/harness-bugs` → `main`. 4 fichiers, +147/−4.
Les checks CI sont verts : ce n'est pas ce qu'on te demande de vérifier.

**Ton rôle : essayer de me démonter, pas de me confirmer.** Deux verdicts sont
utiles — « le constat tient » et « le constat est faux ». Un troisième ne l'est
pas : « ça a l'air bien ».

Ne corrige rien. Rends un rapport.

---

## Ce que la PR affirme

Un agent en `runtime: 'claude-code'` — job ou chat — recevait comme prompt
système **le champ `personality` de sa ligne en base, brut**. Pas le prompt
construit par `buildSystemPrompt`.

Conséquence : cet agent ne voyait **rien** de ce que Nodal sait de lui. Pas son
équipe, pas sa mémoire, pas ses skills, pas ses workspaces, pas l'état du dépôt.
Il n'était un agent Nodal que par son nom.

Le correctif fait passer les deux chemins par `buildSystemPrompt`, avec une
nouvelle valeur de surface : `'cli-runtime'`.

## Priorité 1 — la surface `'cli-runtime'` retire-t-elle la bonne chose ?

C'est le seul vrai choix de design de la PR, et le plus facile à rater.

`buildSystemPrompt` omet le bloc « built-in capabilities » pour `'chat'`. Je lui
ajoute `'cli-runtime'`, avec ce raisonnement : un agent Claude Code n'a **pas**
les builtins Nodal (`file_write`, `query_memory`…) ; il a la palette du CLI
(`Read`, `Write`, `Bash`). Documenter les premiers l'invite à appeler ce qui
n'existe pas.

Ce que je te demande de vérifier, dans cet ordre :

1. **Est-ce que je retire trop peu ?** Passe en revue les autres blocs que
   `buildSystemPrompt` assemble — équipe, mémoire, skills, workspace, git,
   registre d'actions, directives de livraison. Pour **chacun**, demande-toi :
   ce bloc décrit-il un mécanisme qu'un agent Claude Code peut réellement
   actionner ? Si un seul décrit un outil Nodal que le CLI n'a pas, j'ai le même
   bug qu'avant, ailleurs.
   Le cas que je soupçonne le plus : les **skills**. Un bloc de skills qui dit
   « appelle `load_skill` » n'a aucun sens dans une session Claude Code.

2. **Est-ce que je retire trop ?** À l'inverse : y a-t-il dans le bloc builtin
   une information qui n'est PAS un catalogue d'outils et qui manque maintenant
   à l'agent CLI ?

3. `'chat'` et `'cli-runtime'` reçoivent aujourd'hui **exactement** le même
   traitement. Est-ce une coïncidence qui va diverger, ou faut-il les fusionner ?
   Un `||` sur deux littéraux qui ne divergent jamais est du code qui ment sur
   son intention.

## Priorité 2 — les deux chemins sont-ils vraiment alignés ?

`run-job.ts` et `run-chat.ts` sont deux appelants distincts de `runClaudeTurn`.
J'ai modifié les deux. **C'est exactement la forme de bug que cette PR corrige** :
un second chemin oublié.

- Les deux construisent-ils le prompt avec les **mêmes** arguments ? Une
  différence non intentionnelle (un `jobContext` plus pauvre côté chat) rejoue
  le bug en plus discret.
- Y a-t-il un **troisième** appelant que j'ai raté ? Cherche toute construction
  de tour CLI dans `apps/runner`, pas seulement dans `cli-runtime/`.
- Le chemin chat n'a pas de `jobId`. Est-ce que `buildSystemPrompt` se comporte
  correctement sans, ou est-ce qu'un bloc se retrouve vide sans que rien ne le
  signale ?

## Priorité 3 — le coût, que je n'ai pas mesuré

Le prompt système d'un agent en runtime CLI passe de quelques lignes à un prompt
Nodal complet. Sur un abonnement, ça se paie en fenêtre de contexte à chaque
tour, **et à chaque reprise de session**.

Je n'ai pas mesuré. Si tu peux : compare la taille avant/après sur un agent réel,
et dis si le bloc `git`/`workspace` mérite d'être là à chaque tour ou seulement
au premier. Un « oui c'est mieux » sans chiffre ne m'aide pas.

## Priorité 4 — mon test prouve-t-il quelque chose ?

`cli-runtime-surface.test.ts`, 102 lignes. Applique-lui la question qui compte :
**si je casse le produit, ce test rougit-il ?**

Mutations à tenter, une par une :

| Mutation | Le test doit |
|---|---|
| Retirer `'cli-runtime'` de la condition du bloc builtin | rougir |
| Repasser `run-chat.ts` à `agentRow.personality` brut | rougir |
| Repasser `run-job.ts` à `agentRow.personality` brut | rougir |

Si une seule reste verte, dis-le — c'est le constat le plus utile du rapport.
J'ai écrit trois tests de mutation invalides dans ce lot ; je n'ai aucune raison
de croire que celui-ci est bon.

## Hors périmètre

La continuité de session, la conscience du dépôt et les points de restauration
sont dans la **PR #7**. Le catalogue de modèles est dans la **#9**.

## Ce que je n'attends pas

Un avis sur le style, sur les commentaires, ou sur le nommage. Le seul livrable
utile est une liste de constats, chacun avec le fichier, la ligne, et **ce qui
casse concrètement** si j'ai tort.
