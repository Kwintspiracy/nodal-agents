# Demande de review — PLAN « Vérifier & Corriger » v6.2, passe 9

Objet : `docs/plans/verifier-corriger.md`, v6.2 du 03/09/2026. La passe 8
(rapport : `docs/validation/rapport-review-plan-verifier-corriger-v6-passe8.md`)
a rendu : Q2/Q4/Q6/Q8/Q9/Q11 FERMÉ ; Q1/Q3/Q5/Q7/Q10 PARTIEL ; 5 constats de
cohérence résiduelle ; 1 neuf bloquant (deux contrats de hash). Tous traités
dans la v6.2 — table « Traçabilité passe 8 → v6.2 » du plan.

Sandbox : lecture seule.

## Ce qui est demandé

1. **Chaque PARTIEL et le bloquant de la passe 8** : FERMÉ / NON FERMÉ, avec
   la phrase du plan qui ferme, ou ce qui manque encore. Ne pas re-lister ce
   qui est fermé au-delà du mot FERMÉ.
2. **Cohérence résiduelle, une dernière fois** : reste-t-il une phrase du
   texte conservé (modèle central, protocole transactionnel, PR②, PR③,
   matrice des écrivains, contrat par surface) qui contredit la v6.2 —
   `content_id`, incrément par verdict, « projet » là où « livrable » est
   requis pour un prédicat ou un test nommé, hash à cinq champs ? Citer.
3. **Le cron** : le contrat de reprise idempotente (marqueur `finalizing_at`,
   tick qui ignore un cycle ouvert, clôture qui efface le marqueur,
   re-réclamation) a-t-il un trou — un root qui ne serait jamais relivré, ou
   livré deux fois, ou un cycle recréé ? Dire le scénario exact.
4. **Constats neufs bloquants pour PR①** uniquement (PR① = fondations
   `code_project` seul, garde non branchée, aucune UI, pas de revue active).

## Hors périmètre

D1-D7. Style. Les six papiers. Les lots ②-⑤ au-delà de leur cohérence avec ①.

## Format

Section 1 : tableau des constats passe 8 → FERMÉ / NON FERMÉ + preuve.
Section 2 : citations exactes ou « aucune ».
Section 3 : scénario ou « aucun ».
Section 4 : constats neufs bloquants, numérotés — ou « aucun ».
Terminer par : « Passe 9 : N constats neufs bloquants ».
