-- Une demande DITE au lieu d'être tapée (#941) : le tour vocal du runner.
--
-- chat_messages.spoken_ms — la personne a dit ce message : `content` est la
-- transcription, et ceci la durée de ce qu'elle a dit, en millisecondes. Le
-- fil en tire « Spoken · 0:03 ». NULL : un message tapé, soit toute ligne
-- déjà écrite.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS spoken_ms integer;
--> statement-breakpoint
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_spoken_ms_check;
--> statement-breakpoint
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_spoken_ms_check
  CHECK (spoken_ms IS NULL OR (spoken_ms > 0 AND role = 'user'));
--> statement-breakpoint
-- agent_jobs.reply_rendering — comment la personne recevra la réponse du job :
-- `text`, lue, comme tout job jusqu'ici (d'où le défaut) ; `spoken`, entendue,
-- pour le job qu'un tour vocal lance par `run_task`. Le prompt du job le dit à
-- l'agent ; ses mots restent les siens (invariant #2).
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS reply_rendering text NOT NULL DEFAULT 'text';
--> statement-breakpoint
ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_reply_rendering_check;
--> statement-breakpoint
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_reply_rendering_check
  CHECK (reply_rendering IN ('text', 'spoken'));
--> statement-breakpoint
-- La relance d'une file (0141, 0143, 0151) est la suite du MÊME travail : la
-- nouvelle tête reçoit sa réponse comme la recevait la racine. Sans cette
-- ligne, la suite d'un travail lancé à la voix rendrait une réponse écrite
-- pour être lue. Corps de 0151, plus `reply_rendering`.
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
    status, task, handoff_note, reply_rendering, messages, inbox, relaunched_from_job_id
  ) VALUES (
    root.entity_id, root.agent_id, root.channel, root.chat_id, root.chat_channel, NEW.conversation_id,
    (SELECT c.current_project_id FROM conversations c WHERE c.id = NEW.conversation_id),
    'pending',
    premier ->> 'task',
    premier ->> 'note',
    root.reply_rendering,
    '[]'::jsonb,
    left_behind - 0,
    root.id
  );
  RETURN NEW;
END;
$$;
