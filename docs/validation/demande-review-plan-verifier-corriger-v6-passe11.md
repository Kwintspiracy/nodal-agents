# Demande de review — PLAN « Vérifier & Corriger » v6.4, passe 11 (dernière sur plan)

Objet : `docs/plans/verifier-corriger.md`, v6.4 du 03/09/2026. La passe 10
(rapport : `docs/validation/rapport-review-plan-verifier-corriger-v6-passe10.md`)
a fermé le bloquant et le résidu de la passe 9, et rendu 2 neufs bloquants,
tous deux dans le correctif outbox : absence de claim atomique, et latence
de 120 s pour les jobs interactifs. Traités dans la v6.4 : § « Claim
atomique » et « Drain immédiat, tick en reprise » sous « La livraison est
une action sortante — outbox ».

Ceci est la **dernière passe sur plan**. Au-delà, les questions restantes se
trancheront dans PR① avec du code et des tests.

Sandbox : lecture seule.

## Ce qui est demandé

1. **Les deux bloquants de la passe 10** : FERMÉ / NON FERMÉ, avec preuve.
   Sur le claim : le `WHERE` est-il correct sous `READ COMMITTED` (deux
   `UPDATE … RETURNING` concurrents sur la même ligne — un seul gagne) ?
   Le lease de 60 s est-il cohérent avec les timeouts d'envoi des adaptateurs
   existants (chercher un timeout dans `packages/adapters/*/src` ou dans
   `packages/delivery`) ? Sur le drain : un `drainDeliveries` appelé dans le
   même processus après le commit peut-il lui-même être en course avec un
   tick (réponse attendue : oui, et c'est le claim qui arbitre — dire si le
   plan le dit).
2. **Constats neufs bloquants pour PR①** uniquement, en excluant tout ce qui
   est déjà fermé (passes 7-10). PR① = fondations `code_project` seul, garde
   non branchée, aucune UI, pas de revue active, outbox comprise.

## Hors périmètre

D1-D7. Style. Les six papiers. Les lots ②-⑤. Ne pas re-lister les fermés.

## Format

Section 1 : FERMÉ / NON FERMÉ ×2 + réponses aux trois sous-questions.
Section 2 : constats neufs bloquants numérotés — ou « aucun ».
Terminer par : « Passe 11 : N constats neufs bloquants ».
