-- 0098 — une demande d'approbation peut être une QUESTION (P10a, plan « De la
-- maquette au produit »).
--
-- POURQUOI `kind` EST STOCKÉ, et pas déduit du nom de l'outil. Trois lecteurs
-- ont besoin de savoir si cette ligne se résout par « approuver / refuser » ou
-- par « choisir une option » : la page Approvals et le fil (web), la reprise
-- (runner), et le tap sur un bouton (Telegram). Aucun des trois n'a le registre
-- d'outils sous la main, et le déduire d'un `tool_name = 'ask_user'` ferait
-- exactement ce que l'invariant #1 interdit — une métadonnée d'agent codée en
-- dur dans trois écrans. La porte la POSE à la création, depuis ce que l'outil
-- déclare (`ToolDefinition.asksUser`), et plus personne ne devine.
--
-- La valeur par défaut fait de TOUTE ligne existante une `approval` : aucune
-- requalification, et le comportement des approbations d'aujourd'hui est
-- inchangé, y compris pour un runner qui n'aurait pas encore été redéployé.
--
-- POURQUOI `answer` EST UN LIBELLÉ ET PAS UN INDEX. La réponse est relue par le
-- transcript (l'agent voit « Write to the repo », pas « 1 ») et par l'écran, des
-- mois après, quand la liste d'options de ce jour-là n'existe plus qu'ici, dans
-- `tool_input`. Un index serait un pointeur vers une liste dont rien ne garantit
-- la stabilité ; le libellé se lit seul. La validation « ce libellé EST une des
-- options » est faite à la résolution, avant l'écriture.
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'approval';
--> statement-breakpoint
-- DROP puis ADD, jamais ALTER : une contrainte CHECK ne se modifie pas en
-- place. `IF EXISTS` rend la migration rejouable.
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_kind_check;
--> statement-breakpoint
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_kind_check
  CHECK (kind IN ('approval', 'question'));
--> statement-breakpoint
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS answer text;
