# Demande de review — dette de la PR #73, passe 2

Passe 1 : quatre constats, deux importants, deux mineurs. Les deux importants
sont corrigés ; les mineurs le sont ou sont dits.

- **1 (important)** — `surfaces` est un interrupteur, et il emportait les règles
  PORTABLES avec celles qui prescrivent un outil. Le chat en devenait plus
  enclin à affirmer sans preuve, l'inverse du but de la PR. Une skill peut
  maintenant écrire ce qui reste vrai d'elle sans outil (`contentOnChat`), et
  `skillContentOn` est le seul endroit qui choisit. Tests dans le catalogue,
  mutation.
- **2 (important)** — trois blocs prescrivaient encore un outil absent du chat :
  `save_memory`, `skill_view` / `run_skill_script`, `return_result`. Chacun a
  une version pour une surface sans ces outils ; aucune règle n'est perdue. Le
  nouveau test lit le TEXTE, pas les titres.
- **3 et 4 (mineurs)** — la mesure du test de coût est en caractères, pas en
  jetons : dit dans le test. Le défaut latent de `buildChannelBlock` (une skill
  `channel` qui déclarerait `surfaces: ['chat']`) reste ouvert : aucun channel
  ne le déclare, et `types.ts` dit que les channels ne lisent pas ce champ.

Cette passe relit `f08c6a99` et `cbb2a723`.

⚠️ Ce worktree résout les paquets FRÈRES vers le dépôt partagé : `packages/orchestration`
y lit le catalogue de `main`, pas celui de cette branche. Les tests
d'orchestration qui touchent au catalogue ne peuvent donc pas tourner ici ; la
CI, elle, installe pour de vrai. Ne conclus rien d'un rouge local de cette
forme.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les correctifs existent-ils ? Cite les lignes.
2. **Reste-t-il, dans le prompt d'un tour de chat, un ordre que l'agent ne peut
   pas suivre ?** Prends toutes les combinaisons : rôle `agent` et
   `orchestrator`, modèle frontière et non frontière, agent avec et sans équipe,
   avec et sans canal, avec et sans dossier de travail.
3. **Le texte de chat des deux skills retire-t-il une règle qui vaut encore ?**
   C'est le sens inverse du constat 1, et il coûterait aussi cher.
4. `skillContentOn` peut-il rendre le texte de job sur une surface qui n'a pas
   les outils — par un `surfaces` mal déclaré, un `kind` inattendu, un appel
   depuis `cli-runtime` ?

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
