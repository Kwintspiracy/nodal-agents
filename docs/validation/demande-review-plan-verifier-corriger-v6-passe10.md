# Demande de review — PLAN « Vérifier & Corriger » v6.3, passe 10

Objet : `docs/plans/verifier-corriger.md`, v6.3 du 03/09/2026. La passe 9
(rapport : `docs/validation/rapport-review-plan-verifier-corriger-v6-passe9.md`)
a fermé tout le reste et rendu 1 neuf bloquant : crash entre `completedAt`
et la livraison canal ⇒ root jamais relivré. Vérifié dans le code actuel
(bug latent existant). Traité dans la v6.3 : section « La livraison est une
action sortante — outbox » sous « La primitive terminale typée », et le
paragraphe « passe 2 → v3 » marqué historique.

Sandbox : lecture seule.

## Ce qui est demandé

1. **Le bloquant de la passe 9** : FERMÉ / NON FERMÉ. En particulier :
   `prepared` écrit dans la même transaction que le statut terminal ; tick à
   deux populations ; relance `attempted` avec la même clé ; borne à 3 ;
   canaux sans idempotence (Telegram) — le plan dit-il honnêtement le
   risque de doublon ? Le retrait de la livraison directe des chemins
   `return_result` / sans tool call / runtime CLI casse-t-il quelque chose
   que le plan ne voit pas (délai supplémentaire d'un tick pour les jobs
   interactifs ? — dire si c'est un problème et pour qui).
2. **Le résidu de la passe 9** : FERMÉ / NON FERMÉ.
3. **Constats neufs bloquants pour PR①** uniquement. PR① = fondations
   `code_project` seul, garde non branchée, aucune UI, pas de revue active,
   **outbox comprise** (elle ferme un bug existant, donc elle entre en ①).

## Hors périmètre

D1-D7. Style. Les six papiers. Les lots ②-⑤ au-delà de leur cohérence avec ①.
Ne pas re-lister les constats déjà fermés des passes 7-9.

## Format

Section 1 : FERMÉ / NON FERMÉ + preuve, + réponse à la question du délai.
Section 2 : FERMÉ / NON FERMÉ.
Section 3 : constats neufs bloquants numérotés — ou « aucun ».
Terminer par : « Passe 10 : N constats neufs bloquants ».
