# Demande de review — PR #46, passe 23 (liste /spaces : réponse à la passe 22)

Périmètre : **le commit qui suit `6a2438e6`** (`listSpacesAction`, `page.tsx`, deux tests).

## Ce que la passe 22 a trouvé, et ce qui en a été fait

| Constat passe 22 | Vérifié | Ce qui a changé |
|---|---|---|
| Une limite globale de 200 lignes s'appliquait AVANT la séparation : 200 runs cron récents évinçaient toutes les conversations | Vrai | Deux requêtes, deux limites (`conversations` 100 par défaut, `scheduledRuns` 300), fusionnées puis triées du plus récent au plus ancien. Test pglite : une conversation Telegram ancienne survit à cinq runs cron plus récents avec une limite d'automatisations à 3 ; la délégation (enfant) n'apparaît pas ; l'ordre est décroissant toutes sections confondues. |
| `groupSpaces` suppose l'ordre reçu pour `lastRun` | Tient | Un test documente le prérequis (l'ordre inverse donne un dernier run faux). |
| `query_memory` → `search`, nom court dans les titres, lignes `table` déjà persistées | Tient | Inchangé |

## Ce dont je doute moi-même

Rien de neuf. Si cette passe ne trouve rien, la liste est close ; la suite est
P4 : le coût au plus près du réel (estimateur cache-aware alimenté par les prix
`input_cache_read` / `input_cache_write` d'OpenRouter, vérifiés le 06/09), puis
la barre d'état.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne
trouves rien de neuf. Un constat non exécuté est marqué NON EXÉCUTÉ.
