## Section 1 — Bloquant de la passe 9

**FERMÉ.** La primitive écrit `prepared` dans la transaction du statut terminal (`docs/plans/verifier-corriger.md:488-491`). Le tick traite les roots non terminaux et les livraisons `prepared`/`attempted` sans reçu, limite les tentatives à trois, puis rejette et alerte (`docs/plans/verifier-corriger.md:493-496`). Une reprise conserve la même clé d’idempotence (`docs/plans/verifier-corriger.md:497-498`). Le risque résiduel de doublon sur Telegram est explicitement reconnu (`docs/plans/verifier-corriger.md:498-500`).

**Délai : problème réel pour les jobs interactifs.** Le retrait des envois directs impose d’attendre le tick suivant (`docs/plans/verifier-corriger.md:500-504`), alors que le ticker actuel a un intervalle par défaut de 120 secondes (`apps/runner/src/cron/ticker.ts:30`, `apps/runner/src/cron/ticker.ts:54`). Cela dégrade `return_result`, le chemin sans tool call et le runtime CLI, dont l’envoi est actuellement immédiat après `completeJob` (`apps/runner/src/cli-runtime/run-job.ts:400-419`). Le cron task-board, déjà asynchrone, n’est pas concerné. Il faut déclencher un drain immédiat de l’outbox après commit, le tick restant le mécanisme de reprise.

## Section 2 — Résidu de la passe 9

**FERMÉ.** Le paragraphe est désormais explicitement historique et nomme les trois remplacements normatifs : prédicats par livrable, `snapshot_id` et manifeste unique à six champs (`docs/plans/verifier-corriger.md:734-740`).

## Section 3 — Constats neufs bloquants pour PR①

1. **La réclamation concurrente des livraisons n’est pas spécifiée.** Le plan sélectionne les lignes `prepared` ou `attempted`, puis écrit `attempted` avant l’envoi (`docs/plans/verifier-corriger.md:492-497`), sans définir de CAS, verrou, lease ou propriétaire de réclamation. Deux ticks peuvent donc envoyer simultanément la même ligne ; sur Telegram, cela crée des doublons sans crash, au-delà du risque de reprise honnêtement accepté. Il faut un protocole de claim atomique et un test d’interleaving à deux connexions.

2. **Le passage exclusif par le tick introduit jusqu’à deux minutes de latence interactive.** Le plan retire les livraisons directes de `return_result`, du chemin sans tool call et du runtime CLI (`docs/plans/verifier-corriger.md:500-503`), tandis que le ticker actuel attend 120 secondes entre deux passages (`apps/runner/src/cron/ticker.ts:30`, `apps/runner/src/cron/ticker.ts:54`). PR① doit prévoir et tester un drain immédiat post-commit pour ces chemins, avec le cron comme reprise durable.

Passe 10 : 2 constats neufs bloquants
