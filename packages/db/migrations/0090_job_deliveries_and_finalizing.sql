-- 0090 — l'outbox de la livraison : job_deliveries, et le marqueur de
-- finalisation en cours sur agent_jobs (plan « Vérifier & Corriger »).
--
-- Envoyer un message à un canal (Telegram, Discord, Slack, WhatsApp) est une
-- action SORTANTE : une fois partie, un renvoi produit un doublon visible pour
-- le destinataire — l'inverse d'une écriture DB qu'on peut rejouer sans
-- conséquence. Jusqu'ici le job-loop appelait l'adaptateur d'envoi en ligne,
-- au milieu de sa propre transaction de finalisation : un crash entre l'envoi
-- et le commit perdait la trace de ce qui avait ou non été livré, et un rejeu
-- pouvait renvoyer le même message une seconde fois.
--
-- `job_deliveries` sépare les deux gestes : la finalisation du job (T09) pose
-- une ligne `prepared` DANS la même transaction que son propre commit — poser
-- l'intention de livrer est un simple INSERT, rejouable sans effet de bord.
-- Un module séparé (`drainDeliveries`, hors transaction) réclame les lignes
-- ouvertes et parle réellement à l'adaptateur, avec ses propres tentatives et
-- son propre budget — jamais retenu par un verrou de transaction pendant
-- l'appel réseau.
--
-- `channel` est le canal de TRANSPORT réellement résolu au moment de la
-- préparation (resolveTransportChannel + override notifyChannel), jamais
-- `agent_jobs.channel` qui est une ORIGINE (cron, webhook, dashboard, mcp…) —
-- d'où la liste plus courte : seuls les quatre canaux qui savent RECEVOIR un
-- message existent ici.
--
-- `payload` est le texte figé à envoyer, écrit une fois à la préparation —
-- jamais relu depuis `agent_jobs.result` au moment du drain.
--
-- `idempotency_key` UNIQUE est la garde contre la double préparation de la
-- même livraison logique : une seconde tentative de préparation sur la même
-- clé se heurte à la contrainte, l'erreur remonte, rien n'est avalé.
--
-- `finalizing_at` sur `agent_jobs` couvre la fenêtre de course symétrique côté
-- cron (deliver-results) : deux tours concurrents du tick ne doivent pas tous
-- les deux entreprendre de finaliser le même job root. Posé au claim, effacé
-- à la fin (succès ou échec) — NULL en dehors d'une fenêtre de finalisation.
CREATE TABLE IF NOT EXISTS job_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('telegram','discord','slack','whatsapp')),
  chat_id text NOT NULL,
  payload text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('prepared','attempted','confirmed','rejected')),
  idempotency_key text NOT NULL UNIQUE,
  receipt jsonb,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts <= 3),
  -- Ecrits par le runner en JS au moment du claim reel — jamais DEFAULT now(),
  -- l'horodatage doit etre celui de la tentative, pas de l'insertion.
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Sert exactement la requete du drain (lignes encore ouvertes) sans balayer
-- les lignes deja confirmed/rejected, qui dominent numeriquement en regime.
CREATE INDEX IF NOT EXISTS idx_job_deliveries_open
  ON job_deliveries (outcome, claimed_at) WHERE outcome IN ('prepared','attempted');
--> statement-breakpoint
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS finalizing_at timestamptz;
