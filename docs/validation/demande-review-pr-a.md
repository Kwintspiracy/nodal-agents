# Demande de review — PR A (#10), observabilité des sessions de code

Branche `feat/code-observability` → `main`. 2 commits.

**Ton rôle : essayer de me démonter, pas de me confirmer.** Deux verdicts valent
— « le constat tient » et « le constat est faux ». Un troisième ne vaut pas :
« ça a l'air bien ».

Ne corrige rien. Rends un rapport. Un point que tu ne peux pas vérifier se
rapporte **NON VÉRIFIÉ**, jamais conclu par supposition.

---

## Ce que la PR affirme

Qu'une session `code_task` était invisible pendant qu'elle tournait, qu'on ne
savait pas quel CLI l'avait exécutée, et qu'un dépassement du plafond de capture
produisait une erreur accusant le CLI au lieu de notre propre plafond.

## Priorité 1 — le découpage de flux est-il correct ?

C'est le seul code réellement nouveau, et il tourne sur **chaque octet** que
produit un CLI. Un défaut ici touche toutes les sessions.

`process.ts`, fonction `emitLines` et la vidange dans `finish` :

1. **Le découpage résiste-t-il à un chunk qui coupe une ligne en deux ?** Un
   `data` peut se terminer au milieu d'un objet JSON. Trace ce qui arrive à
   `lineBuf` sur deux chunks successifs.
2. **Et à un `\r\n` ?** Les deux CLI tournent sous Windows ici. Je découpe sur
   `\n` et j'applique `.trim()` — est-ce que ça suffit dans tous les cas, ou
   est-ce que je laisse passer un `\r` quelque part ?
3. **La vidange finale peut-elle émettre deux fois la même ligne ?** `finish`
   émet `lineBuf + outDecoder.end()`. Si `close` et le minuteur se déclenchent
   tous les deux, le garde `settled` suffit-il ?
4. **`outDecoder.end()` appelé dans `finish` casse-t-il l'accumulation de
   `stdout` ?** Le décodeur est partagé entre les deux chemins.
5. Un caractère multi-octets (é, emoji) coupé entre deux chunks : je passe par
   `StringDecoder`, mais **le vérifier** plutôt que me croire.

## Priorité 2 — l'appariement des événements

`live-events.ts` transforme des lignes en paires `tool_use` → `tool_result`.

1. **Les formes que je parse sont-elles les vraies ?** Je me suis appuyé sur ma
   lecture des formats `stream-json` (claude) et `--json` (codex). Confronte-les
   à la documentation ou à une trace réelle. **Si une forme est fausse, le
   correctif ne produit rien du tout** — et rien ne le signalerait, puisque
   l'absence de ligne ressemble à une session sans outil.
2. **Une paire jamais fermée fuit-elle ?** `pending` grandit à chaque `use`. Une
   session qui ouvre mille outils sans en fermer un seul garde-t-elle mille
   entrées en mémoire ?
3. **Les ids peuvent-ils se collisionner** entre deux sessions du même job ?
   `toolCallId` est écrit en base ; deux `code_task` dans un même job partagent
   le `jobId`.
4. `redactSecretsForAudit` est appliqué à l'entrée. **L'est-il à la sortie ?**
   Le résultat d'un outil peut contenir un secret lu dans un fichier.

## Priorité 3 — ce que le point 2 corrige vraiment

J'affirme dans la PR avoir **corrigé ma propre spec** : une sortie tronquée
n'était pas silencieuse, elle échouait déjà.

Vérifie ce constat corrigé, pas l'original :

1. Les trois cas d'échec que je liste sont-ils exacts ? Lis les deux analyseurs.
2. Existe-t-il un **quatrième cas** où une troncature passerait effectivement
   inaperçue ? C'est ce que je cherchais et n'ai pas trouvé — trouve-le si il
   existe.
3. Le nouveau message est-il déclenché au bon endroit ? `run.truncated` couvre
   **stdout ET stderr** (le même drapeau sert aux deux). Une troncature de
   stderr seule produirait-elle un message qui accuse le plafond à tort ?

## Priorité 4 — mes tests prouvent-ils quelque chose ?

Applique la question qui compte : **si je casse le produit, ce test rougit-il ?**

| Mutation | Attendu |
|---|---|
| Livrer les lignes en fin de course au lieu du fil de l'eau | rougit — **exécutée, 1 rouge sur 4** |
| Retirer la vidange de la dernière ligne dans `finish` | rougit |
| Faire renvoyer `null` à `parseLiveToolEvent` pour claude | rougit |
| Retirer `providers` de la requête `cli_runs` | ? — **je n'ai aucun test dessus** |

La dernière ligne est un aveu : les points 4 et 5 n'ont **aucun test**. Dis si
c'est acceptable pour de l'affichage, ou si un test de la couche action est dû.

## Priorité 5 — ce que je n'ai pas mesuré

Le crochet tourne sur chaque chunk et fait un `JSON.parse` par ligne. Une
session verbeuse en produit des milliers.

- Est-ce que ça ralentit une session réelle de façon perceptible ?
- Les insertions sont sans attente (`void db.insert(...)`). Mille outils
  produisent mille insertions concurrentes — le pool y survit-il ?

Je n'ai mesuré ni l'un ni l'autre. Si tu ne peux pas les exécuter, dis-le.

## Hors périmètre

Le nommage « CLI » (PR B), le serveur MCP (PR C), et les 5 tests de
`delivery-guard` qui dépendent du chemin du dépôt — trou d'outillage connu.

## Ce que je n'attends pas

Un avis sur le style ou le nommage. Une liste de constats, chacun avec le
fichier, la ligne, et **ce qui casse concrètement**.
