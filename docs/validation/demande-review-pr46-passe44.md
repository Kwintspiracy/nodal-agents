# Demande de review — PR #46, passe 44 (P10b : la liaison texte abandonnée, l'approbation à la place)

Périmètre : **un commit** (le dernier « fix(projects): créer un projet depuis la conversation
passe par l'approbation … (passe Codex 41) », 5 fichiers). Un agent code P12 en parallèle
dans d'autres fichiers (`xlsx.ts`, `presenters.ts`, `tool-cards.ts`, `conversation-actions.ts`,
`ConversationFeedView.tsx`), NON committé : relire l'état COMMITTÉ, jamais l'arbre.

## Ce qui a été décidé, et pourquoi

Trois passes (39, 40, 41) ont mis en défaut trois formes de la même garde de `register_project`
(« une question répondue suffit » ; la sous-chaîne ; l'égalité contre un nom d'affichage non
unique). Décision : **plus de liaison par le texte de l'option**. `register_project` déclare
`defaultApproval: 'require_approval'` — « où ranger ? » (la question, `ask_user`) puis
« créer ce dossier ? » (la carte d'approbation ordinaire, qui montre le dossier). Relâché
seulement par le propriétaire : une règle `auto_approve` explicite sur cet outil, ou une
autonomie qui laisse passer un outil non destructif (`fully_autonomous` ; `destructive_gate`
puisque `riskLevel: 'write'`). Retirés : `computeApproval`, `jobAnsweredForProject`, `fold`,
`lastSegment`, la borne. La consigne du prompt et la description de l'outil disent la
confirmation. L'alternative en un clic — une autorisation STRUCTURÉE portée par l'option de la
question — est consignée au plan comme pierre à part.

- `packages/tools/src/builtin/register-project.ts`, `tests/builtin/register-project.test.ts`
  (14 : sans règle → `awaiting_approval` MÊME avec une question répondue qui nomme exactement
  le projet, ligne `approval_requests` de kind `approval` ; règle explicite → passe ;
  `fully_autonomous` sans règle → passe ; reprise après approbation → crée ; création,
  `created: false`, hors terrain, nom du propriétaire, rollback et ses échecs conservés),
  `packages/orchestration/src/system-prompt.ts` + test (37), `tests/projects/attach-seam.test.ts`
  (le bout en bout modélise un propriétaire qui a accordé la règle).

## Mesuré

register-project 14 ; attach-seam ; system-prompt 37 ; tools 929 ; orchestration 239 ;
typecheck des deux paquets ; lint 0 erreur. Mutations rouges : `defaultApproval` retiré (2,
refaite par l'orchestrateur : le cas « sans règle » rougit) ; précédence de la porte inversée
(8).

## Questions

1. **La porte** : `defaultApproval: 'require_approval'` sur un outil `riskLevel: 'write'`
   — confirmer, dans `packages/tools/src/execute.ts`, ce que chaque niveau d'autonomie en fait
   (`propose_confirm` gate ; `destructive_gate` → `auto_approve` car non destructif ;
   `fully_autonomous` → `auto_approve`), et qu'aucun plancher ne re-gate. Le commentaire du
   code le dit ainsi ; est-ce exact ?
2. **La carte d'approbation** pour `register_project` : `buildApprovalCardBody` /
   `explainApprovalRequest` savent-ils dire ce que fait cet outil (« creates the folder X and
   registers it as a project ») ou tombe-t-on sur la ligne d'impact générique ? Si générique,
   dire où brancher l'explication (pas de code attendu dans cette passe).
3. **Rien ne subsiste de la liaison texte** : vérifier qu'aucun test, commentaire ou texte de
   prompt n'en parle encore (`grep` sur `jobAnsweredForProject`, `fold(`, « exactly the name »).

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
