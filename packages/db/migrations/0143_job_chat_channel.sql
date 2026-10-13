-- Le canal du chat qu'un job porte (#649, revue de #657 passes 2 et 3).
--
-- Un `chat_id` ne dit pas à quelle plateforme il appartient. Chaque écrivain
-- le posait à sa façon, et le runner devinait le canal manquant : le premier
-- canal actif de l'agent. Jeton Telegram retiré, Discord actif : la réponse
-- partait sur Discord avec un chat id Telegram. Désormais un chat porte le
-- canal sur lequel il a été RÉSOLU (`designateChat`, packages/db), ou NULL
-- quand rien ne le dit — jamais deviné.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS chat_channel text;
--> statement-breakpoint
-- Les lignes déjà écrites, par la même règle. Une demande VENUE d'un chat :
-- son canal.
UPDATE agent_jobs
  SET chat_channel = channel
  WHERE chat_channel IS NULL
    AND chat_id IS NOT NULL
    AND channel IN ('telegram', 'discord', 'slack', 'whatsapp');
--> statement-breakpoint
-- Une routine ou un webhook au canal de notification déclaré : ce canal.
UPDATE agent_jobs
  SET chat_channel = trigger_context->>'notifyChannel'
  WHERE chat_channel IS NULL
    AND chat_id IS NOT NULL
    AND channel IN ('cron', 'webhook')
    AND trigger_context->>'notifyChannel' IS NOT NULL;
--> statement-breakpoint
-- Une routine en « auto » ou une tâche « Send via Telegram » : Telegram
-- SEULEMENT si le chat est la conversation propriétaire Telegram de l'agent
-- (c'est ce que `resolveOwnerChatId` résolvait). Un chat explicite, que rien
-- ne rattache à une plateforme, reste NULL.
UPDATE agent_jobs j
  SET chat_channel = 'telegram'
  WHERE j.chat_channel IS NULL
    AND j.chat_id IS NOT NULL
    AND j.channel IN ('cron', 'dashboard')
    AND EXISTS (
      SELECT 1 FROM telegram_allowed_chats t
      WHERE t.agent_id = j.agent_id AND t.chat_id = j.chat_id AND t.role = 'owner'
    );
--> statement-breakpoint
-- La relance d'une file (0141) recopie le chat de la tête : avec son canal.
CREATE OR REPLACE FUNCTION agent_jobs_inbox_relaunch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur uuid := NEW.parent_job_id;
  anc agent_jobs%ROWTYPE;
  root agent_jobs%ROWTYPE := NEW;
  depth int := 0;
  left_behind jsonb;
  finished_ids uuid[];
  premier jsonb;
BEGIN
  IF NEW.conversation_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('nodal:conversation-turn:' || NEW.conversation_id::text));

  WHILE cur IS NOT NULL AND depth < 64 LOOP
    SELECT * INTO anc FROM agent_jobs WHERE id = cur;
    EXIT WHEN NOT FOUND;
    IF anc.status IN ('pending', 'processing', 'awaiting_approval', 'awaiting_delegation') THEN
      RETURN NEW;
    END IF;
    root := anc;
    cur := anc.parent_job_id;
    depth := depth + 1;
  END LOOP;

  WITH RECURSIVE finished AS (
    SELECT j.id FROM agent_jobs j
    WHERE j.parent_job_id = NEW.id AND j.status IN ('completed', 'failed', 'cancelled')
    UNION ALL
    SELECT j.id FROM agent_jobs j JOIN finished f ON j.parent_job_id = f.id
    WHERE j.status IN ('completed', 'failed', 'cancelled')
  )
  SELECT COALESCE(array_agg(id), '{}') INTO finished_ids FROM finished;

  SELECT COALESCE(jsonb_agg(x.e ORDER BY j.created_at, x.ord), '[]'::jsonb)
  INTO left_behind
  FROM agent_jobs j, jsonb_array_elements(j.inbox) WITH ORDINALITY AS x(e, ord)
  WHERE j.id = ANY(finished_ids);
  UPDATE agent_jobs SET inbox = '[]'::jsonb
  WHERE id = ANY(finished_ids) AND inbox <> '[]'::jsonb;

  left_behind := NEW.inbox || left_behind;
  NEW.inbox := '[]'::jsonb;
  IF jsonb_array_length(left_behind) = 0 THEN
    RETURN NEW;
  END IF;

  premier := left_behind -> 0;
  INSERT INTO agent_jobs (
    entity_id, agent_id, channel, chat_id, chat_channel, conversation_id, project_id,
    status, task, messages, inbox, relaunched_from_job_id
  ) VALUES (
    root.entity_id, root.agent_id, root.channel, root.chat_id, root.chat_channel, NEW.conversation_id,
    (SELECT c.current_project_id FROM conversations c WHERE c.id = NEW.conversation_id),
    'pending',
    premier ->> 'task',
    jsonb_build_array(jsonb_build_object('role', 'user', 'content', premier -> 'content')),
    left_behind - 0,
    root.id
  );
  RETURN NEW;
END;
$$;
