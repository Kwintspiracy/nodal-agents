# Demande de review — dette de la PR #73, passe 4 (dernière du budget)

Passe 3 : trois constats, tous fondés, tous corrigés.

- **1** — deux blocs ordonnaient encore ce que le chat ne peut pas faire, et
  aucun des deux ne nomme un outil : « Call them directly » du bloc `## Runtime`
  (que le vrai tour de chat déclenche toujours, il passe toujours un
  déploiement) et `attach_connector` / `attach_mcp` du bloc de découvrabilité.
  Le FAIT reste dans les deux cas, le geste devient celui du job.
- **2** — ma variante de la passe 2 avait emporté la procédure d'approbation
  d'une conversation. Ce n'est pas un geste de l'agent mais une chose que le
  PROPRIÉTAIRE fait, et c'est une question de conversation. Elle est revenue.
- **3** — trois commentaires qui énonçaient des règles que le code ne suit pas.

Cette passe relit le dernier commit. **C'est la dernière du budget** : si tu
trouves encore un BLOQUANT, dis-le clairement — c'est la forme de cette PR qui
sera en cause, et la boucle s'arrêtera là.

⚠️ Ce worktree résout les paquets FRÈRES vers le dépôt partagé : les tests
d'orchestration qui touchent au catalogue ne tournent pas ici. La CI décide.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les correctifs existent-ils ? Cite les lignes.
2. **Reste-t-il un ordre inexécutable sur le chat ?** Nom d'outil OU phrase.
   C'est la troisième fois que cette question rend un constat ; si elle en rend
   encore un, dis si c'est un oubli de plus ou si la forme est en cause.
3. Le chat a-t-il perdu un FAIT ?
4. Un job, un `cli-runtime`, un canal Telegram reçoivent-ils exactement ce
   qu'ils recevaient avant cette branche ? C'est le sens que je n'ai pas
   beaucoup sondé.

### P1

5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les autres PR de la dette ; `apps/qa` ; `apps/web/tests/e2e` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité — **BLOQUANT /
IMPORTANT / MINEUR** —, ET le SENS de l'erreur), puis les six questions avec
« tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de
neuf », « des constats », ou « la forme est en cause ».
