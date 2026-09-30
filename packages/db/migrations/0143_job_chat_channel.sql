-- Le canal du chat que le déclencheur a désigné (#649, revue passe 2 de #657).
--
-- Un `chat_id` ne dit pas à quelle plateforme il appartient. Quand la demande
-- ne vient pas d'un chat (une routine qui veut sa confirmation, un webhook,
-- « Send via Telegram » du dashboard), le runner devinait le canal : le premier
-- canal actif de l'agent. Jeton Telegram retiré, Discord actif : la réponse
-- partait sur Discord avec un chat id Telegram. Le canal est désormais posé là
-- où le chat est désigné, et lu tel quel.
ALTER TABLE agent_jobs
  ADD COLUMN IF NOT EXISTS chat_channel text;
--> statement-breakpoint
-- Les lignes déjà écrites, d'après ce que leur déclencheur a résolu, jamais
-- deviné : une routine ou un webhook au canal de notification enregistré ;
-- une routine en « auto » et une tâche « Send via Telegram » ont résolu leur
-- chat par `resolveOwnerChatId`, qui ne connaît que Telegram. Une ligne `api`
-- porteuse d'un chat reste NULL : rien ne dit sa plateforme.
UPDATE agent_jobs
  SET chat_channel = trigger_context->>'notifyChannel'
  WHERE chat_channel IS NULL
    AND chat_id IS NOT NULL
    AND channel IN ('cron', 'webhook')
    AND trigger_context->>'notifyChannel' IS NOT NULL;
--> statement-breakpoint
UPDATE agent_jobs
  SET chat_channel = 'telegram'
  WHERE chat_channel IS NULL
    AND chat_id IS NOT NULL
    AND channel IN ('cron', 'dashboard');
