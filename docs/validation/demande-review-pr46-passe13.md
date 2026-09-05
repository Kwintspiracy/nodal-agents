# Demande de review — PR #46, passe 13 (P1 : réponse à la passe 12)

Périmètre : **HEAD, le commit qui suit `9d37b16f`**. Toujours P1 du plan
« De la maquette au produit ». Rien d'autre n'a bougé.

## Ce que la passe 12 a trouvé, et ce qui en a été fait

| Constat passe 12 | Vérifié à la source | Ce qui a changé |
|---|---|---|
| **P1** — `list_models`, `list_schedules`, `list_conversations` ne rendent pas des lignes mais une ENVELOPPE (`{ ok, models }`, `{ ok, schedules }`, `{ channel, conversations, note?, truncated? }`) ; une carte `table` ne saurait pas quel champ ouvrir sans dispatcher par nom — ce que le contrat interdit | Vrai (`list-models.ts:24`, `list-schedules.ts:31`, `list-conversations.ts:56`) | Les trois reviennent à `text`. `query_memory` reste `table` (sortie = `MemoryRecord[]`, nue). La table attendue du test suit, et le commentaire de `table` dit désormais la règle : « la sortie EST le tableau, ou l'écran sait où le lire ». |
| `code_task → delegation` | La passe 12 le juge juste | Inchangé |
| Lever dans `cardForTool` / `declaresCard` | La passe 12 le juge cohérent avec « fail loud » | Inchangé |
| Table exhaustive nom → carte | Tient | Inchangée hors les trois lignes ci-dessus |

Mesuré : `cards.test.ts` 9 verts après la requalification.

## Ce dont je doute moi-même

### `xlsx_read` → `table` : la même objection s'applique-t-elle ?

`XlsxReadOutput` est aussi une enveloppe : `{ ok: true, sheets: [{ name, rows,
truncated }] } | { ok: false, error }` (`xlsx.ts:251`). Je l'ai LAISSÉ en
`table` parce que c'est l'archétype de la carte (un classeur, des feuilles, des
lignes) et que P8 « le tableur rendu » est écrit pour lui. Mais au pied de la
lettre de la passe 12, l'écran devra ouvrir `sheets[].rows` — un chemin propre
à cet outil. Deux lectures :

1. la carte `table` définit UN contrat de sortie (`T[]` nu, ou `{ sheets }`),
   et `xlsx_read` comme `query_memory` le respectent chacun à leur manière —
   alors il faut l'ÉCRIRE dans P2, pas le laisser implicite ;
2. ou `xlsx_read` doit aussi redescendre en `text` tant que le contrat de la
   carte n'est pas écrit.

Trancher. Je penche pour (1), écrit noir sur blanc dans P2 : chaque carte
nomme la forme de sortie qu'elle lit ; un outil qui déclare la carte sans
respecter la forme est refusé par un test, comme aujourd'hui une carte
inventée.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts valent : tient / faux. Un constat non
exécuté est marqué NON EXÉCUTÉ.
