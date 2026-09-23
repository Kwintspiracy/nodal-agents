-- UNE RÉPONSE ARRÊTÉE EST UN FAIT, PAS UNE PHRASE (#456).
--
-- Le bouton Stop du chat coupe une réponse en cours d'écriture ; ce qui avait
-- été écrit est gardé. La première version écrivait `[stopped by the user]` à
-- la fin du texte — une phrase du runner montrée telle quelle, contraire à
-- l'invariant #2 (revue Codex de #459). Le runner pose désormais ce FAIT, et
-- c'est l'écran qui le dit avec ses propres mots.
--
-- Faux par défaut : toutes les réponses d'avant ont été rendues entières.
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "stopped" boolean NOT NULL DEFAULT false;
