-- La NOTE de qui a remis une demande, à côté des mots de la personne (handoff.ts,
-- @nodal-agents/shared).
--
-- Le 18/10, le front du chat a remis la correction du propriétaire à son agent
-- racine en y ajoutant ses propres consignes, écrites comme si c'était la
-- demande. `agent_jobs.task` portait le texte du front, et `original_task`,
-- censée garder la demande d'origine, n'avait jamais été écrite par aucun code
-- depuis 0000 : NULL partout, lue par personne.
--
-- Désormais, pour un tour de conversation, `task` EST la demande dans les mots
-- de la personne, prise par la plateforme ; ce que le modèle qui la remet écrit
-- à côté va dans `handoff_note`, sa note, que le travailleur lit sous un cadre
-- qui dit qu'elle n'est pas de la personne. Un seul champ par sens : la colonne
-- morte part.
ALTER TABLE agent_jobs DROP COLUMN IF EXISTS original_task;
--> statement-breakpoint
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS handoff_note text;
--> statement-breakpoint
-- Les remises du chat déjà faites : leur `task` est le texte que le front a
-- écrit (l'instruction de son `run_task`). Il devient aussi leur note, ce que
-- le chat rejoue comme l'appel d'outil du front (run-chat-turn.ts). Leur
-- `task` ne change pas : les mots de la personne d'alors ne sont pas
-- reconstructibles, et l'écran des runs montre ce qui a été lancé.
UPDATE agent_jobs j
  SET handoff_note = j.task
  WHERE j.handoff_note IS NULL
    AND EXISTS (SELECT 1 FROM chat_messages m WHERE m.job_id = j.id AND m.role = 'assistant');
--> statement-breakpoint
-- La relance d'une file (0141, 0143) : la nouvelle tête porte les MOTS de
-- l'entrée en tâche et la note de qui les a transmis en `handoff_note`. Ses
-- messages restent vides : la boucle les ouvre par la même fonction que tout
-- job (`openingMessages`), la tâche seule dans son message, puis la note sous
-- son cadre — une seule forme, écrite en un seul endroit.
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
    status, task, handoff_note, messages, inbox, relaunched_from_job_id
  ) VALUES (
    root.entity_id, root.agent_id, root.channel, root.chat_id, root.chat_channel, NEW.conversation_id,
    (SELECT c.current_project_id FROM conversations c WHERE c.id = NEW.conversation_id),
    'pending',
    premier ->> 'task',
    premier ->> 'note',
    '[]'::jsonb,
    left_behind - 0,
    root.id
  );
  RETURN NEW;
END;
$$;
