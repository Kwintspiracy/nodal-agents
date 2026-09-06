-- 0094 — `conversations` devient la table de TOUTES les conversations, tous
-- canaux (plan « De la maquette au produit », P6).
--
-- Jusqu'ici, une conversation de canal (Telegram, Slack, Discord, WhatsApp)
-- n'avait AUCUNE ligne : son identité était un uuid frappé à la volée par
-- `resolveConversationId`, posé sur `agent_jobs.conversation_id`, et recalculé
-- à chaque message par une règle de SILENCE (4 h sans réponse = nouvelle
-- conversation). Cette règle décidait l'identité du fil, ce qui donnait deux
-- comportements que personne n'a demandés : répondre le lendemain à un agent
-- ouvrait une conversation neuve sans que l'utilisateur ait rien fait, et une
-- conversation ne pouvait porter aucun état durable, faute de ligne où l'écrire.
--
-- P6 pose l'autre règle : une conversation par fil (un chat de canal, une
-- conversation du dashboard), qui dure JUSQU'À CE QUE L'UTILISATEUR EN OUVRE
-- UNE AUTRE — le « + » du dashboard, ou la commande `/new` dans un canal. Le
-- silence reste un budget de RELECTURE (ce qu'on redonne au modèle), plus une
-- identité. Et parce qu'il y a désormais une ligne, la conversation peut porter
-- son PROJET COURANT (`current_project_id`), redit au modèle à chaque tour.
--
-- PAS DE CLÉ ÉTRANGÈRE `agent_jobs.conversation_id → conversations`. Mesuré sur
-- la base dev le 06/09 : 95 jobs portent un uuid qu'aucune ligne ne porte plus
-- — surtout des jobs du dashboard dont l'utilisateur a supprimé la conversation
-- (CASCADE sur chat_messages, jamais sur les jobs) et leurs enfants. Une FK les
-- ramènerait à NULL et la page Runs perdrait leur regroupement, c'est-à-dire
-- l'unique chose que cette colonne servait à faire. L'identité vaut pour
-- l'avenir : tout job créé après P6 référence une ligne, un ancien uuid reste
-- tel quel.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'dashboard';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_check') THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('dashboard','telegram','slack','discord','whatsapp'));
  END IF;
END;
$$;
--> statement-breakpoint
-- L'identifiant du fil SUR le canal (chat Telegram, canal Slack, ...). NULL
-- pour le dashboard, dont le fil n'a pas d'existence hors de cette table.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS chat_id text;
--> statement-breakpoint
-- Le projet courant de la conversation : posé quand une production atterrit
-- dans un projet enregistré (P5), TOUJOURS écrasé — la dernière production
-- décide. SET NULL : désinscrire un projet ne doit pas emporter la
-- conversation, seulement lui retirer son ancrage.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS current_project_id uuid REFERENCES code_projects(id) ON DELETE SET NULL;
--> statement-breakpoint
-- LA requête du runner à chaque message entrant : la ligne la plus récente du
-- tuple (entité, agent, canal, chat).
CREATE INDEX IF NOT EXISTS idx_conversations_thread
  ON conversations(entity_id, agent_id, channel, chat_id, created_at DESC);
--> statement-breakpoint
-- BACKFILL — une ligne par conversation de canal existante. L'identité d'HIER
-- est conservée telle quelle : les segments qu'un silence de 4 h avait découpés
-- restent des conversations distinctes (les réunir réécrirait un historique que
-- l'utilisateur a vécu comme séparé). À partir de maintenant, une par chat.
-- Le titre est la première ligne de la première tâche, tronquée à 60 — la même
-- règle que le chat du dashboard.
INSERT INTO conversations (id, entity_id, agent_id, title, origin, channel, chat_id, created_at, updated_at)
SELECT j.conversation_id, j.entity_id, j.agent_id,
       left(split_part((array_agg(j.task ORDER BY j.created_at))[1], E'\n', 1), 60),
       'user', j.channel, j.chat_id, min(j.created_at), max(coalesce(j.completed_at, j.created_at))
FROM agent_jobs j
WHERE j.conversation_id IS NOT NULL AND j.parent_job_id IS NULL
  AND j.entity_id IS NOT NULL AND j.agent_id IS NOT NULL
  AND j.channel IN ('telegram','slack','discord','whatsapp')
GROUP BY j.conversation_id, j.entity_id, j.agent_id, j.channel, j.chat_id
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- La relecture d'un fil (thread-history.ts) interroge désormais par
-- conversation, plus par (entité, agent, canal, chat).
CREATE INDEX IF NOT EXISTS idx_agent_jobs_conversation
  ON agent_jobs(conversation_id) WHERE conversation_id IS NOT NULL;
