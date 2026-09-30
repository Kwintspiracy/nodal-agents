-- Un message arrivé pendant que le travail de sa conversation tourne (#531).
--
-- Sur Telegram, Discord, Slack et WhatsApp, chaque message insérait un nouveau
-- job de tête : une précision envoyée pendant que la première demande tournait
-- (« et mets-le dans le dossier partagé ») relançait tout le travail une
-- seconde fois. Désormais, tant qu'une tête de la conversation n'est pas
-- terminale, le message entre dans SA file, et la boucle la vide en haut de
-- chaque tour.
--
-- La file est une colonne de la tête : c'est la ligne que la transition
-- terminale verrouille, donc la remise d'un message et la fin du job se
-- sérialisent sur elle — un message ne peut pas tomber entre les deux.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS inbox jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- CE QUI RESTE EN FILE QUAND LA TÊTE FINIT devient une nouvelle tête de la
-- même conversation : la première entrée en est la tâche, les suivantes sa
-- file (vidée à son premier tour). Aucune perte, par construction : le
-- déclencheur est posé sur la transition elle-même, pas sur l'un des chemins
-- qui l'écrivent — la boucle Nodal et ses dizaines de sorties, un tour de CLI
-- (qui n'a pas de frontière de tour, et dont la file n'est donc lue qu'ici),
-- les faucheurs, l'expiration d'une approbation. La seule écriture qui
-- vide la file SANS la relancer est l'arrêt demandé par la personne
-- (`cancelJobTree`) : elle vide la colonne dans la même instruction que le
-- statut, et rend ce qu'elle a retiré.
CREATE OR REPLACE FUNCTION agent_jobs_inbox_relaunch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  premier jsonb := NEW.inbox -> 0;
BEGIN
  INSERT INTO agent_jobs (
    entity_id, agent_id, channel, chat_id, conversation_id, project_id,
    status, task, messages, inbox
  ) VALUES (
    NEW.entity_id, NEW.agent_id, NEW.channel, NEW.chat_id, NEW.conversation_id,
    (SELECT c.current_project_id FROM conversations c WHERE c.id = NEW.conversation_id),
    'pending',
    premier ->> 'task',
    jsonb_build_array(jsonb_build_object('role', 'user', 'content', premier -> 'content')),
    NEW.inbox - 0
  );
  NEW.inbox := '[]'::jsonb;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_jobs_inbox_relaunch ON agent_jobs;
--> statement-breakpoint
CREATE TRIGGER agent_jobs_inbox_relaunch
  BEFORE UPDATE ON agent_jobs
  FOR EACH ROW
  WHEN (NEW.status IN ('completed', 'failed', 'cancelled') AND NEW.inbox <> '[]'::jsonb)
  EXECUTE FUNCTION agent_jobs_inbox_relaunch();
