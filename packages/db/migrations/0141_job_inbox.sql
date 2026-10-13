-- Un message arrivé pendant que le travail de sa conversation tourne (#531).
--
-- Sur Telegram, Discord, Slack et WhatsApp, chaque message insérait un job de
-- tête qui ne savait rien du travail en cours : une précision (« et mets-le
-- dans le dossier partagé ») relançait tout le travail une seconde fois.
-- Désormais un tel message démarre un TOUR DE RÉPONSE (`answers_while_job_id`)
-- qui voit ce qui tourne et décide : répondre, transmettre au travail en cours
-- (sa file, `inbox`), l'arrêter, ou lancer autre chose.
--
-- La file est une colonne du job visé : c'est la ligne que la transition
-- terminale verrouille, donc la remise d'un message et la fin du job se
-- sérialisent sur elle — un message ne peut pas tomber entre les deux.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS inbox jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- La tête dont la file a fait naître celle-ci (déclencheur ci-dessous) : c'est
-- la SUITE du même travail. L'arrêt (`cancelJobTree`) descend par ce lien
-- comme par `parent_job_id` — un Stop qui croise la fin de la tête arrête
-- aussi ce qu'elle vient de relancer (revue de #642, passe 1). Sans clé
-- étrangère, comme `conversation_id` : l'élagage des vieux jobs ne doit rien
-- réécrire.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS relaunched_from_job_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_jobs_relaunched_from
  ON agent_jobs (relaunched_from_job_id)
  WHERE relaunched_from_job_id IS NOT NULL;
--> statement-breakpoint
-- Le travail pendant lequel ce job a été lancé : un TOUR DE RÉPONSE, né d'un
-- message arrivé pendant que cette tête vivait. Il voit ce qui tourne (bloc
-- « Work running in this conversation ») et répond toujours. NULL pour une
-- tête née dans une conversation au repos.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS answers_while_job_id uuid;
--> statement-breakpoint
-- AUCUNE FILE NE RESTE SUR UN JOB TERMINAL (revue de #642, passe 2). À la
-- transition terminale de N'IMPORTE QUEL job d'une conversation :
--   - s'il a un ancêtre VIVANT, cet ancêtre lira ce qui reste — la file de ce
--     job et celle de ses descendants finis — à son prochain pas et avant de
--     conclure (`drainJobInbox` descend dans les descendants finis) : rien à
--     faire ici, et aucune ligne d'un autre job n'est écrite (un parent écrit
--     depuis l'enfant prendrait les verrous dans l'ordre inverse de l'arrêt) ;
--   - sinon, ce qui reste — sa file et celle de ses descendants finis — devient
--     une NOUVELLE tête de la conversation, au nom de la tête du run (même
--     agent, même canal, même fil) : la première entrée en est la tâche, les
--     suivantes sa file. `relaunched_from_job_id` la rattache à cette tête, et
--     l'arrêt descend par ce lien.
-- Aucune perte, par construction : le déclencheur est posé sur la transition
-- elle-même, pas sur l'un des chemins qui l'écrivent — la boucle Nodal et ses
-- dizaines de sorties, un tour de CLI (qui n'a pas de frontière de tour), les
-- faucheurs, l'expiration d'une approbation.
--
-- Le verrou consultatif de la conversation (celui de `startConversationTurn`)
-- sérialise les fins d'un même fil entre elles et avec la décision : un
-- délégué qui finit pendant que son ancêtre finit ne peut pas voir l'ancêtre
-- vivant pendant que l'ancêtre, lui, ne le voit pas encore fini. Il est pris
-- APRÈS le verrou de ligne de l'écriture terminale ; personne ne tient ce
-- verrou consultatif en attendant une ligne de job, donc aucun interblocage.
--
-- La seule écriture qui vide des files SANS les relancer est l'arrêt demandé
-- par la personne (`cancelJobTree`) : il les vide avant de poser les statuts,
-- et rend ce qu'il a retiré.
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
    entity_id, agent_id, channel, chat_id, conversation_id, project_id,
    status, task, messages, inbox, relaunched_from_job_id
  ) VALUES (
    root.entity_id, root.agent_id, root.channel, root.chat_id, NEW.conversation_id,
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
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_jobs_inbox_relaunch ON agent_jobs;
--> statement-breakpoint
CREATE TRIGGER agent_jobs_inbox_relaunch
  BEFORE UPDATE ON agent_jobs
  FOR EACH ROW
  WHEN (
    NEW.status IN ('completed', 'failed', 'cancelled')
    AND (OLD.status IS NULL OR OLD.status NOT IN ('completed', 'failed', 'cancelled'))
  )
  EXECUTE FUNCTION agent_jobs_inbox_relaunch();
