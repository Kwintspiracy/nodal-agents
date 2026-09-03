# Demande de review — PLAN « Vérifier & Corriger » v6.1, passe 8

Objet : `docs/plans/verifier-corriger.md`, v6.1 du 03/09/2026. La passe 7
(rapport : `docs/validation/rapport-review-plan-verifier-corriger-v6-passe7.md`)
a rendu 11 verdicts : Q8 TIENT, les dix autres TROU ou FAUX, 8 bloquants pour
PR①. Chaque constat a été vérifié à la source puis traité dans la v6.1 ; la
table « Traçabilité passe 7 → v6.1 » du plan dit où.

Sandbox : lecture seule. Branche `feat/recettes-agents` ; ancrages visant
`main`.

## Ce qui est demandé

1. **Pour chaque constat Q1-Q11 de la passe 7** : le traitement v6.1 le
   ferme-t-il ? Verdict FERMÉ / PARTIEL / NON FERMÉ, avec la phrase du plan
   qui ferme (ou ce qui manque). Ne pas re-lister un constat fermé : dire
   FERMÉ et passer.
2. **Cohérence résiduelle** : la v6.1 a généralisé l'identité à
   `(job_id, deliverable_type, canonical_key)` et ajouté un modèle d'état
   atomique. Reste-t-il dans le texte v4 conservé (modèle central, protocole
   transactionnel, primitive terminale, PR①-④) des phrases qui contredisent
   la v6.1 — par exemple un verrou, une colonne ou un test nommé qui suppose
   encore `(job, projet)` sans que la note de lecture en tête de la table
   d'état suffise ? Citer la phrase exacte.
3. **Le flux unique de revue (v6-C)** : la revue devient une étape de la
   primitive terminale (`review_pending` → `requestReview` → agrégation).
   Est-ce compatible avec l'union de retour typée de la v4
   (`completed | completed_unverified | already_terminal | verification_due |
   verification_persistence_failed`) ? Faut-il un membre `review_pending`
   dans l'union, et le plan le dit-il ? Le cron `deliver-results` (qui
   finalise des roots de fan-out) passe-t-il par ce flux sans deadlock
   (un root dont la revue est pending n'est pas livré) ?
4. **Le modèle atomique** : la machine d'état `prepared → attempted →
   confirmed | rejected | outcome_unknown` avec clé d'idempotence — le plan
   dit-il QUI écrit `attempted` (le tool, avant l'appel réseau ?) et QUI
   écrit `confirmed` (le constat, après) ? Un runner qui tombe entre
   `attempted` et `confirmed` : le plan dit-il que le reaper laisse
   `attempted` (⇒ `outcome_unknown` à la finalisation) et ne rejoue jamais ?
5. **Nouveaux constats** uniquement s'ils bloqueraient le découpage de PR①.
   PR① = fondations `code_project` seul, garde non branchée, aucune UI.

## Hors périmètre

D1-D7 (tranchées). Style. Les six papiers. Les lots ②-⑤ au-delà de leur
cohérence avec ①.

## Format

Section 1 : tableau Q1-Q11 → FERMÉ / PARTIEL / NON FERMÉ + preuve.
Sections 2-4 : constats avec citation exacte du plan.
Section 5 : constats neufs bloquants pour PR①, numérotés — ou « aucun ».
Terminer par une ligne : « Passe 8 : N constats neufs bloquants ».
