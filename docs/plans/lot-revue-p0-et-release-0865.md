# Lot « dette de revue » → release 0.8.65

Vingt-deux PR (#16 à #37) ont été mergées sans qu'aucune ne soit relue : le
dernier `review_verdict` du dépôt date du 20/08. Ce lot solde cette dette, puis
publie la 0.8.65.

## Suivi

| # | Lot | PR | État |
|---|-----|----|----|
| 1 | Correction des constats bloquants et majeurs des revues #16-#37 | [#38](https://github.com/Kwintspiracy/nodal-agents/pull/38) | 🔄 en revue (boucle revue → correction → revue) |
| 2 | Skill « dev » — le harnais qui manquait aux agents développeurs | à ouvrir | ⬜ |
| 3 | Onglet Code filtré par les porteurs du skill « dev » | à ouvrir | ⬜ |
| 4 | Profils d'agents (Dev team V1) — maquettes d'abord | à ouvrir | ⬜ |
| 5 | Release 0.8.65 | à ouvrir | ⬜ |

## 1. Ce que la revue a trouvé (PR #38)

### Trois P0

**Autonomie totale valait blanc-seing.** La relaxation `fully_autonomous` de
`packages/tools/src/execute.ts` transformait *toute* demande d'approbation en
auto-approbation. Un agent en Yolo lançait `run_command` et `code_task` sans
jamais franchir la barrière, même quand la politique de l'espace l'exigeait.
Le garde `isCodeExecutionTool` exclut désormais les six outils d'exécution.
`destructive_gate` reste inchangé : il juge chaque appel, ce n'est pas un
blanc-seing.

**Des entités en pause à tort.** La migration 0082 a posé
`auto_run_paused = true` sur des entités qui n'avaient rien demandé — leurs
agents ne démarraient plus. La 0084 les relâche. La 0082 est déjà appliquée :
on ne réécrit jamais une migration appliquée.

**Limitation de débit morte.** Le `getIp` de better-auth ne lit que
`x-forwarded-for`. En local il est absent, et `if (!ip) return null`
court-circuite *toute* la limitation — avant même que les règles custom soient
consultées. Le formulaire de connexion était sans plafond depuis l'ouverture du
mode LAN.

### Majeurs

- Le frein d'approbation couvre désormais aussi les agents en runtime CLI.
- La carte d'approbation `code_task` dit ce qui n'est **pas** réversible : les
  fichiers ignorés par git et les commandes lancées ne sont pas dans le
  point de restauration.
- Les champs injectés dans le prompt système sont neutralisés : un nom d'agent
  hostile ne peut plus forger une fausse section.
- Le parcours de dossiers ne bloque plus sur un lecteur réseau déconnecté.
- Un workspace posé sur une racine de disque ne fabrique plus de projets.

### Deux défauts trouvés par les tests de la correction elle-même

1. La remontée git était **non bornée** quand un fichier ne relevait d'aucun
   workspace : elle retenait un dépôt fortuit du dossier personnel, précisément
   le trou que la borne était censée fermer.
2. L'archivage d'un projet s'appuyait sur `isWorkspaceOwner`, qui répond
   toujours vrai en `local-trust`.

## 2. Skill « dev » — pourquoi il remplace la case à cocher

Constat de Quentin : les relecteurs ont `code-review`, les développeurs n'ont
rien. Aucun harnais ne dit à un agent développeur comment développer — d'où les
trois sessions où l'agent a cherché à l'aveugle, échoué, ou promis sans faire.

Sa conclusion, retenue : **si un agent développeur porte un skill dédié et
nécessaire, la case « agent développeur » n'a plus de raison d'exister.** Le
skill est à la fois la guidance et le marqueur. Un réglage de moins à connaître.

**Vérifié dans le code (25/08) :** cette case n'existe déjà pas comme booléen.
Il n'y a aucun champ `developer` ni `isCode` sur `agents` — ce que l'interface
présente comme « agent développeur » est l'assignation du skill système
`code-task`, qui débloque le builtin du même nom. La proposition de Quentin ne
supprime donc pas un réglage : elle donne un nom honnête à celui qui existe, et
lui ajoute ce qui lui manque — la guidance.

Un point de conception reste à trancher : `code-task` marque le codeur *par CLI*.
Un codeur purement LLM, qui édite avec `file_edit` / `file_write` sans CLI, n'en
porte pas — c'est exactement le trou qui rendait l'onglet Code aveugle à lui.
Le skill « dev » doit donc marquer l'identité **indépendamment du moyen**, et
c'est lui, pas `code-task`, qui filtre l'onglet Code.

Contenu visé : lire avant d'écrire, éditions ciblées plutôt que réécritures,
respect des conventions du projet, vérification avant de déclarer fini, et la
règle d'organisation « une app = un dossier de premier niveau ».

Livraison : un fichier dans `packages/catalog/src/skills/`, une entrée dans
`systemSkills`, et le seeder du runner pose la ligne en base au boot. Aucune
migration SQL.

## 3. Onglet Code filtré par les porteurs du skill

Aujourd'hui l'onglet Code qualifie une session par le contenu des fichiers
touchés. C'est pour ça que le coffre Obsidian de Quentin y apparaît, et qu'un
workflow ComfyUI a failli y apparaître aussi.

**Règle posée par Quentin, non négociable :** pas d'exclusion par langage. Un
`.json` peut parfaitement être du vrai code — des données de test, par exemple.
Une exclusion par extension ratera du vrai code tôt ou tard.

La sélection se fait donc par l'**identité de l'agent** : seules les sessions
d'agents porteurs du skill « dev » entrent dans l'onglet Code.

## Vérification

- PR #38 : `pnpm test` 33/33, `pnpm typecheck` 33/33, `pnpm lint` 0 erreur.
- Boucle de revue : relecteurs indépendants relancés après chaque correction,
  jusqu'à ce qu'ils ne trouvent plus rien de bloquant.

## Next steps

### Ce que je peux faire seul
- Finir la boucle de revue sur la #38 et la merger une fois verte.
- Ouvrir les PR 2 et 3.
- Préparer la 0.8.65 (changelog, bump, build-pack, smoke-pack).

### Gestes de Quentin
- **Révoquer les tokens Discord et Slack** — fuités le 08/08, toujours pas
  confirmés révoqués. Le geste le plus urgent du dépôt.
- `npm publish` et le tag de la 0.8.65.

### En attente d'une décision
- Profils d'agents : maquettes avant implémentation, comme demandé.
