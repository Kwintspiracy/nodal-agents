-- Le droit d'agir d'un run sur son job (#566). 0134 est réservée (#444).
--
-- Le 28/09/2026, un job déclaré mort par le faucheur a continué d'envoyer des
-- messages pendant huit minutes : sa boucle ne relisait pas sa ligne entre
-- deux appels d'outil. Relire le STATUT ne suffit pas : un job repris par le
-- faucheur (`pending`) puis repris par un autre run redevient `processing`,
-- et l'ancien run l'y verrait encore à lui.
--
--   claim_generation  le numéro de la prise en cours. `claimJob` le monte à
--                     chaque passage `pending → processing` ; le run garde le
--                     sien et le relit, avec le statut, avant chaque effet.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS claim_generation integer NOT NULL DEFAULT 0;
