-- 0163 — `device` devient un canal de Nodal (#945).
--
-- Un module externe (un compagnon de bureau, une enceinte, un petit appareil,
-- un logiciel) se branche sur Nodal comme Telegram ou Discord : une demande
-- faite sur lui est un tour de SA conversation, et les questions, approbations
-- et aperçus de cette demande lui reviennent. Le précédent est 0080 (`mcp`).
--
-- Un appareil appartient à un ESPACE (entité), pas à un agent : il n'a pas de
-- liaison par agent (`channel_bindings`), ni de liste de conversations
-- autorisées (`channel_allowed_conversations`). Sa ligne dans `devices` EST son
-- autorisation. Les jetons d'appareil (#946) s'ajouteront à cette table, sans
-- rien changer de sa forme : rien ici ne les suppose.
--
-- Les contraintes qui listent des canaux, et ce que chacune fait de `device` :
--   agent_jobs.channel                       ACCEPTE  — un job lancé depuis un appareil
--   conversations.channel                    ACCEPTE  — la conversation d'un appareil
--   approval_card_messages.channel           ACCEPTE  — la carte posée sur un appareil,
--                                                       fermée quand la demande est tranchée
--   job_deliveries.channel                   EXCLU    — l'appareil lit le résultat d'un job
--                                                       sur son flux, pas par la boîte d'envoi
--   channel_bindings.channel                 EXCLU    — un appareil est à l'espace, pas à un agent
--   channel_allowed_conversations.channel    EXCLU    — sa ligne `devices` est son autorisation
--   agent_schedules.notify_channel           EXCLU    — aucune routine ne choisit encore un appareil
--   webhook_triggers.notify_channel          EXCLU    — idem

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  -- Le nom que le propriétaire lui donne.
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- Ce que l'appareil DÉCLARE savoir faire. Une déclaration, pas une
  -- vérification : elle dit ce qu'il est utile de lui envoyer.
  capabilities text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (capabilities <@ ARRAY['microphone','speaker','screen','buttons']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- La dernière requête passée par la garde des appareils. NULL : jamais vu.
  last_seen_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_devices_entity ON devices (entity_id, created_at);
--> statement-breakpoint
ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_channel_check;
--> statement-breakpoint
ALTER TABLE agent_jobs
  ADD CONSTRAINT agent_jobs_channel_check
  CHECK (channel IN ('telegram','api','whatsapp','internal','cron','task-board','slack','discord','dashboard','webhook','mcp','device'));
--> statement-breakpoint
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
--> statement-breakpoint
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('dashboard','telegram','slack','discord','whatsapp','device'));
--> statement-breakpoint
ALTER TABLE approval_card_messages DROP CONSTRAINT IF EXISTS approval_card_messages_channel_check;
--> statement-breakpoint
ALTER TABLE approval_card_messages
  ADD CONSTRAINT approval_card_messages_channel_check
  CHECK (channel IN ('telegram','discord','slack','whatsapp','device'));
