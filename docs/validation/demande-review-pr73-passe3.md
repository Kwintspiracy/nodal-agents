# Demande de review — dette de la PR #73, passe 3

Passe 2 : trois constats importants, tous fondés, tous corrigés.

- **1** — quatre autres blocs testaient `cli-runtime` seul : skills, canaux,
  dossiers, mémoire, conversation. Il y a maintenant UN `hasNodalTools` pour les
  deux surfaces qui n'ont pas les outils de Nodal, pour des raisons opposées.
  Rien n'est retiré : dossiers, plateformes, skills et souvenirs restent des
  FAITS ; seuls les gestes partent. La fixture du test n'avait ni dossier, ni
  skill, ni conversation — elle les a maintenant, et c'est ce qui a rendu ces
  fuites visibles.
- **2** — l'ancienne assertion exigeait l'absence des deux TITRES sur le chat,
  c'est-à-dire refusait le correctif de la passe 1. Elle lit maintenant les
  PHRASES de job.
- **3** — mon texte de chat de « Verify before done » avait affaibli la
  fraîcheur de la preuve. La péremption, le succès rapporté et la vérification
  partielle y sont revenus, sans aucun outil.

Cette passe relit les trois derniers commits.

⚠️ Ce worktree résout les paquets FRÈRES vers le dépôt partagé : les tests
d'orchestration qui touchent au catalogue ne tournent pas ici. La CI, elle,
installe pour de vrai, et c'est elle qui a trouvé la dernière fuite
(`skill_view` dans l'index des skills). Ne conclus rien d'un rouge local de
cette forme.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les correctifs existent-ils ? Cite les lignes.
2. **Reste-t-il un ordre inexécutable sur le chat ?** `hasNodalTools` est-il lu
   partout où un bloc prescrit un geste ? Cherche aussi ce qui n'est pas un nom
   d'outil : une phrase qui dit « lis le fichier », « relance la commande ».
3. **Le chat a-t-il perdu un FAIT** en même temps que les gestes — quelque chose
   que l'agent devrait pouvoir dire à l'utilisateur et qu'il ne peut plus ?
4. La bascule `fileTools: 'nodal' | 'own' | 'none'` change-t-elle ce que reçoit
   `cli-runtime` ? Elle ne devrait rien y changer du tout.

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
